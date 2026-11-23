import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Environment } from 'nunjucks';
import { resolverCodeBase } from '../lib/resolver-data';
import { toScriptJson } from '../lib/settings';
import { defaultJudgeRule, judgeConfig, judgeHealth, judgePassword, type JudgeRule, judgeScopes, normalizeJudgeRule, checkJudgeName } from '../lib/manage/judges';
import { JudgeTracker } from '../lib/judge-tracker';
import type { MonitorMachine } from '../lib/monitor';
import {
    describeJob, groupByProblem, MAX_REJUDGE, normalizeRejudgeSelection, type RejudgeItem, type RejudgeJob, rejudgeStatuses, summarizeTransitions,
} from '../lib/manage/rejudge';
import {
    type Account, ManageError, normalizeTeamEdit, normalizeUserEdit, PRIV_EDIT_SYSTEM, PRIV_JUDGE, protectedReason, searchPattern, uidList,
} from '../lib/manage/users';
import { createSeatsPreview } from './seats';

/** The preview administrator's password for delete confirmations (local preview only). */
export const previewAdminPassword = 'preview-admin';

interface PreviewUser extends Account { mail: string; displayName: string; school: string; studentId: string; regat: Date; loginat: Date }

/**
 * Local preview of the /manage pages (lib/manage-routes.ts) with in-memory accounts, teams, judges
 * and records, so the pages run without Hydro or MongoDB.
 */
export function createManagePreview(env: Environment, version: string) {
    const codeBase = resolverCodeBase(version);
    const day = 86400_000;
    const now = Date.now();
    const schools = ['南京晓庄学院', '南京邮电大学', '东南大学', '河海大学'];
    const users: PreviewUser[] = [
        { _id: 2, uname: 'admin', priv: -1, mail: 'admin@example.com', displayName: '管理员', school: '', studentId: '', regat: new Date(now - 90 * day), loginat: new Date(now) },
        { _id: 3, uname: 'organizer', priv: PRIV_EDIT_SYSTEM, mail: 'organizer@example.com', displayName: '赛务组', school: '', studentId: '', regat: new Date(now - 60 * day), loginat: new Date(now - day) },
        ...Array.from({ length: 64 }, (_, index): PreviewUser => ({
            _id: 10 + index, uname: `player${String(index + 1).padStart(2, '0')}`, priv: 0, mail: `player${index + 1}@example.com`,
            displayName: `选手 ${index + 1}`, school: schools[index % schools.length], studentId: `2026${String(index + 1).padStart(4, '0')}`,
            regat: new Date(now - (30 - (index % 30)) * day), loginat: new Date(now - index * 3600_000),
        })),
        { _id: 100, uname: 'judge-1', priv: PRIV_JUDGE, mail: 'judge-1@judge.hydro.local', displayName: '', school: '', studentId: '', regat: new Date(now - 10 * day), loginat: new Date(now - 600_000) },
        { _id: 101, uname: 'judge-2', priv: PRIV_JUDGE, mail: 'judge-2@judge.hydro.local', displayName: '', school: '', studentId: '', regat: new Date(now - 10 * day), loginat: new Date(now - 3 * day) },
    ];
    const teams = [
        { _id: -1001, uname: 'team:10:ab12cd', displayName: '星火队', members: [10, 11, 12], invite: [] as number[], regat: new Date(now - 5 * day), contests: 2 },
        { _id: -1002, uname: 'team:13:zz00yy', displayName: '破晓', members: [13, 14], invite: [15], regat: new Date(now - 4 * day), contests: 1 },
        { _id: -1003, uname: 'team:16:qq11ww', displayName: '算法小分队', members: [16, 17, 18], invite: [] as number[], regat: new Date(now - 2 * day), contests: 0 },
    ];
    const rules = new Map<number, JudgeRule>([[100, { ...defaultJudgeRule(), concurrency: 4, note: '机房 A · 8 核' }], [101, { ...defaultJudgeRule(), langs: ['java', 'py3'], scope: 'rejudge', note: '机房 B' }]]);
    const contests = [
        { id: '6740a0000000000000000001', title: '2026 校赛正式赛', rule: 'acm', beginAt: new Date(now - 3 * day), endAt: new Date(now - 3 * day + 5 * 3600_000), pids: [1001, 1002, 1003, 1004, 1005] },
        { id: '6740a0000000000000000002', title: '2026 校赛热身赛', rule: 'acm', beginAt: new Date(now - 4 * day), endAt: new Date(now - 4 * day + 2 * 3600_000), pids: [1101, 1102] },
    ];
    const titles: Record<number, string> = { 1001: '签到题', 1002: '最短路', 1003: '区间合并', 1004: '字符串匹配', 1005: '树上背包', 1101: 'A + B', 1102: '排序', 1201: '次短路', 1202: '最短路计数' };
    const statusCycle = [1, 2, 1, 3, 1, 4, 6, 1, 2, 7, 1, 3];
    const records = contests.flatMap((tdoc, c) => Array.from({ length: c ? 40 : 240 }, (_, index) => ({
        _id: `${c}-${index}`, contest: tdoc.id, pid: tdoc.pids[index % tdoc.pids.length], status: statusCycle[index % statusCycle.length],
    })));
    // Rejudge history: results arrive a few seconds after a run; some move (WA → AC, AC → WA, TLE → AC).
    const jobs: RejudgeJob[] = [];
    const items: (RejudgeItem & { judgeAfter: number })[] = [];
    const outcome = (index: number, before: number) => (index % 7 === 0 && before === 1 ? 2 : index % 5 === 0 && before === 2 ? 1 : index % 4 === 0 && before === 3 ? 1 : before);
    function addJob(job: Omit<RejudgeJob, '_id'>, rows: { _id: string; pid: number; contest: string; status: number }[], delay: number) {
        const id = `6740b${String(jobs.length + 1).padStart(19, '0')}`;
        jobs.unshift({ ...job, _id: id });
        rows.forEach((row, index) => items.push({
            job: id, rid: `6740c${row._id.replace('-', '').padStart(19, '0')}`, domainId: 'system', pid: row.pid, uid: 10 + (index % 60), contest: row.contest,
            before: row.status, beforeScore: row.status === 1 ? 100 : 0, after: null, afterScore: null, judgedAt: null,
            judgeAfter: Date.now() + delay + index * 15,
        }));
    }
    const settle = () => {
        const at = Date.now();
        items.forEach((item, index) => {
            if (item.after !== null || item.judgeAfter > at) return;
            item.after = outcome(index, item.before);
            item.afterScore = item.after === 1 ? 100 : 0;
            item.judgedAt = new Date(item.judgeAfter);
        });
    };
    addJob({ domainId: 'system', scope: 'contest', contest: '6740a0000000000000000002', contestTitle: '2026 校赛热身赛', pids: [], statuses: [2, 3], skipAccepted: true,
        operator: 2, createdAt: new Date(now - 2 * day), finishedAt: new Date(now - 2 * day), total: 0, queued: 0, failed: [] },
    records.filter((record) => record.contest === '6740a0000000000000000002' && [2, 3].includes(record.status)), -day);
    jobs[0].total = jobs[0].queued = items.length;

    const menu = [['manage_dashboard', '控制面板', '#'], ['manage_script', '脚本管理', '#'], ['manage_user_import', '导入用户', '#'],
        ['manage_xcpcio_users', '用户配置', '/manage/xcpcio-users'], ['manage_user_priv', '用户权限', '#'], ['manage_setting', '系统设置', '#'],
        ['manage_config', '配置管理', '#'], ['manage_xcpcio_judges', '评测机控制', '/manage/xcpcio-judges'], ['manage_xcpcio_printers', '打印服务器管理', '/manage/xcpcio-printers'],
        ['manage_xcpcio_rejudge', '批量重测', '/manage/xcpcio-rejudge']];

    // Judge health: the built-in judge of this server, judge-1 connected, judge-2 known only from its last report.
    const tracker = new JudgeTracker('hydro-server');
    tracker.connect('d1', { uname: 'judge-1', ip: '10.0.0.21' });
    tracker.message('d1', { key: 'config', concurrency: 8 });
    const task = (rid: string, lang: string) => ({ rid, domainId: 'system', uid: 10, pid: 1001, lang, contest: null });
    for (let index = 0; index < 6; index++) {
        tracker.taskStart('d1', task(`r${index}`, 'cc'));
        tracker.message('d1', { key: 'end', rid: `r${index}`, status: index === 5 ? 2 : 1, time: 120, memory: 2048 });
    }
    for (let index = 0; index < 3; index++) tracker.taskStart('d1', task(`a${index}`, 'cc'));
    for (let index = 0; index < 4; index++) tracker.builtinFinish(task(`b${index}`, 'py3'), { status: 1, time: 300, memory: 9000 });
    tracker.builtinChange(task('b9', 'java'), 20, 4, null);
    const machinesNow = (at: number): MonitorMachine[] => tracker.snapshot().map((judge): MonitorMachine => ({
        key: judge.id, kind: judge.kind, tracked: judge,
        name: judge.kind === 'builtin' ? `内置评测（${judge.host}）` : 'judge-1',
        metrics: judge.kind === 'builtin'
            ? { cpu: 38, memoryRate: 61, memoryTotal: 16 * 1024 ** 3, temperature: null, cores: 8, model: 'Preview CPU', os: 'Linux', compilers: null, reportedAt: null }
            : { cpu: 72, memoryRate: 44, memoryTotal: 32 * 1024 ** 3, temperature: 63, cores: 16, model: 'Preview CPU', os: 'Linux', compilers: 12, reportedAt: at - 6 * 60_000 },
    })).concat([{ key: 'report:mid-2', kind: 'remote' as const, tracked: null, name: 'judge-2-host',
        metrics: { cpu: 3, memoryRate: 20, memoryTotal: 8 * 1024 ** 3, temperature: 45, cores: 4, model: 'Preview CPU', os: 'Linux', compilers: 10, reportedAt: at - 12 * 60_000 } }]);

    const verify = (password: unknown) => { if (password !== previewAdminPassword) throw new ManageError('管理员密码错误', 403); };
    const person = (uid: number) => {
        const user = users.find((candidate) => candidate._id === uid);
        return { _id: uid, uname: user?.uname ?? null, displayName: user?.displayName || '' };
    };
    const resolve = (names: unknown) => Array.isArray(names) ? names.map((name) => {
        const user = users.find((candidate) => String(candidate._id) === String(name) || candidate.uname.toLowerCase() === String(name).toLowerCase());
        if (!user) throw new ManageError(`账号 ${name} 不存在`);
        return user._id;
    }) : undefined;
    const isJudge = (user: PreviewUser) => user.priv !== -1 && !!(user.priv & PRIV_JUDGE);
    const page = <T>(rows: T[], number: number) => rows.slice((number - 1) * 50, number * 50);

    const seatsPreview = createSeatsPreview(users, teams, contests, (password) => verify(password));

    async function operate(name: string, payload: any) {
        const seatResult = seatsPreview.operate(name, payload);
        if (seatResult !== undefined) return seatResult;
        switch (name) {
        case 'update_user': {
            const user = users.find((candidate) => candidate._id === Number(payload.uid));
            if (!user) throw new ManageError('用户不存在', 404);
            const reason = protectedReason(user, 2, 'edit');
            if (reason) throw new ManageError(reason, 403);
            const edit = normalizeUserEdit(payload.edit);
            const mailChanged = !!edit.mail && edit.mail.toLowerCase() !== user.mail.toLowerCase();
            if ((edit.password || mailChanged) && (user.priv & PRIV_EDIT_SYSTEM)) verify(payload.adminPassword);
            if (edit.mail && users.some((other) => other !== user && other.mail.toLowerCase() === edit.mail!.toLowerCase())) throw new ManageError(`邮箱 ${edit.mail} 已被其他账号使用`);
            Object.assign(user, { ...edit, password: undefined });
            return { ok: true };
        }
        case 'delete_users': {
            const uids = uidList(payload.uids);
            verify(payload.password);
            const deleted: number[] = []; const skipped: string[] = [];
            for (const uid of uids) {
                const user = users.find((candidate) => candidate._id === uid);
                if (!user) continue;
                const reason = protectedReason(user, 2, 'delete');
                if (reason) { skipped.push(reason); continue; }
                users.splice(users.indexOf(user), 1);
                for (const team of teams) { team.members = team.members.filter((id) => id !== uid); team.invite = team.invite.filter((id) => id !== uid); }
                deleted.push(uid);
            }
            return { deleted, skipped, missing: 0 };
        }
        case 'update_team': {
            const team = teams.find((candidate) => candidate._id === Number(payload.uid));
            if (!team) throw new ManageError('队伍不存在', 404);
            const edit = normalizeTeamEdit({ ...payload.edit, members: resolve(payload.edit?.members), invite: resolve(payload.edit?.invite) }, 3);
            if (edit.displayName) team.displayName = edit.displayName;
            if (edit.members) team.members = edit.members;
            if (edit.invite) team.invite = edit.invite;
            return { ok: true, synced: payload.sync !== false ? team.contests : 0, passwords: edit.memberPassword ? team.members.length : 0 };
        }
        case 'delete_teams': {
            const uids = uidList(payload.uids, '队伍', true);
            verify(payload.password);
            const deleted = uids.filter((uid) => teams.some((team) => team._id === uid));
            for (const uid of deleted) teams.splice(teams.findIndex((team) => team._id === uid), 1);
            return { deleted, missing: uids.length - deleted.length };
        }
        case 'create': {
            const uname = checkJudgeName(payload.uname);
            if (users.some((user) => user.uname.toLowerCase() === uname.toLowerCase())) throw new ManageError(`账号 ${uname} 已存在`);
            const uid = Math.max(...users.map((user) => user._id)) + 1;
            users.push({ _id: uid, uname, priv: PRIV_JUDGE, mail: `${uname}@judge.hydro.local`, displayName: '', school: '', studentId: '', regat: new Date(), loginat: new Date(0) });
            rules.set(uid, normalizeJudgeRule({ note: payload.note }));
            return { uid, uname, config: judgeConfig({ serverUrl: `${payload.origin}/`, uname, password: judgePassword() }) };
        }
        case 'copy': {
            const user = users.find((candidate) => candidate._id === Number(payload.uid) && isJudge(candidate));
            if (!user) throw new ManageError('评测机账号不存在', 404);
            return { uname: user.uname, config: judgeConfig({ serverUrl: `${payload.origin}/`, uname: user.uname, password: judgePassword() }) };
        }
        case 'rule': {
            const rule = normalizeJudgeRule(payload.rule);
            rules.set(Number(payload.uid), rule);
            return { rule };
        }
        case 'delete': {
            verify(payload.password);
            const deleted = uidList(payload.uids, '评测机').filter((uid) => users.some((user) => user._id === uid && isJudge(user)));
            for (const uid of deleted) users.splice(users.findIndex((user) => user._id === uid), 1);
            return { deleted, skipped: [] };
        }
        case 'preview':
        case 'run': {
            const selection = normalizeRejudgeSelection(payload);
            const tdoc = contests.find((candidate) => candidate.id === selection.contest);
            if (selection.scope === 'contest' && !tdoc) throw new ManageError('比赛不存在', 404);
            if (name === 'run' && selection.scope === 'domain') verify(payload.password);
            const statuses = selection.statuses.filter((code) => !(selection.skipAccepted && code === 1));
            const matched = records.filter((record) => (!tdoc || record.contest === tdoc.id)
                && (!selection.pids.length || selection.pids.includes(record.pid))
                && (statuses.length ? statuses.includes(record.status) : !(selection.skipAccepted && record.status === 1)));
            const byStatus: Record<string, number> = {};
            for (const record of matched) byStatus[record.status] = (byStatus[record.status] || 0) + 1;
            const label = (pid: number) => (tdoc ? String.fromCharCode(65 + tdoc.pids.indexOf(pid)) : `P${pid}`);
            const summary = { total: matched.length, byStatus, byProblem: [...groupByProblem(matched)].map(([pid, group]) => ({ pid, label: label(pid), title: titles[pid], count: group.length })) };
            if (name !== 'run') return summary;
            addJob({ domainId: 'system', scope: selection.scope, contest: selection.contest, contestTitle: tdoc?.title ?? null, pids: selection.pids,
                statuses: selection.statuses, skipAccepted: selection.skipAccepted, operator: 2, createdAt: new Date(), finishedAt: new Date(),
                total: matched.length, queued: matched.length, failed: [] }, matched, 2000);
            return { ...summary, queued: matched.length, failed: [], job: String(jobs[0]._id) };
        }
        default: throw new ManageError('未知操作');
        }
    }

    function data(pathname: string, query: URLSearchParams) {
        if (pathname === '/manage/xcpcio-users/data') {
            const pattern = searchPattern(query.get('q'));
            const number = Math.max(1, Number(query.get('page')) || 1);
            if (['seats', 'seat-backups', 'seat-backup'].includes(query.get('tab') || '')) return seatsPreview.data(query);
            if (query.get('tab') === 'teams') {
                const rows = teams.filter((team) => !pattern || pattern.test(team.displayName) || pattern.test(team.uname));
                return { total: rows.length, page: number, pageSize: 50, teams: page(rows, number).map((team) => ({ ...team, members: team.members.map(person), invite: team.invite.map(person) })) };
            }
            const rows = users.filter((user) => !pattern || [user.uname, user.mail, user.displayName, user.school, user.studentId, String(user._id)].some((value) => pattern.test(value)));
            return {
                total: rows.length, page: number, pageSize: 50,
                users: page(rows, number).map((user) => ({
                    _id: user._id, uname: user.uname, mail: user.mail, school: user.school, studentId: user.studentId, displayName: user.displayName,
                    regat: user.regat, loginat: user.loginat, judge: isJudge(user), admin: user.priv !== -1 && !!(user.priv & PRIV_EDIT_SYSTEM), locked: protectedReason(user, 2, 'edit'), undeletable: protectedReason(user, 2, 'delete'),
                })),
            };
        }
        if (pathname === '/manage/xcpcio-judges/data') {
            const health = judgeHealth(Date.now(), machinesNow(Date.now()), 7);
            return {
                queued: 7, rejudges: 3, health,
                judges: users.filter(isJudge).map((user) => ({
                    _id: user._id, uname: user.uname, regat: user.regat, loginat: user.loginat, rule: rules.get(user._id) ?? defaultJudgeRule(),
                    connections: health.machines.filter((machine) => machine.kind === 'remote' && machine.online && machine.account === user.uname)
                        .map((machine) => ({ ip: machine.ip, concurrency: machine.concurrency, active: machine.activeCount, name: machine.name })),
                })),
            };
        }
        if (pathname === '/manage/xcpcio-rejudge/history') {
            settle();
            const number = Math.max(1, Number(query.get('page')) || 1);
            const jobId = query.get('job');
            if (jobId) {
                const job = jobs.find((candidate) => candidate._id === jobId);
                if (!job) throw new ManageError('重测记录不存在', 404);
                const own = items.filter((item) => item.job === jobId);
                const groups = new Map<string, { before: number; after: number | null; count: number }>();
                for (const item of own) {
                    const key = `${item.before}:${item.after}`;
                    const group = groups.get(key) ?? { before: item.before, after: item.after, count: 0 };
                    group.count++;
                    groups.set(key, group);
                }
                const tdoc = contests.find((candidate) => candidate.id === job.contest);
                const shown = query.get('changed') === 'true' ? own.filter((item) => item.after !== null && item.after !== item.before) : own;
                return {
                    job: { ...job, description: describeJob(job) }, stats: summarizeTransitions([...groups.values()]), total: shown.length, page: number, pageSize: 50,
                    items: page(shown, number).map((item) => ({
                        rid: String(item.rid), pid: item.pid, problem: tdoc ? String.fromCharCode(65 + tdoc.pids.indexOf(item.pid)) : `P${item.pid}`, title: titles[item.pid],
                        uid: item.uid, user: users.find((user) => user._id === item.uid)?.uname ?? `UID ${item.uid}`, displayName: users.find((user) => user._id === item.uid)?.displayName || '',
                        before: item.before, after: item.after, beforeScore: item.beforeScore, afterScore: item.afterScore, judgedAt: item.judgedAt, url: '#',
                    })),
                };
            }
            return {
                total: jobs.length, page: number, pageSize: 20,
                jobs: jobs.slice((number - 1) * 20, number * 20).map((job) => {
                    const own = items.filter((item) => item.job === job._id);
                    return {
                        _id: String(job._id), domainId: job.domainId, createdAt: job.createdAt, finishedAt: job.finishedAt, operator: 'admin', description: describeJob(job),
                        total: own.length, pending: own.filter((item) => item.after === null).length,
                        changed: own.filter((item) => item.after !== null && item.after !== item.before).length, failed: job.failed.length,
                    };
                }),
            };
        }
        if (pathname === '/manage/xcpcio-rejudge/data') {
            if (query.has('search')) {
                const text = (query.get('search') || '').trim().toLowerCase();
                return { problems: Object.entries(titles).map(([docId, title]) => ({ docId: Number(docId), pid: `P${docId}`, title }))
                    .filter((problem) => text && (String(problem.docId) === text || problem.pid.toLowerCase().startsWith(text) || problem.title.toLowerCase().includes(text))).slice(0, 20) };
            }
            const tdoc = contests.find((candidate) => candidate.id === query.get('contest'));
            if (tdoc) return { problems: tdoc.pids.map((pid, index) => ({ pid, label: String.fromCharCode(65 + index), title: titles[pid] })) };
            return { domainId: query.get('domain') || 'system', contests: contests.map((candidate) => ({ ...candidate, problems: candidate.pids.length })) };
        }
        return null;
    }

    const pages: Record<string, { template: string; runtime: () => object }> = {
        '/manage/xcpcio-users': { template: 'xcpcio_manage_users.html', runtime: () => ({ domainId: 'system' }) },
        '/manage/xcpcio-judges': {
            template: 'xcpcio_manage_judges.html',
            runtime: () => ({ scopes: judgeScopes, langs: [['c', 'C'], ['cc', 'C++'], ['cc.cc17', 'C++17'], ['java', 'Java'], ['py3', 'Python 3'], ['pypy3', 'PyPy3'], ['go', 'Go'], ['rs', 'Rust']] }),
        },
        '/manage/xcpcio-rejudge': { template: 'xcpcio_manage_rejudge.html', runtime: () => ({ domainId: 'system', statuses: rejudgeStatuses, max: MAX_REJUDGE, historyUrl: '/manage/xcpcio-rejudge/history' }) },
    };

    return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
        if (!url.pathname.startsWith('/manage/')) return false;
        const json = (value: unknown, status = 200) => response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(value));
        try {
            const pageInfo = pages[url.pathname];
            if (pageInfo && request.method === 'POST') {
                let text = '';
                for await (const chunk of request) text += chunk;
                const body = JSON.parse(text || '{}');
                json(await operate(body.operation, JSON.parse(body.payload || '{}')));
                return true;
            }
            if (pageInfo) {
                response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(env.render(pageInfo.template, {
                    codeBase, tdoc: { title: '控制面板' },
                    manageMenu: menu.map(([, label, href]) => ({ label, href, active: href === url.pathname })),
                    runtimeJson: toScriptJson({ base: url.pathname, dataUrl: `${url.pathname}/data`, ...pageInfo.runtime() }),
                }));
                return true;
            }
            const body = data(url.pathname, url.searchParams);
            if (!body) return false;
            json(body);
        } catch (error) {
            json({ error: error instanceof Error ? error.message : 'Invalid request' }, error instanceof ManageError ? error.status : 400);
        }
        return true;
    };
}
