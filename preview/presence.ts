import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Environment } from 'nunjucks';
import type { BoardData } from '../lib/board';
import { applyBeat, type PresenceDoc, presenceSnapshot, type PresenceTeam } from '../lib/presence';
import { resolverCodeBase } from '../lib/resolver-data';
import { toScriptJson } from '../lib/settings';

const chrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const oldChrome = 'Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.130 Safari/537.36';

/**
 * Local preview of 机位监控 (lib/presence-routes.ts): three rooms of computers whose reports are
 * made up relative to the clock, with one of each problem the monitor looks for. `?phase=before`
 * shows the check-in before the start.
 */
export function createPresencePreview(env: Environment, version: string, demo: () => BoardData) {
    const codeBase = resolverCodeBase(version);
    const base = '/contest/demo';
    const data = demo();
    const rooms = ['A', 'B', 'C'];
    const teams: PresenceTeam[] = Array.from({ length: 36 }, (_, index) => {
        const source = data.teams[index % data.teams.length];
        const seat = `${rooms[Math.floor(index / 12)]}-${String((index % 12) + 1).padStart(2, '0')}`;
        return {
            uid: 1000 + index, name: index < data.teams.length ? source.name : `${source.name} ${Math.floor(index / data.teams.length) + 1}`, seat,
            members: [`队员 ${index * 3 + 1}`, `队员 ${index * 3 + 2}`, `队员 ${index * 3 + 3}`],
            mapped: index === 30 ? [] : [`10.${Math.floor(index / 12) + 1}.0.${(index % 12) + 11}`],
            capture: [5, 8, 17, 35].includes(index) || index % 7 === 3 ? 'disconnected' : index === 11 ? 'connected' : 'recording',
        };
    });
    // Without a seat: listed apart.
    teams.push({ uid: 1100, name: '临时加入的队伍', seat: '', members: [], mapped: [], capture: 'disconnected' });

    function docs(now: number, before: boolean) {
        const list: PresenceDoc[] = [];
        teams.forEach((team, index) => {
            if (index === 35 || (before && index % 7 === 3) || team.uid === 1100) return;
            // B-03 sits on B-02's computer; B-09 is on an address no seat has; C-03 changed computers.
            const ip = index === 14 ? '10.2.0.12' : index === 20 ? '10.2.0.99' : team.mapped[0] || '10.3.0.200';
            let doc: PresenceDoc | null = null;
            const beat = (at: number, address = ip, ua = chrome) => {
                doc = applyBeat(doc, { contest: 'system/demo', uid: team.uid, member: team.uid, ip: address, ua }, new Date(at)) || doc;
            };
            beat(now - 50 * 60_000 - index * 7_000);
            if (index === 26) beat(now - 6 * 60_000, '10.3.0.250');
            const lastSeen = index === 5 ? now - 70_000 : index === 17 ? now - 7 * 60_000 : now - (index % 4) * 4_000 - 1_000;
            beat(lastSeen, ip, index === 29 ? oldChrome : chrome);
            if (!doc) return;
            const record = doc as PresenceDoc;
            list.push(record);
        });
        return list;
    }

    return async (_request: IncomingMessage, response: ServerResponse, url: URL) => {
        const before = url.searchParams.get('phase') === 'before';
        const query = before ? '?phase=before' : '';
        if (url.pathname === `${base}/presence`) {
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(env.render('xcpcio_presence.html', {
                codeBase, tdoc: { title: data.contest.contest_name },
                runtimeJson: toScriptJson({ dataUrl: `${base}/presence/data${query}`, contestUrl: base, title: data.contest.contest_name, seatsUrl: '/manage/xcpcio-users#seats', refreshMs: 5000 }),
            }));
            return true;
        }
        if (url.pathname !== `${base}/presence/data`) return false;
        const now = Date.now();
        const times = before ? { beginAt: new Date(now + 25 * 60_000), endAt: new Date(now + 5.4 * 3600_000) } : { beginAt: new Date(now - 2 * 3600_000), endAt: new Date(now + 3 * 3600_000) };
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(presenceSnapshot(teams, docs(now, before), times, now)));
        return true;
    };
}
