/**
 * 颁奖台本: the order a resolver session reveals its awards in (from the last awarded team up), with whom to
 * invite to the staging area and whom to call on stage, as the 2026 ICPC World Finals Rules describe the
 * ceremony. Awards that come with a team's reveal (最快解题奖, special awards) are announced where it is resolved.
 */
import type { ResolverPayload } from './resolver-types';
import { computeCells } from '../resolver/server/lib/engine.js';

interface GameAward { id: string; citation: string; teamIds: string[]; awardType?: string }
export interface ScriptTeam { id: string; name: string; school: string; rank: number | null; extras: string[] }
export interface ScriptSegment {
    /** stage: medals and trophies, invited to the staging area as they are resolved and presented together;
     *  announce: a tier read out as the resolver reaches it (Honors); special: awards that come with one team. */
    kind: 'stage' | 'announce' | 'special';
    citation: string;
    teams: ScriptTeam[];
}

// Least to most prestigious: the order tiers are reached when revealing from the bottom.
const tierOrder = (award: GameAward) => {
    const id = award.id;
    if (id === 'honors') return 1;
    if (id === 'high-honors') return 2;
    if (id === 'highest-honors') return 3;
    if (award.awardType === 'medal' || /^medal-|-medal$/.test(id)) return /bronze/.test(id) ? 4 : /silver/.test(id) ? 5 : 6;
    if (/^podium-|^rank-|^winner$/.test(id) || award.awardType === 'winner' || award.awardType === 'rank') return 7;
    return 0;
};
const stageTier = (order: number) => order >= 3;

export function ceremonyScript(payload: Pick<ResolverPayload, 'snapshot' | 'game' | 'config'>) {
    const { snapshot } = payload;
    const awards = (payload.game.contest.awards || []) as GameAward[];
    const { standings } = computeCells(snapshot, { frozen: false });
    const teams = new Map(snapshot.teams.map((team) => [team.id, team]));
    const byTeam = new Map<string, GameAward[]>();
    for (const award of awards) for (const id of award.teamIds || []) byTeam.set(id, [...byTeam.get(id) || [], award]);
    const segments: ScriptSegment[] = [];
    // Bottom up, as the resolver reveals.
    for (const row of [...standings].reverse()) {
        const own = byTeam.get(row.teamId);
        if (!own?.length) continue;
        const team = teams.get(row.teamId)!;
        const best = own.reduce((top, award) => (tierOrder(award) > tierOrder(top) ? award : top));
        const order = tierOrder(best);
        const entry: ScriptTeam = {
            id: row.teamId, name: team.name, school: team.organizationName, rank: row.unrank ? null : row.rank,
            extras: own.filter((award) => award !== best).map((award) => award.citation),
        };
        if (!order) {
            segments.push({ kind: 'special', citation: own.map((award) => award.citation).join('、'), teams: [{ ...entry, extras: [] }] });
            continue;
        }
        const last = segments.at(-1);
        if (last && last.kind !== 'special' && last.citation === best.citation) last.teams.push(entry);
        else segments.push({ kind: stageTier(order) ? 'stage' : 'announce', citation: best.citation, teams: [entry] });
    }
    return { title: snapshot.name, rehearsal: payload.config.rehearsal, segments };
}
