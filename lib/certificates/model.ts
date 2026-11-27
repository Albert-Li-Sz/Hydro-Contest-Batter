/**
 * 证书: who receives which certificate, from one results snapshot (lib/results-store.ts) and the board's awards
 * (lib/results.ts resultBoard), with the details a certificate prints (制证信息表), its layout (模板) and its
 * identity (证书编号). Pure: lib/certificates/routes.ts reads and stores.
 *
 * Kinds: a team certificate per award and team, a member certificate per award and member, a coach certificate
 * per award and coach, and a participation certificate (参赛证明) per member of an official team. Awards follow
 * the results: unofficial teams receive the medals and other awards granted by the contest rules.
 */
import { createHash, randomBytes } from 'node:crypto';
import { BLACK, isInkColor } from '../../resolver/public/js/certificate-colors.js';
import { awardEnglish } from '../../resolver/public/js/certificate-frame.js';
import { designLabels, styledTemplate, type CertificateDesign } from '../../resolver/public/js/certificate-designs.js';
import { englishSchoolName, pinyinName } from '../../resolver/public/js/certificate-names.js';
import { eventPaper, eventText, isEventDesign } from '../../resolver/public/js/certificate-event.js';
import type { ResultBoard } from '../results';

export type CertificateKind = 'team' | 'member' | 'coach' | 'participation';
export const certificateKinds: readonly CertificateKind[] = ['team', 'member', 'coach', 'participation'];
export const kindNames: Record<CertificateKind, string> = { team: '团队获奖证书', member: '个人获奖证书', coach: '教练证书', participation: '参赛证明' };

export interface Person { name: string; nameEn: string }
interface SheetPerson extends Person { sourceIndex?: number }
/** 制证信息表 of one team after applying corrections and resolving its English names. */
export interface SheetTeam {
    teamId: string;
    team: string;
    teamEn: string;
    school: string;
    schoolEn: string;
    members: SheetPerson[];
    coaches: SheetPerson[];
}
export type SheetOverride = Partial<Omit<SheetTeam, 'teamId' | 'members' | 'coaches'>> & { members?: Partial<Person>[]; coaches?: Partial<Person>[] };
type LockedEnglish = Record<string, { schoolEn: string; members: string[]; coaches: string[] }>;

export type Placeholder = 'name' | 'nameEn' | 'team' | 'teamEn' | 'school' | 'schoolEn' | 'members' | 'membersEn' | 'coach' | 'coachEn'
    | 'award' | 'rank' | 'contest' | 'contestEn' | 'date' | 'issuer' | 'number';
export const placeholders: Record<Placeholder | 'awardEn', string> = {
    name: '姓名', nameEn: '英文姓名', team: '队伍', teamEn: '队伍英文名', school: '学校', schoolEn: '学校英文名', members: '队员',
    membersEn: '队员英文名', coach: '教练', coachEn: '教练英文名', award: '奖项', awardEn: '标准奖项英文', rank: '名次', contest: '比赛名称', contestEn: '比赛英文名',
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
    medalColor?: boolean;
    /** Kinds that print this field; empty: all. */
    kinds: CertificateKind[];
}
export interface CertificateTemplate {
    orientation: 'landscape' | 'portrait';
    font: 'serif' | 'sans';
    /** Older saved layouts use the original double rule. */
    frame?: CertificateDesign | 'classic';
    textColorVersion?: 1;
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
    /** English spellings reviewed at lock time. Older locked sheets have only their manual overrides. */
    lockedEnglish?: LockedEnglish | null;
}

export interface CertificateEntry {
    /** Stable across issues: the same award, team and person keeps the key when names are corrected. */
    key: string;
    kind: CertificateKind;
    awardId: string;
    teamId: string;
    values: Record<Placeholder, string>;
}

/** A team award reads as a recipient block next to the distinction. On portrait paper the distinction follows the roster. */
export function competitionTemplate(kind: 'award' | 'participation', orientation: CertificateTemplate['orientation'], design: CertificateDesign = 'engraved'): CertificateTemplate {
    const landscape = orientation === 'landscape';
    const award = kind === 'award';
    const w = landscape ? 297 : 210;
    const mid = w / 2;
    const gold = '#a05605';
    const field = (id: string, text: string, x: number, y: number, size: number, width: number, other: Partial<TemplateField> = {}): TemplateField =>
        ({ id, text, x, y, size, width, type: 'text', align: 'center', color: BLACK, kinds: [], ...other });
    const left = (id: string, text: string, y: number, size: number, options: Partial<TemplateField> = {}) =>
        field(id, text, 28, y, size, landscape ? 133 : 154, { align: 'left', ...options });
    const team: CertificateKind[] = ['team'];
    const honor = landscape ? 219 : mid;
    const footer = landscape ? 181 : 264;
    const base: CertificateTemplate = { orientation, font: 'serif', frame: 'engraved', textColorVersion: 1, background: null, fields: [
        field('title', award ? '获奖证书' : '参赛证明', mid, landscape ? 29 : 33, landscape ? 38 : 32, landscape ? 145 : 94, { color: '#114d94' }),
        field('title-en', award ? 'Certificate of Achievement' : 'Certificate of Participation', mid, landscape ? 43 : 47, 15, landscape ? 145 : 98, { color: gold }),
        left('recipient-label', award ? '颁予  /  AWARDED TO' : '参赛者  /  PARTICIPANT', landscape ? 69 : 78, 10),
        left('name', '{name}', landscape ? 83 : 93, 28),
        left('name-en', '{nameEn}', landscape ? 94 : 105, 14),
        left('school', '{school}', landscape ? 104 : 119, 16),
        left('school-en', '{schoolEn}', landscape ? 111 : 127, 11),
        ...(award ? [
            left('members', '队员　{members}', landscape ? 119 : 137, 13, { kinds: team }),
            left('members-en', '{membersEn}', landscape ? 125 : 144, 10, { kinds: team }),
            left('coach', '教练　{coach}', landscape ? 131 : 151, 12, { kinds: team }),
            left('coach-en', '{coachEn}', landscape ? 137 : 158, 10, { kinds: team }),
            left('team', '所属队伍　{team}', landscape ? 123 : 142, 12, { kinds: ['member', 'coach'] }),
        ] : []),
        field('distinction-label', award ? '奖项  /  DISTINCTION' : '参赛队伍  /  TEAM', honor, landscape ? 77 : 169, 10, landscape ? 82 : 156),
        field(award ? 'award' : 'team', award ? '{award}' : '{team}', honor, landscape ? 99 : 189, award ? 38 : 27, landscape ? 84 : 154, { color: gold, medalColor: award }),
        field('distinction-en', award ? '{awardEn}' : '{teamEn}', honor, landscape ? 119 : 210, 16, landscape ? 85 : 156, { color: gold, medalColor: award }),
        field('contest', '{contest}', mid, landscape ? 149 : 221, 17, w - 56),
        field('contest-en', '{contestEn}', mid, landscape ? 158 : 232, 11, w - 56),
        field('qr', '', 37, footer + 2, 21, 21, { type: 'qr' }),
        field('serial-label', '证书编号  /  CERTIFICATE NO.', 52, footer - 2, 8, 68, { align: 'left' }),
        field('number', '{number}', 52, footer + 5, 12, 64, { align: 'left' }),
        field('issuer', '{issuer}', w - 27, footer - 1, 14, landscape ? 111 : 73, { align: 'right' }),
        field('date', '{date}', w - 27, footer + 8, 11, landscape ? 111 : 73, { align: 'right' }),
    ] };
    return design === 'engraved' ? base : styledTemplate(base, design, kind);
}

export function defaultTemplates(): CertificateConfig['templates'] {
    return { award: competitionTemplate('award', 'landscape'), participation: competitionTemplate('participation', 'portrait') };
}

// Match the former defaults by both preset and field; an organizer's custom shades are exact RGB values.
const rosterFields = ['name', 'name-en', 'school', 'school-en', 'members', 'members-en', 'coach', 'coach-en', 'team'];
const footerFields = ['serial-label', 'number', 'issuer', 'date'];
const engravedBody = ['name', 'school', 'members', 'coach', 'team', 'contest', 'number', 'issuer'];
const engravedSecondary = ['recipient-label', 'name-en', 'school-en', 'members-en', 'coach-en', 'distinction-label', 'contest-en', 'serial-label', 'date'];
const oldTextInks: Partial<Record<CertificateDesign, Record<string, string[]>>> = {
    'event-zh': { '#183e65': ['title-zh', 'award'] },
    engraved: { '#164779': engravedBody, '#233e53': [...engravedBody, 'title'], '#315b71': engravedSecondary, '#4b6268': engravedSecondary },
    icpc: { '#173c61': [...rosterFields, ...footerFields, 'contest'] },
    ccpc: { '#412a2e': [...rosterFields, ...footerFields, 'recipient-label', 'contest', 'contest-en'] },
    gplt: { '#1c3445': rosterFields, '#075f9e': footerFields },
    lanqiao: { '#23384b': [...rosterFields, ...footerFields] },
};
export function restoreTextColors(template: CertificateTemplate, kind: 'award' | 'participation'): CertificateTemplate {
    if (template.textColorVersion === 1) return template;
    const legacy = template.frame && template.frame !== 'classic' ? oldTextInks[template.frame] : undefined;
    const fields = template.fields.map((field) => {
        if (field.type !== 'text') return field;
        if (!isInkColor(field.color)) return { ...field, color: BLACK };
        const rgb = field.color.toLowerCase();
        const oldAddedField = !template.frame || template.frame === 'classic' || /^f(?:-|\d)/.test(field.id);
        const match = legacy?.[rgb]?.includes(field.id) && !(field.id === 'team' && kind === 'participation');
        return (rgb === '#2b2118' && oldAddedField) || match ? { ...field, color: BLACK } : field;
    });
    return { ...template, fields, textColorVersion: 1 };
}

export function defaultConfig(contest: string): CertificateConfig {
    return {
        source: '', board: 'all', kinds: { team: false, member: true, coach: false, participation: false }, skipAwards: [],
        contest, contestEn: '', date: '', issuer: '', templates: defaultTemplates(), sheet: {}, locked: false,
    };
}

export const pageSize = (template: CertificateTemplate) => isEventDesign(template.frame) ? eventPaper
    : template.orientation === 'portrait' ? { width: 210, height: 297 } : { width: 297, height: 210 };

function object(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}格式无效`);
    return value as Record<string, unknown>;
}
const text = (value: unknown, label: string, max: number) => {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string' || value.length > max) throw new Error(`${label}最多 ${max} 个字符`);
    return value.trim();
};
const number = (value: unknown, label: string, min: number, max: number, precision = 10) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label}应在 ${min} 至 ${max} 之间`);
    return Math.round(value * precision) / precision;
};

export function normalizeTemplate(value: unknown, fallback: CertificateTemplate): CertificateTemplate {
    if (value === undefined) return fallback;
    const input = object(value, '证书模板');
    const frame = typeof input.frame === 'string' && Object.hasOwn(designLabels, input.frame) ? input.frame as CertificateDesign : 'classic';
    const orientation = !isEventDesign(frame) && input.orientation === 'portrait' ? 'portrait' : 'landscape';
    const { width, height } = pageSize({ orientation, frame } as CertificateTemplate);
    const precision = isEventDesign(frame) ? 1e6 : 10;
    if (!Array.isArray(input.fields) || input.fields.length > 40) throw new Error('证书模板最多 40 个字段');
    const ids = new Set<string>();
    const fields = input.fields.map((raw, index): TemplateField => {
        const item = object(raw, `第 ${index + 1} 个字段`);
        const id = typeof item.id === 'string' && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(item.id) && !ids.has(item.id) ? item.id : `f${index + 1}`;
        ids.add(id);
        const kinds = Array.isArray(item.kinds) ? certificateKinds.filter((kind) => (item.kinds as unknown[]).includes(kind)) : [];
        const color = isInkColor(item.color) ? item.color.toLowerCase() : BLACK;
        return {
            id, type: item.type === 'qr' ? 'qr' : 'text', text: text(item.text, '字段内容', 200),
            x: number(item.x, '字段横向位置', 0, width, precision), y: number(item.y, '字段纵向位置', 0, height, precision),
            size: number(item.size, item.type === 'qr' ? '二维码边长' : '字号', 4, item.type === 'qr' ? 80 : 120, precision),
            align: item.align === 'left' || item.align === 'right' ? item.align : 'center',
            width: number(item.width ?? 0, '最大宽度', 0, width), color, kinds, ...(item.medalColor === true ? { medalColor: true } : {}),
        };
    });
    const background = input.background === null || input.background === undefined ? null
        : typeof input.background === 'string' && /^[a-f0-9]{24}$/.test(input.background) ? input.background : null;
    return { orientation, font: frame === 'event' || input.font === 'sans' ? 'sans' : 'serif', frame, textColorVersion: 1, background, fields };
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
export function sheetOf(result: ResultBoard, overrides: Record<string, SheetOverride>, locked?: LockedEnglish): SheetTeam[] {
    return result.rows.map((row) => {
        const own = overrides[row.id] || {};
        const saved = locked?.[row.id];
        const school = own.school || row.school;
        const merge = (role: 'members' | 'coaches') => {
            const base = row[role];
            const edits = own[role] || [];
            // Additional people in a CSV may occupy sparse slots after the original roster.
            const result: SheetPerson[] = [];
            for (let i = 0; i < Math.max(base.length, edits.length); i++) {
                const name = edits[i]?.name || base[i] || '';
                if (!name && i >= base.length) continue;
                const nameEn = edits[i]?.nameEn || (locked ? saved?.[role][result.length] || '' : pinyinName(name));
                result.push({ name, nameEn, ...(i !== result.length ? { sourceIndex: i } : {}) });
            }
            return result;
        };
        return {
            teamId: row.id, team: own.team || row.name, teamEn: own.teamEn || '', school,
            schoolEn: own.schoolEn || (locked ? saved?.schoolEn || '' : englishSchoolName(school)),
            members: merge('members'), coaches: merge('coaches'),
        };
    });
}

export function certificateSheet(result: ResultBoard, config: CertificateConfig) {
    return sheetOf(result, config.sheet, config.locked ? config.lockedEnglish ?? {} : undefined);
}

export function freezeEnglish(sheet: SheetTeam[]): LockedEnglish {
    return Object.fromEntries(sheet.map((team) => [team.teamId, {
        schoolEn: team.schoolEn, members: team.members.map((person) => person.nameEn), coaches: team.coaches.map((person) => person.nameEn),
    }]));
}

/** Every certificate these results give under `config`, in board order and award order. */
export function certificateEntries(result: ResultBoard, config: CertificateConfig, teams = certificateSheet(result, config)): CertificateEntry[] {
    const sheet = new Map(teams.map((team) => [team.teamId, team]));
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
/** An entry's values as rendered: the placeholders plus the award's id, which tells its medal (gold-medal…). */
export type CertificateValues = Partial<Record<Placeholder, string>> & { awardId?: string };
export function fillText(template: string, values: CertificateValues) {
    let used = 0; let filled = 0;
    const result = template.replace(FIELD, (match, name: string) => {
        if (!Object.hasOwn(placeholders, name)) return match;
        used++;
        const value = name === 'awardEn' ? awardEnglish(values.award || '', values.awardId) : values[name as Placeholder] || '';
        if (value) filled++;
        return value;
    });
    return used && !filled ? '' : result.trim();
}

/** Placeholders the template prints for this kind that the entry leaves empty (缺失字段). */
export function missingFields(template: CertificateTemplate, entry: Pick<CertificateEntry, 'kind' | 'values'> & { awardId?: string }): Placeholder[] {
    const missing = new Set<Placeholder>();
    for (const item of template.fields) {
        if (item.type !== 'text' || (item.kinds.length && !item.kinds.includes(entry.kind))) continue;
        for (const [token, name] of item.text.matchAll(FIELD)) {
            if (isEventDesign(template.frame) && eventText(token, entry.values, entry.kind, awardEnglish(entry.values.award, entry.awardId), template.frame)) continue;
            if (Object.hasOwn(placeholders, name) && name !== 'number' && name !== 'awardEn' && !entry.values[name as Placeholder]) missing.add(name as Placeholder);
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
        team.members.forEach((person, index) => rows.push([team.teamId, '队员', String((person.sourceIndex ?? index) + 1), person.name, person.nameEn, ...common]));
        team.coaches.forEach((person, index) => rows.push([team.teamId, '教练', String((person.sourceIndex ?? index) + 1), person.name, person.nameEn, ...common]));
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

// Exported automatic spellings may still be in the CSV when only its Chinese column was corrected.
function englishOverride(value: string, manual: string | undefined, before: string, after: string) {
    if (value === manual) return value;
    if (value === after || (!manual && value === before)) return '';
    return value;
}

/** Overrides from an uploaded sheet, without turning automatically filled cells into manual edits. */
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
            const key = role === '队员' ? 'members' : 'coaches';
            const list = own[key] ||= [];
            const baseName = row[key][index] || '';
            const person = list[index] || {};
            const prior = previous[teamId]?.[key]?.[index];
            const name = read('姓名'); const nameEn = read('英文姓名');
            if (name !== undefined) { if (name && name !== baseName) person.name = name; else delete person.name; }
            if (nameEn !== undefined) {
                const manual = englishOverride(nameEn, prior?.nameEn, pinyinName(prior?.name || baseName), pinyinName(person.name || baseName));
                if (manual) person.nameEn = manual; else delete person.nameEn;
            }
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
            if (key === 'schoolEn') continue;
            if (value && value !== base[key]) own[key] = value; else delete own[key];
        }
        const schoolEn = fields.get('schoolEn');
        if (schoolEn !== undefined) {
            const prior = previous[teamId];
            const manual = englishOverride(schoolEn, prior?.schoolEn, englishSchoolName(prior?.school || row.school), englishSchoolName(own.school || row.school));
            if (manual) own.schoolEn = manual; else delete own.schoolEn;
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
        if (Object.keys(result).length) overrides[teamId] = result; else delete overrides[teamId];
    }
    return { overrides, updated, unknown: [...new Set(unknown)] };
}
