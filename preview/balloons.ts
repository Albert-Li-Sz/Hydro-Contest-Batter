import { timeZone } from '../lib/time-zone';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Environment } from 'nunjucks';
import type { BoardData } from '../lib/board';
import {
    BalloonError, dueBalloons, firstBalloons, normalizeBalloonSettings, pickTarget, problemColors, reconcile, STATUS_ACCEPTED,
    testTicketLines, ticketLines, ticketReady, ticketTargets, zoneOf, type BalloonSettings, type ReceiptConfig, type ReceiptPrinter, type StoredBalloon,
} from '../lib/balloons';
import { gbkAvailable, receiptJob } from '../lib/escpos';
import { resolverCodeBase } from '../lib/resolver-data';
import { toScriptJson } from '../lib/settings';

const WRONG = 2;
const hex = (value: number, width: number) => value.toString(16).padStart(width, '0');

/**
 * Local preview of 气球配送 (lib/balloon-routes.ts), in memory: the demo teams sit in two rooms
 * (A and B), the contest runs now, and a team solves something new every 15 seconds, so balloons
 * appear, and tickets print on the receipt printers of the print servers preview.
 */
export function createBalloonsPreview(env: Environment, version: string, demo: () => BoardData, receiptPrinters: () => ReceiptPrinter[]) {
    const codeBase = resolverCodeBase(version);
    const base = '/contest/demo';
    const contestKey = 'system/6740a0000000000000000001';
    const data = demo();
    const beginAt = new Date(Date.now() - 2 * 3600_000);
    const endAt = new Date(beginAt.getTime() + 5 * 3600_000);
    const lockAt = new Date(endAt.getTime() - 3600_000);
    const pids = [1001, 1002, 1003];
    const tdoc = { pids, beginAt, endAt };
    const hydroColors: Record<number, { color: string; name: string }> = {
        1001: { color: '#e8794c', name: 'orange' }, 1002: { color: '#3b82f6', name: '蓝' }, 1003: { color: '#a855f7', name: 'purple' },
    };
    const titles: Record<number, string> = { 1001: '签到', 1002: '括号序列', 1003: '最短路' };
    const teams = new Map(data.teams.map((team, index) => [Number(team.team_id), {
        name: team.name, school: team.organization || '', members: [] as string[], unofficial: team.group.includes('unofficial'),
        seat: index < 4 ? `A-${String(index + 1).padStart(2, '0')}` : `B-${String(index - 3).padStart(2, '0')}`,
    }]));
    let serial = 0;
    const rid = (at: number) => `${hex(Math.floor(at / 1000), 8)}${hex(++serial, 16)}`;
    const journals = new Map<number, { rid: string; pid: number; status: number }[]>([...teams.keys()].map((uid) => [uid, []]));
    for (const submission of data.submissions) {
        // The demo's accepts, early in this contest (a wrong answer before every other one).
        const at = beginAt.getTime() + submission.timestamp;
        const journal = journals.get(Number(submission.team_id))!;
        if (journal.length % 2 === 1) journal.push({ rid: rid(at - 120_000), pid: pids[submission.problem_id], status: WRONG });
        journal.push({ rid: rid(at), pid: pids[submission.problem_id], status: STATUS_ACCEPTED });
    }
    const doc = { settings: normalizeBalloonSettings({}, pids) as BalloonSettings, token: 'desk00000000000000000000000000000000', revision: 1, seq: 0 };
    const balloons: StoredBalloon[] = [];
    let objectSerial = 0;
    const bump = () => { doc.revision++; };

    function sync() {
        if (!doc.settings.enabled) return;
        const due = dueBalloons(contestKey, tdoc, [...journals].map(([uid, journal]) => ({ uid, journal })));
        const { inserts, updates } = reconcile(balloons, due, {
            now: Date.now(), lockAt: lockAt.getTime(), locked: Date.now() > lockAt.getTime(), hold: doc.settings.afterFreeze !== 'continue', encourage: doc.settings.afterFreeze === 'encourage' ? doc.settings.encourageCount : undefined,
            tickets: doc.settings.tickets.enabled, hydroSent: new Set(),
        });
        for (const balloon of inserts) balloons.push({ ...balloon, id: `6750a${hex(++objectSerial, 19)}`, seq: ++doc.seq });
        for (const update of updates) Object.assign(balloons.find((balloon) => balloon.id === update.id)!, update.set);
        if (inserts.length || updates.length) bump();
    }
    // Someone solves something new now and then (judged at once).
    const timer = setInterval(() => {
        const open = [...journals].flatMap(([uid, journal]) => pids.filter((pid) => !journal.some((record) => record.pid === pid && record.status === STATUS_ACCEPTED)).map((pid) => [uid, pid] as const));
        if (!open.length) return;
        const [uid, pid] = open[Math.floor(Math.random() * open.length)];
        journals.get(uid)!.push({ rid: rid(Date.now()), pid, status: STATUS_ACCEPTED });
        sync();
    }, 15_000);
    timer.unref();

    const colors = () => problemColors(doc.settings, pids, hydroColors as unknown as Record<string, unknown>);
    const labels = ['A', 'B', 'C'];

    function view(manager: boolean) {
        const first = firstBalloons(balloons, (uid) => !teams.get(uid)?.unofficial);
        const printers = manager ? receiptPrinters() : [];
        const names = new Map(printers.map((printer) => [printer.server, printer.serverName]));
        return {
            revision: doc.revision,
            contest: { title: data.contest.contest_name, beginAt, endAt, lockAt, locked: Date.now() > lockAt.getTime(), ended: false },
            enabled: doc.settings.enabled, tickets: doc.settings.tickets.enabled, afterFreeze: doc.settings.afterFreeze, encourageCount: doc.settings.encourageCount,
            problems: pids.map((pid, index) => ({ pid, label: labels[index], title: titles[pid], color: colors()[index] })),
            teams: [...teams].map(([uid, team]) => ({ uid, name: team.name, school: team.school, seat: team.seat, zone: zoneOf(team.seat), unofficial: team.unofficial })),
            balloons: balloons.map((balloon) => ({
                id: balloon.id, uid: balloon.uid, pid: balloon.pid, seq: balloon.seq, at: new Date(balloon.submittedAt), state: balloon.state, held: balloon.held,
                first: first.has(balloon.key), delivered: balloon.delivered ? { at: new Date(balloon.delivered.at), by: balloon.delivered.by } : null,
                ticket: { status: balloon.ticket.status, printer: balloon.ticket.printer || '', server: names.get(balloon.ticket.server || '') || '', error: balloon.ticket.error || '', prints: balloon.ticket.prints },
            })),
            ...manager ? {
                settings: doc.settings, deskUrl: `${base}/balloon-desk/${doc.token}`, gbk: gbkAvailable(), contestKey,
                hydroColors: pids.map((pid) => hydroColors[pid]),
                printers: printers.map((printer) => ({ ...printer, online: printer.usable || (printer as { online?: boolean }).online === true,
                    capable: (printer as { capable?: boolean }).capable !== false, status: (printer as { status?: string }).status || 'idle' })),
            } : {},
        };
    }

    function operate(name: string, payload: Record<string, any>, manager: boolean) {
        const ids = new Set((Array.isArray(payload.ids) ? payload.ids : []).map(String));
        switch (name) {
        case 'enable':
            if (!manager) break;
            doc.settings = normalizeBalloonSettings({ enabled: payload.enabled === true }, pids, doc.settings);
            bump(); sync();
            return { ok: true };
        case 'settings': {
            if (!manager) break;
            const before = doc.settings;
            doc.settings = normalizeBalloonSettings(payload.settings, pids, doc.settings);
            if (before.tickets.enabled && !doc.settings.tickets.enabled) for (const balloon of balloons) if (balloon.ticket.status === 'pending') balloon.ticket.status = 'none';
            bump(); sync();
            return { settings: doc.settings };
        }
        case 'deliver': {
            if (!ids.size) throw new BalloonError('请选择气球');
            const by = manager ? 'admin' : `${String(payload.by || '').trim().slice(0, 20) || '配送员'}（配送员链接）`;
            let updated = 0;
            for (const balloon of balloons) {
                if (!ids.has(balloon.id)) continue;
                updated++;
                if (payload.undo === true) balloon.delivered = null;
                else {
                    balloon.delivered ??= { at: Date.now(), by };
                    if (balloon.ticket.status === 'pending') balloon.ticket.status = 'none';
                }
            }
            bump();
            return { updated };
        }
        case 'reprint': {
            if (!doc.settings.tickets.enabled) throw new BalloonError('请先在设置中开启小票打印');
            if (!manager && payload.all === true) throw new BalloonError('配送员链接只能补打所选气球的小票', 403);
            let updated = 0;
            for (const balloon of balloons) {
                if (balloon.state !== 'active' || balloon.delivered || balloon.ticket.status === 'printing') continue;
                if (payload.all === true ? !['none', 'failed'].includes(balloon.ticket.status) : !ids.has(balloon.id)) continue;
                balloon.ticket = { ...balloon.ticket, status: 'pending', attempts: 0, error: undefined, server: undefined };
                updated++;
            }
            bump();
            return { updated };
        }
        case 'resetToken':
            if (!manager) break;
            doc.token = `desk${Date.now().toString(16).padStart(32, '0')}`;
            bump();
            return { deskUrl: `${base}/balloon-desk/${doc.token}` };
        default:
        }
        throw new BalloonError('未知操作', 404);
    }

    const receipts = {
        async claim(serverId: string, now: number, limit = 10) {
            sync();
            const printers = receiptPrinters();
            if (!doc.settings.enabled || !doc.settings.tickets.enabled || !printers.some((printer) => printer.server === serverId && printer.usable)) return [];
            const first = firstBalloons(balloons, (uid) => !teams.get(uid)?.unofficial);
            const jobs = [];
            for (const balloon of [...balloons].sort((a, b) => a.seq - b.seq)) {
                if (jobs.length >= limit) break;
                if (!ticketReady(balloon)) continue;
                const team = teams.get(balloon.uid)!;
                const target = pickTarget(balloon.id, ticketTargets(balloon, team.seat, contestKey, doc.settings.tickets.rules, printers).printers);
                if (!target || target.server !== serverId) continue;
                balloon.ticket = { ...balloon.ticket, status: 'printing', server: serverId, printer: target.printer, claimedAt: now };
                const index = pids.indexOf(balloon.pid);
                const solved = balloons.filter((other) => other.uid === balloon.uid && other.state === 'active').map((other) => labels[pids.indexOf(other.pid)]).sort();
                jobs.push(receiptJob(`balloon-${balloon.id}`, `气球 #${balloon.seq} · ${team.seat} · ${labels[index]}`, target.printer, ticketLines({
                    contest: data.contest.contest_name, seq: balloon.seq, seat: team.seat, label: labels[index], problemTitle: titles[balloon.pid], color: colors()[index],
                    first: first.has(balloon.key), team: team.name, school: team.school, members: team.members, unofficial: team.unofficial,
                    submittedAt: balloon.submittedAt, beginAt: beginAt.getTime(), solved, printedAt: now, copy: balloon.ticket.prints + 1,
                }, doc.settings.tickets), target.config));
            }
            if (jobs.length) bump();
            return jobs;
        },
        async report(id: string, serverId: string, status: 'printed' | 'failed' | 'released', printer: string, message: string) {
            const balloon = balloons.find((candidate) => `balloon-${candidate.id}` === id && candidate.ticket.server === serverId && candidate.ticket.status === 'printing');
            if (!balloon) return false;
            if (status === 'released') balloon.ticket = { ...balloon.ticket, status: 'pending', server: undefined };
            else if (status === 'printed') balloon.ticket = { ...balloon.ticket, status: 'printed', printer: printer || balloon.ticket.printer, printedAt: Date.now(), prints: balloon.ticket.prints + 1, error: undefined, attempts: 0 };
            else {
                const attempts = balloon.ticket.attempts + 1;
                balloon.ticket = { ...balloon.ticket, status: attempts < 3 ? 'pending' : 'failed', attempts, error: message, ...attempts < 3 ? { server: undefined } : {} };
            }
            bump();
            return true;
        },
        testJob(id: string, serverName: string, printer: string, config: ReceiptConfig) {
            return receiptJob(id, `测试小票 · ${serverName}`, printer, testTicketLines(serverName, printer, config), config);
        },
        /** Tickets each printer printed, for the print servers page. */
        printed(server: string, printer: string) {
            return balloons.filter((balloon) => balloon.ticket.server === server && balloon.ticket.printer === printer).reduce((sum, balloon) => sum + balloon.ticket.prints, 0);
        },
    };

    const handle = async (request: IncomingMessage, response: ServerResponse, url: URL) => {
        const manage = new RegExp(`^${base}/balloons(/data)?$`).exec(url.pathname);
        const desk = new RegExp(`^${base}/balloon-desk/([^/]+)(/data)?$`).exec(url.pathname);
        if (!manage && !desk) return false;
        const json = (value: unknown, status = 200) => response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(value));
        try {
            if (desk && (desk[1] !== doc.token)) { response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('气球配送链接无效或已作废'); return true; }
            if (desk && !doc.settings.enabled) throw new BalloonError('这场比赛的气球配送尚未开启', 403);
            const manager = !!manage;
            const dataPath = manager ? manage![1] : desk![2];
            if (request.method === 'POST') {
                let text = '';
                for await (const chunk of request) text += chunk;
                const body = JSON.parse(text || '{}');
                json(operate(String(body.operation || ''), JSON.parse(body.payload || '{}'), manager));
                return true;
            }
            if (dataPath) {
                sync();
                const rev = Number(url.searchParams.get('rev'));
                json(rev === doc.revision ? { revision: doc.revision, unchanged: true } : view(manager));
                return true;
            }
            const pageBase = manager ? `${base}/balloons` : `${base}/balloon-desk/${doc.token}`;
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(env.render('xcpcio_balloons.html', {
                codeBase, tdoc: { title: data.contest.contest_name }, desk: !manager,
                runtimeJson: toScriptJson({ timeZone: timeZone(),
                    mode: manager ? 'manager' : 'desk', base: pageBase, dataUrl: `${pageBase}/data`, contestUrl: `${base}/scoreboard/xcpcio-plus`,
                    printersUrl: '/manage/xcpcio-printers', title: data.contest.contest_name,
                }),
            }));
        } catch (error) {
            json({ error: error instanceof Error ? error.message : '请求无效' }, error instanceof BalloonError ? error.status : 400);
        }
        return true;
    };
    return { handle, receipts, settings: { get: () => doc.settings, save: (settings: object) => operate('settings', { settings }, true) } };
}
