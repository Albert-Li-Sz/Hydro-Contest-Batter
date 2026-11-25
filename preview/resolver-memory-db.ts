import type { Context } from 'hydrooj';

/** Preview/test storage only. Production always uses Hydro's MongoDB service. */
export function previewDatabase() {
    const tables = new Map<string, Map<string, Record<string, any>>>();
    const field = (row: Record<string, any>, key: string): any => key.split('.').reduce((value, part) => value?.[part], row);
    const changeField = (row: Record<string, any>, key: string, value: unknown, remove = false) => {
        const parts = key.split('.');
        const last = parts.pop()!;
        const parent = parts.reduce((item, part) => (item[part] ||= {}), row);
        if (remove) delete parent[last];
        else parent[last] = structuredClone(value);
    };
    const updateRow = (row: Record<string, any>, update: Record<string, any>) => {
        for (const [key, value] of Object.entries(update.$set || {})) changeField(row, key, value);
        for (const [key, value] of Object.entries(update.$inc || {})) changeField(row, key, (field(row, key) ?? 0) + (value as number));
        for (const key of Object.keys(update.$unset || {})) changeField(row, key, undefined, true);
        for (const [key, value] of Object.entries(update.$addToSet || {})) {
            changeField(row, key, [...new Set([...(field(row, key) || []), value])]);
        }
    };
    const comparable = (value: unknown) => (value instanceof Date ? value.getTime() : value as any);
    const operators: Record<string, (actual: any, expected: any) => boolean> = {
        $exists: (actual, expected) => (actual !== undefined) === expected,
        $lt: (actual, expected) => actual !== undefined && comparable(actual) < comparable(expected),
        $lte: (actual, expected) => actual !== undefined && comparable(actual) <= comparable(expected),
        $gt: (actual, expected) => actual !== undefined && comparable(actual) > comparable(expected),
        $gte: (actual, expected) => actual !== undefined && comparable(actual) >= comparable(expected),
        $in: (actual, expected: unknown[]) => expected.some((item) => comparable(item) === comparable(actual)),
        $ne: (actual, expected) => comparable(actual) !== comparable(expected),
    };
    const matches = (row: Record<string, any>, filter: Record<string, any>): boolean =>
        Object.entries(filter).every(([key, value]) => {
            if (key === '$or') return (value as Record<string, any>[]).some((part) => matches(row, part));
            const actual = field(row, key);
            if (value instanceof Date) return actual instanceof Date && actual.getTime() === value.getTime();
            if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every((name) => name in operators)) {
                return Object.entries(value).every(([name, expected]) => operators[name](actual, expected));
            }
            return Array.isArray(actual) ? actual.includes(value) : actual === value;
        });
    const db = {
        collection(name: string) {
            if (!tables.has(name)) tables.set(name, new Map());
            const table = tables.get(name)!;
            return {
                async createIndex() { return 'preview'; },
                async insertOne(row: Record<string, any>) {
                    if (table.has(row._id)) throw Object.assign(new Error('Duplicate key'), { code: 11000 });
                    table.set(row._id, structuredClone(row));
                    return { insertedId: row._id };
                },
                async insertMany(rows: Record<string, any>[]) {
                    for (const row of rows) {
                        if (table.has(row._id)) throw Object.assign(new Error('Duplicate key'), { code: 11000 });
                        table.set(row._id, structuredClone(row));
                    }
                    return { insertedCount: rows.length };
                },
                async countDocuments(filter: Record<string, any> = {}) {
                    return [...table.values()].filter((item) => matches(item, filter)).length;
                },
                async findOne(filter: Record<string, any>) {
                    const row = [...table.values()].find((item) => matches(item, filter));
                    return row ? structuredClone(row) : null;
                },
                find(filter: Record<string, any> = {}) {
                    let rows = [...table.values()].filter((item) => matches(item, filter)).map((row) => structuredClone(row));
                    return {
                        sort(order: Record<string, number>) {
                            const [key, direction] = Object.entries(order)[0];
                            rows.sort((a, b) => (field(a, key) < field(b, key) ? -1 : field(a, key) > field(b, key) ? 1 : 0) * direction);
                            return this;
                        },
                        limit(count: number) { rows = rows.slice(0, count); return this; },
                        project() { return this; },
                        async toArray() { return rows; },
                    };
                },
                async updateOne(filter: Record<string, any>, update: Record<string, any>, options: { upsert?: boolean } = {}) {
                    const row = [...table.values()].find((item) => matches(item, filter));
                    if (!row && options.upsert) {
                        const inserted = structuredClone({ ...filter, ...update.$setOnInsert });
                        updateRow(inserted, update);
                        table.set(inserted._id, inserted);
                        return { matchedCount: 0, upsertedCount: 1 };
                    }
                    if (!row) return { matchedCount: 0 };
                    updateRow(row, update);
                    return { matchedCount: 1 };
                },
                async findOneAndUpdate(filter: Record<string, any>, update: Record<string, any>, options: { returnDocument?: string; upsert?: boolean } = {}) {
                    let row = [...table.values()].find((item) => matches(item, filter));
                    if (!row && options.upsert) {
                        row = structuredClone({ ...filter, ...update.$setOnInsert }) as Record<string, any>;
                        table.set(row._id, row);
                        updateRow(row, update);
                        return options.returnDocument === 'after' ? structuredClone(row) : null;
                    }
                    if (!row) return null;
                    const before = structuredClone(row);
                    updateRow(row, update);
                    return options.returnDocument === 'after' ? structuredClone(row) : before;
                },
                async deleteOne(filter: Record<string, any>) {
                    const row = [...table.values()].find((item) => matches(item, filter));
                    if (row) table.delete(row._id);
                },
                async deleteMany(filter: Record<string, any>) {
                    for (const row of table.values()) if (matches(row, filter)) table.delete(row._id);
                },
            };
        },
    };
    return { db: db as unknown as Context['db'], tables };
}
