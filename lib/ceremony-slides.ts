import { boardOptions, resultBoard, type ResultBoard, type ResultsData } from './results';

export const ceremonyThemes = { gala: '深色典礼', red: '红金', blue: '海蓝', light: '浅色' };
export interface CeremonyConfig {
    source: string;
    boards: string[];
    reverse: boolean;
    target: number;
    tolerance: number;
    showSchool: boolean;
    showMembers: boolean;
    showTitle: boolean;
    theme: keyof typeof ceremonyThemes;
    header: number;
    footer: number;
}
export const ceremonyDefaults: CeremonyConfig = { source: 'current', boards: ['all'], reverse: false, target: 6, tolerance: 2,
    showSchool: true, showMembers: false, showTitle: true, theme: 'gala', header: 4, footer: 4 };

export function ceremonyConfig(raw: Partial<CeremonyConfig> = {}): CeremonyConfig {
    const val = { ...ceremonyDefaults, ...raw };
    const integer = (n: number, min: number, max: number) => Number.isInteger(n) && n >= min && n <= max;
    if (typeof val.source !== 'string' || !val.source || val.source.length > 256 || !Array.isArray(val.boards)
        || val.boards.some(id => typeof id !== 'string' || !id || id.length > 160)
        || !Object.hasOwn(ceremonyThemes, val.theme) || !integer(val.target, 1, 16) || !integer(val.tolerance, 0, 4)
        || !integer(val.header, 0, 25) || !integer(val.footer, 0, 25)
        || [val.reverse, val.showSchool, val.showMembers, val.showTitle].some(v => typeof v !== 'boolean')) throw new Error('颁奖幻灯片设置无效');
    return { source: val.source, boards: [...new Set(val.boards)], theme: val.theme, reverse: val.reverse, target: val.target,
        tolerance: val.tolerance, header: val.header, footer: val.footer, showSchool: val.showSchool, showMembers: val.showMembers, showTitle: val.showTitle };
}

/** Choose the nearest feasible page count, then distribute the remainder one per page. */
export function paginate<T>(items: T[], target: number, tolerance: number): T[][] {
    if (!items.length) return [];
    const n = items.length;
    const minPages = Math.ceil(n / (target + tolerance));
    const maxPages = Math.max(1, Math.floor(n / Math.max(1, target - tolerance)));
    const nearest = Math.max(1, Math.round(n / target));
    const pages = minPages <= maxPages ? Math.max(minPages, Math.min(maxPages, nearest)) : nearest;
    const base = Math.floor(n / pages);
    let offset = 0;
    return Array.from({ length: pages }, (_, i) => {
        const start = offset;
        offset += base + Number(i < n % pages);
        return items.slice(start, offset);
    });
}
interface Recipient { name: string; school: string; members: string[]; logo: string }
export interface CeremonySlide { board: string; award: string; teams: Recipient[]; columns: number; part: number; parts: number }
const order = (a: ResultBoard['awards'][number]) => {
    if (a.kind === 'trophy') return 5;
    if (a.kind === 'medal') return a.id.includes('bronze') ? 2 : a.id.includes('silver') ? 3 : 4;
    return a.kind === 'first' ? 1 : 0;
};

export function ceremonySlides(source: ResultsData, config: CeremonyConfig, logos: Record<string, string>) {
    const boards = boardOptions(source);
    const slides: CeremonySlide[] = [];
    for (const id of config.boards) {
        const board = boards.find(item => item.id === id);
        if (!board) continue;
        const results = resultBoard(source, id);
        const rows = new Map(results.rows.map(team => [team.id, team]));
        const awards = [...results.awards].sort((a, b) => order(a) - order(b));
        if (config.reverse) awards.reverse();
        for (const award of awards) {
            const winners = award.teamIds.flatMap(teamId => {
                const team = rows.get(teamId);
                if (!team) return [];
                const school = config.showSchool ? team.school : '';
                const logo = logos[school.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')];
                return [{ name: team.name, school, members: config.showMembers ? team.members : [],
                    logo: /^[a-f0-9]{12}$/.test(logo || '') ? `/hydro-resolver/logos/${logo}.webp` : '' }];
            });
            const pages = paginate(winners, config.target, config.tolerance);
            pages.forEach((teams, i) => {
                const long = teams.some(t => Math.max(t.name.length, t.school.length, t.members.join('、').length) > 16);
                const columns = teams.length <= (long ? 3 : 2) ? 1 : teams.length > (long ? 10 : 6) ? 3 : 2;
                slides.push({ board: board.name, award: award.name, teams, columns, part: i + 1, parts: pages.length });
            });
        }
    }
    return { title: source.data.contest.contest_name, boards, slides };
}
