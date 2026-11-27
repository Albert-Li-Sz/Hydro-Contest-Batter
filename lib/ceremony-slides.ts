import { boardOptions, resultBoard, type ResultBoard, type ResultsData } from './results';
import { awardsFor } from './settings';

export const ceremonyThemes = {
    gala: '深色典礼', red: '红金', blue: '海蓝', celadon: '青瓷', night: '星夜', ink: '墨金', light: '浅色', mist: '晨雾',
};
type Zones = [boolean, boolean, boolean];
export interface CeremonyConfig {
    source: string;
    boards: string[];
    reverse: boolean;
    /** Teams within one award: by rank, or from the last rank up. */
    withinOrder: 'rank' | 'reverse';
    target: number;
    tolerance: number;
    /** 0 chooses the column count by measuring the names. */
    columns: number;
    cover: boolean;
    showSchool: boolean;
    showMembers: boolean;
    showTitle: boolean;
    theme: keyof typeof ceremonyThemes;
    /** Height of the header and footer bands, in percent of the slide, kept clear in the chosen thirds. */
    header: number;
    footer: number;
    headerZones: Zones;
    footerZones: Zones;
}
export const ceremonyDefaults: CeremonyConfig = {
    source: 'current', boards: ['all'], reverse: false, withinOrder: 'rank', target: 6, tolerance: 2, columns: 0, cover: true,
    showSchool: true, showMembers: false, showTitle: true, theme: 'gala', header: 12, footer: 8,
    headerZones: [false, false, false], footerZones: [false, false, false],
};

export function ceremonyConfig(raw: Partial<CeremonyConfig> = {}): CeremonyConfig {
    const val = { ...ceremonyDefaults, ...raw };
    const integer = (n: number, min: number, max: number) => Number.isInteger(n) && n >= min && n <= max;
    const zones = (z: unknown) => Array.isArray(z) && z.length === 3 && z.every(v => typeof v === 'boolean');
    if (typeof val.source !== 'string' || !val.source || val.source.length > 256 || !Array.isArray(val.boards)
        || val.boards.some(id => typeof id !== 'string' || !id || id.length > 160)
        || !Object.hasOwn(ceremonyThemes, val.theme) || !integer(val.target, 1, 16) || !integer(val.tolerance, 0, 4)
        || !integer(val.header, 0, 25) || !integer(val.footer, 0, 25) || !integer(val.columns, 0, 4)
        || !['rank', 'reverse'].includes(val.withinOrder) || !zones(val.headerZones) || !zones(val.footerZones)
        || [val.reverse, val.showSchool, val.showMembers, val.showTitle, val.cover].some(v => typeof v !== 'boolean')) throw new Error('颁奖幻灯片设置无效');
    return {
        source: val.source, boards: [...new Set(val.boards)], theme: val.theme, reverse: val.reverse, withinOrder: val.withinOrder,
        target: val.target, tolerance: val.tolerance, columns: val.columns, cover: val.cover, header: val.header, footer: val.footer,
        headerZones: [...val.headerZones] as Zones, footerZones: [...val.footerZones] as Zones,
        showSchool: val.showSchool, showMembers: val.showMembers, showTitle: val.showTitle,
    };
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

export type CeremonyTier = 'gold' | 'silver' | 'bronze' | 'trophy' | 'first' | 'special' | 'honors';
/** One line of the list. For school trophies the school leads and the team follows. */
interface Recipient { name: string; school: string; members: string[]; logo: string; rank: number }
export interface CeremonyAwardSlide {
    kind: 'award'; board: string; award: string; tier: CeremonyTier; subtitle: string;
    teams: Recipient[]; columns: number; part: number; parts: number;
}
export interface CeremonyCoverSlide { kind: 'cover' }
export type CeremonySlide = CeremonyAwardSlide | CeremonyCoverSlide;

type Award = ResultBoard['awards'][number];
const honors: Record<string, string> = { 'highest-honors': 'HIGHEST HONORS', 'high-honors': 'HIGH HONORS', honors: 'HONORS' };
export function awardTier(award: Pick<Award, 'id' | 'kind'>): CeremonyTier {
    if (award.kind === 'trophy') return 'trophy';
    if (award.kind === 'first') return 'first';
    if (award.kind === 'medal') return /bronze/.test(award.id) ? 'bronze' : /silver/.test(award.id) ? 'silver' : 'gold';
    return Object.hasOwn(honors, award.id) ? 'honors' : 'special';
}
const places = ['CHAMPION', 'RUNNER-UP', 'THIRD PLACE'];
export function awardSubtitle(award: Pick<Award, 'id' | 'kind'>, podiumIndex: number) {
    const tier = awardTier(award);
    if (tier === 'trophy') return places[podiumIndex] ?? `${podiumIndex + 1}TH PLACE`;
    if (tier === 'honors') return honors[award.id];
    return { gold: 'GOLD MEDAL', silver: 'SILVER MEDAL', bronze: 'BRONZE MEDAL', first: 'FIRST TO SOLVE', special: 'SPECIAL AWARD' }[tier];
}
// Least to most prestigious, the order they are read out.
const order: Record<CeremonyTier, number> = { special: 0, honors: 0, first: 1, bronze: 2, silver: 3, gold: 4, trophy: 5 };

export function ceremonySlides(source: ResultsData, config: CeremonyConfig, logos: Record<string, string>) {
    const boards = boardOptions(source);
    const slides: CeremonySlide[] = config.cover ? [{ kind: 'cover' }] : [];
    for (const id of config.boards) {
        const board = boards.find(item => item.id === id);
        if (!board) continue;
        const results = resultBoard(source, id);
        const bySchool = awardsFor(source.settings, id).podiumBasis === 'school';
        const rows = new Map(results.rows.map(team => [team.id, team]));
        const trophies = results.awards.filter(a => a.kind === 'trophy');
        const awards = [...results.awards].sort((a, b) => order[awardTier(a)] - order[awardTier(b)]);
        if (config.reverse) awards.reverse();
        for (const award of awards) {
            const tier = awardTier(award);
            const schoolFirst = tier === 'trophy' && bySchool;
            const winners = award.teamIds.flatMap(teamId => {
                const team = rows.get(teamId);
                if (!team) return [];
                const school = config.showSchool || schoolFirst ? team.school : '';
                const logo = logos[school.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')];
                return [{
                    name: schoolFirst ? team.school || team.name : team.name, school: schoolFirst ? team.name : school,
                    members: config.showMembers ? team.members : [], rank: schoolFirst ? team.schoolRank || team.rank : team.rank,
                    logo: /^[a-f0-9]{12}$/.test(logo || '') ? `/hydro-resolver/logos/${logo}.webp` : '',
                }];
            }).sort((a, b) => (a.rank - b.rank) * (config.withinOrder === 'reverse' ? -1 : 1));
            const pages = paginate(winners, config.target, config.tolerance);
            const subtitle = awardSubtitle(award, trophies.indexOf(award));
            pages.forEach((teams, i) => {
                slides.push({ kind: 'award', board: board.name, award: award.name, tier, subtitle, teams, columns: config.columns, part: i + 1, parts: pages.length });
            });
        }
    }
    return { title: source.data.contest.contest_name, date: source.beginAt, boards, slides };
}
