import { describe, expect, it } from 'vitest';
import { applyBeat, browserOf, OFFLINE_MS, type PresenceDoc, presenceSnapshot, type PresenceTeam, stateOf, WEAK_MS } from '../lib/presence';

const chrome = (version: number) => `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.0.0 Safari/537.36`;
const beat = (ip: string, visible = true, uid = 7) => ({ contest: 'system/c', uid, member: uid, ip, ua: chrome(131), visible });

describe('reports', () => {
    it('keeps the first sight, the addresses and deduplicates heartbeats across tabs', () => {
        const start = new Date('2026-11-23T08:00:00Z');
        const at = (seconds: number) => new Date(start.getTime() + seconds * 1000);
        let doc = applyBeat(null, beat('10.0.0.1'), start)!;
        expect(doc).toMatchObject({ _id: 'system/c/7', firstSeen: start, ips: [{ ip: '10.0.0.1', first: start, last: start }] });
        // Nothing new within a few seconds: no write.
        expect(applyBeat(doc, beat('10.0.0.1'), at(5))).toBeNull();
        expect(applyBeat(doc, beat('10.0.0.1', false), at(5))).toBeNull();
        doc = applyBeat(doc, beat('10.0.0.1', false), at(25))!;
        expect(doc).not.toHaveProperty('hiddenAt');
        doc = applyBeat(doc, beat('10.0.0.9'), at(45))!;
        expect(doc).toMatchObject({ ip: '10.0.0.9', firstSeen: start });
        expect(doc.ips.map((entry) => entry.ip)).toEqual(['10.0.0.1', '10.0.0.9']);
        // Back to the first address: it moves to the end, keeping when it was first used.
        doc = applyBeat(doc, beat('10.0.0.1'), at(65))!;
        expect(doc.ips).toEqual([{ ip: '10.0.0.9', first: at(45), last: at(45) }, { ip: '10.0.0.1', first: start, last: at(65) }]);
        for (let i = 0; i < 12; i++) doc = applyBeat(doc, beat(`10.1.0.${i}`), at(100 + i * 20))!;
        expect(doc.ips).toHaveLength(8);
    });

    it('tells the browser and whether it is too old', () => {
        expect(browserOf(chrome(131))).toEqual({ name: 'Chrome', version: 131, old: false });
        expect(browserOf(chrome(79))).toEqual({ name: 'Chrome', version: 79, old: true });
        expect(browserOf(`${chrome(120)} Edg/120.0.2210.91`)).toMatchObject({ name: 'Edge', version: 120 });
        expect(browserOf('Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0')).toMatchObject({ name: 'Firefox', version: 128, old: false });
        expect(browserOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1 Safari/605.1.15')).toMatchObject({ name: 'Safari', version: 13, old: true });
        expect(browserOf('Mozilla/5.0 (Windows NT 6.1; Trident/7.0; rv:11.0) like Gecko')).toMatchObject({ name: 'Internet Explorer', old: true });
        expect(browserOf('curl/8.0')).toEqual({ name: '', version: 0, old: false });
    });

    it('turns the last report into a state', () => {
        const now = 1_000_000;
        expect(stateOf(null, now)).toBe('never');
        expect(stateOf({ lastSeen: new Date(now - 1000) }, now)).toBe('online');
        expect(stateOf({ lastSeen: new Date(now - 1000) }, now)).toBe('online');
        expect(stateOf({ lastSeen: new Date(now - WEAK_MS) }, now)).toBe('weak');
        expect(stateOf({ lastSeen: new Date(now - OFFLINE_MS) }, now)).toBe('offline');
    });
});

describe('monitor snapshot', () => {
    const now = new Date('2026-11-23T10:00:00Z').getTime();
    const running = { beginAt: new Date(now - 3600_000), endAt: new Date(now + 3600_000) };
    const team = (uid: number, seat: string, extra: Partial<PresenceTeam> = {}): PresenceTeam => ({ uid, name: `队伍 ${uid}`, seat, members: [], mapped: [], capture: null, ...extra });
    const seen = (uid: number, ip: string, ago: number, extra: Partial<PresenceDoc> = {}): PresenceDoc => ({
        _id: `c/${uid}`, contest: 'c', uid, member: uid, firstSeen: new Date(now - 7200_000), lastSeen: new Date(now - ago), ip,
        ips: [{ ip, first: new Date(now - 7200_000), last: new Date(now - ago) }], ua: chrome(131), ...extra,
    });
    const teams = [
        team(1, 'A-1', { mapped: ['10.0.0.1'] }), team(2, 'A-2', { mapped: ['10.0.0.2'] }), team(3, 'A-10', { mapped: ['10.0.0.3'] }),
        team(4, 'B-1', { mapped: ['10.0.1.1'], capture: 'disconnected' }), team(5, 'B-2'), team(6, ''),
    ];
    const docs = [
        seen(1, '10.0.0.1', 1000),
        // Team 2 works at team 3's computer.
        seen(2, '10.0.0.3', 2000), seen(3, '10.0.0.3', 3000),
        seen(4, '10.0.1.1', 5 * 60_000),
        seen(5, '10.0.1.2', 1000, { ua: chrome(70), ips: [{ ip: '10.0.1.9', first: new Date(now - 600_000), last: new Date(now - 300_000) }, { ip: '10.0.1.2', first: new Date(now - 300_000), last: new Date(now - 1000) }] }),
    ];

    it('finds swapped seats, wrong addresses, silence and old browsers while the contest runs', () => {
        const snapshot = presenceSnapshot(teams, docs, running, now);
        expect(snapshot.phase).toBe('running');
        expect(snapshot.counts).toEqual({ online: 4, weak: 0, offline: 1, never: 1 });
        expect(snapshot.alerts.map((alert) => `${alert.kind}:${alert.uid}`)).toEqual([
            'sharedIp:2', 'sharedIp:3', 'ipMismatch:2', 'offline:4', 'never:6', 'multiIp:5', 'oldBrowser:5',
        ]);
        expect(snapshot.alerts[0].text).toBe('与 A-10 同一 IP 10.0.0.3');
        expect(snapshot.alerts.find((alert) => alert.kind === 'offline')!.since).toBe(now - 5 * 60_000);
        // Rooms in order, seats naturally, the teams without a seat last.
        expect(snapshot.zones.map((zone) => [zone.zone, zone.teams.map((row) => row.seat)])).toEqual([['A', ['A-1', 'A-2', 'A-10']], ['B', ['B-1', 'B-2']], [null, ['']]]);
        expect(snapshot.zones[0].teams[1].alerts).toEqual(['sharedIp', 'ipMismatch']);
    });

    it('keeps an independently recording device online after the contest tab closes', () => {
        const snapshot = presenceSnapshot([team(1, 'A-1', { capture: 'recording' }), team(2, 'A-2', { capture: 'connected' })], [], running, now);
        expect(snapshot.counts.online).toBe(2);
        expect(snapshot.alerts.map(({ uid, text }) => [uid, text])).toEqual([[2, '已连接未采集屏幕']]);
    });

    it('reports a missing capture only for a computer that is on', () => {
        const snapshot = presenceSnapshot([team(4, 'B-1', { capture: 'disconnected' })], [seen(4, '10.0.1.1', 1000)], running, now);
        expect(snapshot.alerts.map((alert) => alert.kind)).toEqual(['noCapture']);
        expect(snapshot.capture).toBe(true);
    });

    it('is a check-in list before the start', () => {
        const before = { beginAt: new Date(now + 1800_000), endAt: new Date(now + 6 * 3600_000) };
        const snapshot = presenceSnapshot(teams, docs, before, now);
        expect(snapshot.phase).toBe('before');
        expect(snapshot.checkedIn).toBe(5);
        // Not signed in yet, or quiet, is no alarm before the start.
        expect(snapshot.alerts.some((alert) => alert.kind === 'offline' || alert.kind === 'never' || alert.kind === 'noCapture')).toBe(false);
        expect(presenceSnapshot(teams, docs, { beginAt: new Date(now - 7200_000), endAt: new Date(now - 1) }, now).phase).toBe('ended');
    });
});
