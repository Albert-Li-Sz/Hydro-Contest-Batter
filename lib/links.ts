/**
 * The contest's links that work without a Hydro login: screens, the live overlay, the balloon desk
 * and the capture devices. Each feature registers how many it has issued and how to replace them,
 * so that the cleanup after a contest can revoke all of them in one place (/manage/xcpcio-users).
 */
export interface LinkTdoc {
    domainId: string;
    docId: unknown;
}

export interface LinkSource<T extends LinkTdoc = LinkTdoc> {
    id: string;
    label: string;
    /** Links currently valid (0: never issued), and when the newest was issued if known. */
    status: (tdoc: T) => Promise<{ count: number; issuedAt: Date | null }>;
    /** Issues new secrets in place of the current ones; pages open with the old ones stop. */
    revoke: (tdoc: T) => Promise<number>;
}

export interface LinkStatus {
    id: string;
    label: string;
    count: number;
    issuedAt: Date | null;
}

export class ContestLinks<T extends LinkTdoc = LinkTdoc> {
    private sources: LinkSource<T>[] = [];

    add(source: LinkSource<T>) {
        this.sources = [...this.sources.filter((existing) => existing.id !== source.id), source];
    }

    get size() { return this.sources.length; }

    async status(tdoc: T): Promise<LinkStatus[]> {
        return Promise.all(this.sources.map(async (source) => {
            const { count, issuedAt } = await source.status(tdoc).catch(() => ({ count: 0, issuedAt: null }));
            return { id: source.id, label: source.label, count, issuedAt };
        }));
    }

    /** Revokes the given kinds (all by default); one failing kind does not stop the others. */
    async revoke(tdoc: T, ids?: string[]) {
        const chosen = ids ? this.sources.filter((source) => ids.includes(source.id)) : this.sources;
        return Promise.all(chosen.map(async (source) => {
            try {
                return { id: source.id, label: source.label, count: await source.revoke(tdoc), error: null as string | null };
            } catch (error) {
                return { id: source.id, label: source.label, count: 0, error: (error as Error).message || String(error) };
            }
        }));
    }
}
