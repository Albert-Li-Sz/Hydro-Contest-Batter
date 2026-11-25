/**
 * 诚信复核: code similarity between teams and each team's timeline, for the jury to review (lib/integrity-routes.ts).
 *
 * Similarity compares the token structure of programs, not their text: comments and preprocessor lines go,
 * identifiers, numbers and strings become placeholders, keywords and operators stay. Each program's k-grams of
 * tokens are hashed and winnowed (Schleimer, Wilkerson, Aiken 2003, the method behind MOSS); fingerprints that
 * most teams share on a problem (templates, fast I/O) are left out. Two programs score the share of the smaller
 * one's fingerprints found in the other. Nothing here decides a case: it points the jury at what to look at.
 */

const KEYWORDS = new Set(`
alignas alignof and asm auto bool break case catch char class const constexpr continue decltype default delete do double else enum explicit
extern false float for friend goto if inline int long mutable namespace new noexcept not nullptr operator or private protected public register
return short signed sizeof static struct switch template this throw true try typedef typename union unsigned using virtual void volatile while
abstract boolean byte extends final finally implements import instanceof interface native package super synchronized throws transient var
def elif except from global in is lambda nonlocal pass raise with yield None True False print input range len
fun val when object companion data sealed internal override lateinit by
std vector map set unordered_map unordered_set pair string queue stack deque priority_queue cin cout endl scanf printf
`.split(/\s+/).filter(Boolean));

const TOKEN = /[A-Za-z_]\w*|\d[\w.]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|<<=|>>=|->|\+\+|--|<<|>>|<=|>=|==|!=|&&|\|\||[-+*/%&|^!~<>=?:;,.()[\]{}]/g;

/** The program as structural tokens. */
export function tokenize(code: string): string[] {
    const text = code
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ')
        .replace(/^[ \t]*#[^\n]*/gm, ' ');
    const tokens: string[] = [];
    for (const [token] of text.matchAll(TOKEN)) {
        const first = token[0];
        if (/[A-Za-z_]/.test(first)) tokens.push(KEYWORDS.has(token) ? token : 'V');
        else if (/\d/.test(first)) tokens.push('N');
        else if (first === '"' || first === '\'') tokens.push('S');
        else tokens.push(token);
    }
    return tokens;
}

function hash(text: string) {
    let value = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        value ^= text.charCodeAt(i);
        value = Math.imul(value, 0x01000193);
    }
    return value >>> 0;
}

export const K = 10;
export const WINDOW = 6;

/** Winnowed fingerprints of the token k-grams (the minimum hash of every window, rightmost on ties). */
export function fingerprints(tokens: string[], k = K, window = WINDOW): Set<number> {
    const grams: number[] = [];
    for (let i = 0; i + k <= tokens.length; i++) grams.push(hash(tokens.slice(i, i + k).join(' ')));
    const result = new Set<number>();
    if (!grams.length) return result;
    if (grams.length <= window) { result.add(Math.min(...grams)); return result; }
    for (let i = 0; i + window <= grams.length; i++) {
        let best = i;
        for (let j = i; j < i + window; j++) if (grams[j] <= grams[best]) best = j;
        result.add(grams[best]);
    }
    return result;
}

export interface CodeSample {
    rid: string;
    teamId: string;
    pid: number;
    code: string;
}
export interface SimilarPair {
    pid: number;
    a: { teamId: string; rid: string };
    b: { teamId: string; rid: string };
    /** Shared fingerprints over the smaller program's, 0 to 1. */
    score: number;
    shared: number;
}

/** Evidence chosen when opening a case. A single-team case includes its comparison partners. */
export function casePairs(pairs: SimilarPair[], teams: string[], pid?: number) {
    const selected = new Set(teams);
    return pairs.filter((pair) => (pid === undefined || pair.pid === pid)
        && (selected.size === 1 ? selected.has(pair.a.teamId) || selected.has(pair.b.teamId)
            : selected.has(pair.a.teamId) && selected.has(pair.b.teamId)));
}

export interface SimilarityOptions {
    /** Lowest score reported. */
    threshold: number;
    /** Programs with fewer fingerprints (after the common ones go) are too short to compare. */
    minFingerprints: number;
    /** A fingerprint on more than this share of a problem's programs is common code. */
    commonShare: number;
}
export const defaultSimilarity: SimilarityOptions = { threshold: 0.7, minFingerprints: 12, commonShare: 0.3 };

/** Pairs of programs of different teams on the same problem that share much of their structure. */
export function similarPairs(samples: CodeSample[], options: SimilarityOptions = defaultSimilarity): SimilarPair[] {
    const byProblem = new Map<number, CodeSample[]>();
    for (const sample of samples) byProblem.set(sample.pid, [...byProblem.get(sample.pid) || [], sample]);
    const pairs: SimilarPair[] = [];
    for (const [pid, list] of byProblem) {
        const prints = list.map((sample) => fingerprints(tokenize(sample.code)));
        const counts = new Map<number, number>();
        for (const set of prints) for (const value of set) counts.set(value, (counts.get(value) ?? 0) + 1);
        const limit = Math.max(3, Math.ceil(list.length * options.commonShare));
        const kept = prints.map((set) => new Set([...set].filter((value) => counts.get(value)! <= limit)));
        // Inverted index: only programs sharing a fingerprint are compared.
        const holders = new Map<number, number[]>();
        kept.forEach((set, index) => { for (const value of set) holders.set(value, [...holders.get(value) || [], index]); });
        const shared = new Map<string, number>();
        for (const indices of holders.values()) {
            for (let i = 0; i < indices.length; i++) {
                for (let j = i + 1; j < indices.length; j++) {
                    const key = `${indices[i]},${indices[j]}`;
                    shared.set(key, (shared.get(key) ?? 0) + 1);
                }
            }
        }
        for (const [key, count] of shared) {
            const [i, j] = key.split(',').map(Number);
            if (list[i].teamId === list[j].teamId) continue;
            const smaller = Math.min(kept[i].size, kept[j].size);
            if (smaller < options.minFingerprints) continue;
            const score = count / smaller;
            if (score < options.threshold) continue;
            pairs.push({ pid, a: { teamId: list[i].teamId, rid: list[i].rid }, b: { teamId: list[j].teamId, rid: list[j].rid }, score: Math.round(score * 1000) / 1000, shared: count });
        }
    }
    return pairs.sort((x, y) => y.score - x.score || y.shared - x.shared);
}

/** Teams linked by similar pairs, largest groups first, with the schools they come from. */
export function similarityGroups(pairs: SimilarPair[], schoolOf: (teamId: string) => string) {
    const parent = new Map<string, string>();
    const find = (id: string): string => {
        if (!parent.has(id)) parent.set(id, id);
        const root = parent.get(id)!;
        if (root === id) return id;
        const top = find(root);
        parent.set(id, top);
        return top;
    };
    for (const pair of pairs) parent.set(find(pair.a.teamId), find(pair.b.teamId));
    const groups = new Map<string, Set<string>>();
    for (const id of parent.keys()) {
        const root = find(id);
        groups.set(root, (groups.get(root) || new Set()).add(id));
    }
    return [...groups.values()].map((teams) => {
        const members = [...teams];
        const schools = [...new Set(members.map(schoolOf))];
        const inside = pairs.filter((pair) => teams.has(pair.a.teamId));
        return { teams: members, schools, pairs: inside.length, top: Math.max(...inside.map((pair) => pair.score)) };
    }).sort((a, b) => b.teams.length - a.teams.length || b.top - a.top);
}

export interface Interval { from: number; to: number }
/** Intervals joined where they touch or overlap (within `tolerance` ms). */
export function mergeIntervals(intervals: Interval[], tolerance = 1500): Interval[] {
    const sorted = [...intervals].filter((item) => item.to > item.from).sort((a, b) => a.from - b.from);
    const result: Interval[] = [];
    for (const item of sorted) {
        const last = result.at(-1);
        if (last && item.from <= last.to + tolerance) last.to = Math.max(last.to, item.to);
        else result.push({ ...item });
    }
    return result;
}

/** The parts of [from, to) no interval covers. */
export function uncovered(from: number, to: number, covered: Interval[]): Interval[] {
    const result: Interval[] = [];
    let cursor = from;
    for (const item of mergeIntervals(covered)) {
        if (item.to <= cursor) continue;
        if (item.from > cursor) result.push({ from: cursor, to: Math.min(item.from, to) });
        cursor = Math.max(cursor, item.to);
        if (cursor >= to) break;
    }
    if (cursor < to) result.push({ from: cursor, to });
    return result.filter((item) => item.to > item.from);
}

export type CaseStatus = 'open' | 'cleared' | 'violation';
export const caseStatuses: Record<CaseStatus, string> = { open: '待复核', cleared: '排除', violation: '认定违规' };

export class IntegrityError extends Error {
    constructor(message: string, public status = 400) { super(message); }
}

export function readCase(input: Record<string, unknown>, teams: Set<string>) {
    const list = Array.isArray(input.teams) ? [...new Set(input.teams.map(String))] : [];
    if (!list.length || list.length > 20 || list.some((id) => !teams.has(id))) throw new IntegrityError('请选择 1 至 20 支参赛队伍');
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (!title || title.length > 120) throw new IntegrityError('请填写 1 至 120 字的标题');
    const assignee = typeof input.assignee === 'string' ? input.assignee.trim().slice(0, 40) : '';
    const due = input.due === undefined || input.due === null || input.due === '' ? null : new Date(String(input.due));
    if (due && Number.isNaN(due.getTime())) throw new IntegrityError('复核期限无效');
    const detail = typeof input.detail === 'string' ? input.detail.slice(0, 4000) : '';
    return { teams: list, title, assignee, due, detail };
}
