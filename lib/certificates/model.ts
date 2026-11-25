/**
 * 证书: who receives which certificate, from one results snapshot (lib/results-store.ts) and the board's awards
 * (lib/results.ts resultBoard), with the details a certificate prints (制证信息表), its layout (模板) and its
 * identity (证书编号). Pure: lib/certificates/routes.ts reads and stores.
 *
 * Kinds: a team certificate per award and team, a member certificate per award and member, a coach certificate
 * per award and coach, and a participation certificate (参赛证明) per member of an official team. Awards follow
 * the results: unofficial teams receive what their awards allow them (最快解题奖, 顽强拼搏奖…), never a medal.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { ResultBoard } from '../results';

export type CertificateKind = 'team' | 'member' | 'coach' | 'participation';
export const certificateKinds: readonly CertificateKind[] = ['team', 'member', 'coach', 'participation'];
export const kindNames: Record<CertificateKind, string> = { team: '团队获奖证书', member: '个人获奖证书', coach: '教练证书', participation: '参赛证明' };

export interface Person { name: string; nameEn: string }
/** 制证信息表 of one team: what the results give, with the corrections and English names entered by hand. */
export interface SheetTeam {
    teamId: string;
    team: string;
    teamEn: string;
    school: string;
    schoolEn: string;
    members: Person[];
    coaches: Person[];
}
export type SheetOverride = Partial<Omit<SheetTeam, 'teamId' | 'members' | 'coaches'>> & { members?: Partial<Person>[]; coaches?: Partial<Person>[] };

export type Placeholder = 'name' | 'nameEn' | 'team' | 'teamEn' | 'school' | 'schoolEn' | 'members' | 'membersEn' | 'coach' | 'coachEn'
    | 'award' | 'rank' | 'contest' | 'contestEn' | 'date' | 'issuer' | 'number';
export const placeholders: Record<Placeholder, string> = {
    name: '姓名', nameEn: '英文姓名', team: '队伍', teamEn: '队伍英文名', school: '学校', schoolEn: '学校英文名', members: '队员',
    membersEn: '队员英文名', coach: '教练', coachEn: '教练英文名', award: '奖项', rank: '名次', contest: '比赛名称', contestEn: '比赛英文名',
    date: '颁发日期', issuer: '颁发单位', number: '证书编号',
};

export interface TemplateField {
    id: string;
    type: 'text' | 'qr';
    /** Text with `{placeholder}`s; a line whose placeholders are all empty is left out. */
    text: string;
    x: number;
    y: number;
    size: number;
    align: 'left' | 'center' | 'right';
    width: number;
    color: string;
    /** Kinds that print this field; empty: all. */
    kinds: CertificateKind[];
}
export interface CertificateTemplate {
    orientation: 'landscape' | 'portrait';
    font: 'serif' | 'sans';
    /** Asset id of the background image; without one a border is drawn. */
    background: string | null;
    fields: TemplateField[];
}
export interface CertificateConfig {
    /** Results snapshot the certificates are issued from. */
    source: string;
    board: string;
    kinds: Record<CertificateKind, boolean>;
    /** Award ids left out (for example, the per-problem first solves). */
    skipAwards: string[];
    contest: string;
    contestEn: string;
    date: string;
    issuer: string;
    templates: { award: CertificateTemplate; participation: CertificateTemplate };
    sheet: Record<string, SheetOverride>;
    /** Certificates are issued only from a checked sheet. */
    locked: boolean;
}

export interface CertificateEntry {
    /** Stable across issues: the same award, team and person keeps the key when names are corrected. */
    key: string;
    kind: CertificateKind;
    awardId: string;
    teamId: string;
    values: Record<Placeholder, string>;
}

const field = (input: Partial<TemplateField> & Pick<TemplateField, 'id' | 'text' | 'y' | 'size'>): TemplateField => ({
    type: 'text', x: 148.5, align: 'center', width: 250, color: '#2b2118', kinds: [], ...input,
});

export function defaultTemplates(): CertificateConfig['templates'] {
    return {
        award: { orientation: 'landscape', font: 'serif', background: null, fields: [
            field({ id: 'title', text: '获奖证书', y: 40, size: 40 }),
            field({ id: 'title-en', text: 'Certificate of Achievement', y: 55, size: 18 }),
            field({ id: 'name', text: '{name}', y: 82, size: 30 }),
            field({ id: 'name-en', text: '{nameEn}', y: 94, size: 13 }),
            field({ id: 'school', text: '{school}', y: 106, size: 16, kinds: ['member', 'coach'] }),
            field({ id: 'team', text: '{school} · {team}', y: 106, size: 16, kinds: ['team'] }),
            field({ id: 'members', text: '队员：{members}', y: 116, size: 13, kinds: ['team'] }),
            field({ id: 'coach', text: '教练：{coach}', y: 124, size: 13, kinds: ['team'] }),
            field({ id: 'body', text: '在 {contest} 中荣获', y: 134, size: 16 }),
            field({ id: 'award', text: '{award}', y: 152, size: 32 }),
            field({ id: 'issuer', text: '{issuer}', x: 232, y: 176, size: 14, width: 110 }),
            field({ id: 'date', text: '{date}', x: 232, y: 186, size: 12, width: 110 }),
            field({ id: 'qr', type: 'qr', text: '', x: 34, y: 172, size: 26, width: 26 }),
            field({ id: 'number', text: '证书编号 {number}', x: 21, y: 192, size: 9, align: 'left', width: 80 }),
        ] },
        participation: { orientation: 'landscape', font: 'serif', background: null, fields: [
            field({ id: 'title', text: '参赛证明', y: 42, size: 40 }),
            field({ id: 'title-en', text: 'Certificate of Participation', y: 57, size: 18 }),
            field({ id: 'name', text: '{name}', y: 88, size: 30 }),
            field({ id: 'name-en', text: '{nameEn}', y: 100, size: 13 }),
            field({ id: 'school', text: '{school} · {team}', y: 113, size: 16 }),
            field({ id: 'body', text: '参加了 {contest}', y: 132, size: 16 }),
            field({ id: 'body-en', text: '{contestEn}', y: 142, size: 12 }),
            field({ id: 'issuer', text: '{issuer}', x: 232, y: 176, size: 14, width: 110 }),
            field({ id: 'date', text: '{date}', x: 232, y: 186, size: 12, width: 110 }),
            field({ id: 'qr', type: 'qr', text: '', x: 34, y: 172, size: 26, width: 26 }),
            field({ id: 'number', text: '证书编号 {number}', x: 21, y: 192, size: 9, align: 'left', width: 80 }),
        ] },
    };
}

export function defaultConfig(contest: string): CertificateConfig {
    return {
        source: '', board: 'all', kinds: { team: false, member: true, coach: false, participation: false }, skipAwards: [],
        contest, contestEn: '', date: '', issuer: '', templates: defaultTemplates(), sheet: {}, locked: false,
    };
}

export const pageSize = (template: CertificateTemplate) => (template.orientation === 'portrait' ? { width: 210, height: 297 } : { width: 297, height: 210 });

function object(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}格式无效`);
    return value as Record<string, unknown>;
}
const text = (value: unknown, label: string, max: number) => {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string' || value.length > max) throw new Error(`${label}最多 ${max} 个字符`);
    return value.trim();
};
const number = (value: unknown, label: string, min: number, max: number) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label}应在 ${min} 至 ${max} 之间`);
    return Math.round(value * 10) / 10;
};

export function normalizeTemplate(value: unknown, fallback: CertificateTemplate): CertificateTemplate {
    if (value === undefined) return fallback;
    const input = object(value, '证书模板');
    const orientation = input.orientation === 'portrait' ? 'portrait' : 'landscape';
    const { width, height } = pageSize({ orientation } as CertificateTemplate);
    if (!Array.isArray(input.fields) || input.fields.length > 40) throw new Error('证书模板最多 40 个字段');
    const ids = new Set<string>();
    const fields = input.fields.map((raw, index): TemplateField => {
        const item = object(raw, `第 ${index + 1} 个字段`);
        const id = typeof item.id === 'string' && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(item.id) && !ids.has(item.id) ? item.id : `f${index + 1}`;
        ids.add(id);
        const kinds = Array.isArray(item.kinds) ? certificateKinds.filter((kind) => (item.kinds as unknown[]).includes(kind)) : [];
        const color = typeof item.color === 'string' && /^#[0-9a-f]{6}$/i.test(item.color) ? item.color.toLowerCase() : '#2b2118';
        return {
            id, type: item.type === 'qr' ? 'qr' : 'text', text: text(item.text, '字段内容', 200),
            x: number(item.x, '字段横向位置', 0, width), y: number(item.y, '字段纵向位置', 0, height),
            size: number(item.size, item.type === 'qr' ? '二维码边长' : '字号', 4, item.type === 'qr' ? 80 : 120),
            align: item.align === 'left' || item.align === 'right' ? item.align : 'center',
            width: number(item.width ?? 0, '最大宽度', 0, width), color, kinds,
        };
    });
    const background = input.background === null || input.background === undefined ? null
        : typeof input.background === 'string' && /^[a-f0-9]{24}$/.test(input.background) ? input.background : null;
    return { orientation, font: input.font === 'sans' ? 'sans' : 'serif', background, fields };
}

function people(value: unknown, label: string): Partial<Person>[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > 20) throw new Error(`${label}最多 20 人`);
    return value.map((item) => {
        const person = object(item ?? {}, label);
        const result: Partial<Person> = {};
        if (person.name !== undefined) result.name = text(person.name, `${label}姓名`, 80);
        if (person.nameEn !== undefined) result.nameEn = text(person.nameEn, `${label}英文姓名`, 120);
        return result;
    });
}

export function normalizeOverride(value: unknown): SheetOverride {
    const input = object(value, '信息表');
    const result: SheetOverride = {};
    for (const [key, label, max] of [['team', '队伍', 80], ['teamEn', '队伍英文名', 160], ['school', '学校', 80], ['schoolEn', '学校英文名', 200]] as const) {
        if (input[key] !== undefined) result[key] = text(input[key], label, max);
    }
    const members = people(input.members, '队员');
    const coaches = people(input.coaches, '教练');
    if (members) result.members = members;
    if (coaches) result.coaches = coaches;
    return result;
}

export function normalizeConfig(value: unknown, fallback: CertificateConfig): CertificateConfig {
    const input = object(value, '证书设置');
    const result: CertificateConfig = { ...fallback, kinds: { ...fallback.kinds }, templates: { ...fallback.templates } };
    if (input.source !== undefined) {
        if (typeof input.source !== 'string' || input.source.length > 200) throw new Error('出证依据无效');
        result.source = input.source;
    }
    if (input.board !== undefined) {
        if (typeof input.board !== 'string' || input.board.length > 80) throw new Error('榜单无效');
        result.board = input.board;
    }
    if (input.kinds !== undefined) {
        const kinds = object(input.kinds, '证书种类');
        for (const kind of certificateKinds) if (kinds[kind] !== undefined) result.kinds[kind] = kinds[kind] === true;
    }
    if (input.skipAwards !== undefined) {
        if (!Array.isArray(input.skipAwards) || input.skipAwards.length > 200 || input.skipAwards.some((id) => typeof id !== 'string' || id.length > 80)) throw new Error('不出证的奖项无效');
        result.skipAwards = [...new Set(input.skipAwards as string[])];
    }
    for (const [key, label, max] of [['contest', '比赛名称', 120], ['contestEn', '比赛英文名', 200], ['date', '颁发日期', 60], ['issuer', '颁发单位', 120]] as const) {
        if (input[key] !== undefined) result[key] = text(input[key], label, max);
    }
    if (input.templates !== undefined) {
        const templates = object(input.templates, '证书模板');
        result.templates = { award: normalizeTemplate(templates.award, result.templates.award), participation: normalizeTemplate(templates.participation, result.templates.participation) };
    }
    if (input.locked !== undefined) result.locked = input.locked === true;
    return result;
}

/** The sheet of every team of the results: what the results give, with the overrides applied. */
export function sheetOf(result: ResultBoard, overrides: Record<string, SheetOverride>): SheetTeam[] {
    return result.rows.map((row) => {
        const own = overrides[row.id] || {};
        const merge = (base: string[], edits: Partial<Person>[] = []) => base.map((name, index) => ({
            name: edits[index]?.name || name, nameEn: edits[index]?.nameEn || '',
        })).concat(edits.slice(base.length).filter((edit) => edit?.name).map((edit) => ({ name: edit.name!, nameEn: edit.nameEn || '' })));
        return {
            teamId: row.id, team: own.team || row.name, teamEn: own.teamEn || '', school: own.school || row.school, schoolEn: own.schoolEn || '',
            members: merge(row.members, own.members), coaches: merge(row.coaches, own.coaches),
        };
    });
}

/** Every certificate these results give under `config`, in board order and award order. */
export function certificateEntries(result: ResultBoard, config: CertificateConfig): CertificateEntry[] {
    const sheet = new Map(sheetOf(result, config.sheet).map((team) => [team.teamId, team]));
    const rows = new Map(result.rows.map((row) => [row.id, row]));
    const skip = new Set(config.skipAwards);
    const base = (team: SheetTeam, award: string, rank: string) => ({
        team: team.team, teamEn: team.teamEn, school: team.school, schoolEn: team.schoolEn,
        members: team.members.map((person) => person.name).join('、'), membersEn: team.members.map((person) => person.nameEn).filter(Boolean).join(', '),
        coach: team.coaches.map((person) => person.name).join('、'), coachEn: team.coaches.map((person) => person.nameEn).filter(Boolean).join(', '),
        award, rank, contest: config.contest, contestEn: config.contestEn, date: config.date, issuer: config.issuer, number: '',
    });
    const entries: CertificateEntry[] = [];
    for (const award of result.awards) {
        if (skip.has(award.id)) continue;
        for (const teamId of award.teamIds) {
            const team = sheet.get(teamId);
            const row = rows.get(teamId);
            if (!team || !row) continue;
            const shared = base(team, award.name, row.rank ? String(row.rank) : '');
            if (config.kinds.team) entries.push({ key: `team:${award.id}:${teamId}`, kind: 'team', awardId: award.id, teamId, values: { ...shared, name: team.team, nameEn: team.teamEn } });
            if (config.kinds.member) {
                team.members.forEach((person, index) => entries.push({ key: `member:${award.id}:${teamId}:${index}`, kind: 'member', awardId: award.id, teamId,
                    values: { ...shared, name: person.name, nameEn: person.nameEn } }));
            }
            if (config.kinds.coach) {
                team.coaches.forEach((person, index) => entries.push({ key: `coach:${award.id}:${teamId}:${index}`, kind: 'coach', awardId: award.id, teamId,
                    values: { ...shared, name: person.name, nameEn: person.nameEn } }));
            }
        }
    }
    if (config.kinds.participation) {
        for (const row of result.rows) {
            // Official teams only: an unofficial team took part, but outside the contest's ranking.
            if (!row.rank) continue;
            const team = sheet.get(row.id)!;
            team.members.forEach((person, index) => entries.push({ key: `participation::${row.id}:${index}`, kind: 'participation', awardId: '', teamId: row.id,
                values: { ...base(team, '', String(row.rank)), name: person.name, nameEn: person.nameEn } }));
        }
    }
    return entries;
}

const FIELD = /\{([a-zA-Z]+)\}/g;
/** A template line with the entry's values, or '' when the line has placeholders and every one is empty. */
export function fillText(template: string, values: Partial<Record<Placeholder, string>>) {
    let used = 0; let filled = 0;
    const result = template.replace(FIELD, (match, name: string) => {
        if (!Object.hasOwn(placeholders, name)) return match;
        used++;
        const value = values[name as Placeholder] || '';
        if (value) filled++;
        return value;
    });
    return used && !filled ? '' : result.trim();
}

/** Placeholders the template prints for this kind that the entry leaves empty (缺失字段). */
export function missingFields(template: CertificateTemplate, entry: Pick<CertificateEntry, 'kind' | 'values'>): Placeholder[] {
    const missing = new Set<Placeholder>();
    for (const item of template.fields) {
        if (item.type !== 'text' || (item.kinds.length && !item.kinds.includes(entry.kind))) continue;
        for (const [, name] of item.text.matchAll(FIELD)) {
            if (Object.hasOwn(placeholders, name) && name !== 'number' && !entry.values[name as Placeholder]) missing.add(name as Placeholder);
        }
    }
    return [...missing];
}

export const templateFor = (config: CertificateConfig, kind: CertificateKind) => (kind === 'participation' ? config.templates.participation : config.templates.award);

/** What makes two issues of a certificate the same: the printed values without the number. */
export function fingerprint(entry: Pick<CertificateEntry, 'kind' | 'values'>) {
    const { number: _number, ...values } = entry.values;
    return createHash('sha256').update(JSON.stringify([entry.kind, Object.entries(values).sort(([a], [b]) => a.localeCompare(b))])).digest('hex').slice(0, 32);
}

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
/** 证书编号: 10 characters without 0/O/1/I, 50 random bits. */
export function certificateCode() {
    return [...randomBytes(10)].map((byte) => ALPHABET[byte & 31]).join('');
}

export interface IssuedState { code: string; key: string; fingerprint: string }
export interface IssuePlan {
    create: CertificateEntry[];
    /** Issued certificates whose values changed: replaced by a new issue of the same key. */
    correct: { previous: string; entry: CertificateEntry }[];
    /** Issued certificates the results no longer give. */
    revoke: string[];
    unchanged: number;
}

/** Issue only what changed: a corrected name or award replaces those certificates, the rest keep their numbers. */
export function planIssue(entries: CertificateEntry[], issued: IssuedState[]): IssuePlan {
    const current = new Map(issued.map((item) => [item.key, item]));
    const plan: IssuePlan = { create: [], correct: [], revoke: [], unchanged: 0 };
    const seen = new Set<string>();
    for (const entry of entries) {
        seen.add(entry.key);
        const previous = current.get(entry.key);
        if (!previous) plan.create.push(entry);
        else if (previous.fingerprint !== fingerprint(entry)) plan.correct.push({ previous: previous.code, entry });
        else plan.unchanged++;
    }
    for (const item of issued) if (!seen.has(item.key)) plan.revoke.push(item.code);
    return plan;
}

/** File name parts are kept readable but safe on every system. */
export const safeName = (value: string) => [...value.replace(/[\\/:*?"<>|\x00-\x1f]/gu, '-').trim()].slice(0, 60).join('') || '未命名';

const CSV_HEADER = ['队伍 ID', '角色', '序号', '姓名', '英文姓名', '队伍', '队伍英文名', '学校', '学校英文名'];
/** The sheet as a CSV, one row per person (team rows for teams without members). */
export function sheetRows(sheet: SheetTeam[]): string[][] {
    const rows: string[][] = [CSV_HEADER];
    for (const team of sheet) {
        const common = [team.team, team.teamEn, team.school, team.schoolEn];
        team.members.forEach((person, index) => rows.push([team.teamId, '队员', String(index + 1), person.name, person.nameEn, ...common]));
        team.coaches.forEach((person, index) => rows.push([team.teamId, '教练', String(index + 1), person.name, person.nameEn, ...common]));
        if (!team.members.length && !team.coaches.length) rows.push([team.teamId, '', '', '', '', ...common]);
    }
    return rows;
}

/** CSV cells, quoted or not; a UTF-8 BOM is ignored. */
export function parseCsv(input: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = []; let cell = ''; let quoted = false;
    const text = input.replace(/^﻿/, '');
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (quoted) {
            if (char === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (char === '"') quoted = false; else cell += char;
        } else if (char === '"') quoted = true;
        else if (char === ',') { row.push(cell); cell = ''; }
        else if (char === '\n' || char === '\r') {
            if (char === '\r' && text[i + 1] === '\n') i++;
            row.push(cell); rows.push(row); row = []; cell = '';
        } else cell += char;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((line) => line.some((value) => value.trim()));
}

/** Overrides from an uploaded sheet: every cell that differs from the results becomes a correction. */
export function overridesFromCsv(csv: string, result: ResultBoard, previous: Record<string, SheetOverride>) {
    const rows = parseCsv(csv);
    const header = rows.shift()?.map((cell) => cell.trim()) || [];
    const column = (name: string) => header.indexOf(name);
    if (column('队伍 ID') < 0) throw new Error('信息表缺少“队伍 ID”列，请使用下载的信息表填写');
    const known = new Map(result.rows.map((row) => [row.id, row]));
    const overrides: Record<string, SheetOverride> = JSON.parse(JSON.stringify(previous));
    let updated = 0;
    const unknown: string[] = [];
    // Team fields repeat on every row of the team: the first filled one counts, all empty clears the correction.
    const teamFields = new Map<string, Map<'team' | 'teamEn' | 'school' | 'schoolEn', string>>();
    for (const cells of rows) {
        const read = (name: string) => (column(name) >= 0 ? (cells[column(name)] ?? '').trim() : undefined);
        const teamId = read('队伍 ID')!.replace(/^'/, '');
        const row = known.get(teamId);
        if (!row) { unknown.push(teamId); continue; }
        const own = overrides[teamId] ||= {};
        const fields = teamFields.get(teamId) || new Map();
        teamFields.set(teamId, fields);
        for (const [key, name] of [['team', '队伍'], ['teamEn', '队伍英文名'], ['school', '学校'], ['schoolEn', '学校英文名']] as const) {
            const value = read(name);
            if (value === undefined) continue;
            if (!fields.get(key)) fields.set(key, value);
        }
        const role = read('角色');
        const index = Number(read('序号')) - 1;
        if ((role === '队员' || role === '教练') && Number.isSafeInteger(index) && index >= 0 && index < 20) {
            const list = role === '队员' ? (own.members ||= []) : (own.coaches ||= []);
            const baseName = (role === '队员' ? row.members : row.coaches)[index] || '';
            const person = list[index] || {};
            const name = read('姓名'); const nameEn = read('英文姓名');
            if (name !== undefined) { if (name && name !== baseName) person.name = name; else delete person.name; }
            if (nameEn !== undefined) { if (nameEn) person.nameEn = nameEn; else delete person.nameEn; }
            while (list.length <= index) list.push({});
            list[index] = person;
        }
        updated++;
    }
    for (const [teamId, fields] of teamFields) {
        const row = known.get(teamId)!;
        const own = overrides[teamId];
        const base = { team: row.name, teamEn: '', school: row.school, schoolEn: '' };
        for (const [key, value] of fields) {
            if (value && value !== base[key]) own[key] = value; else delete own[key];
        }
    }
    for (const [teamId, own] of Object.entries(overrides)) {
        const result = normalizeOverride(own);
        for (const key of ['members', 'coaches'] as const) {
            const list = result[key];
            if (!list) continue;
            while (list.length && !Object.keys(list.at(-1)!).length) list.pop();
            if (!list.length) delete result[key];
        }
        overrides[teamId] = result;
    }
    return { overrides, updated, unknown: [...new Set(unknown)] };
}
