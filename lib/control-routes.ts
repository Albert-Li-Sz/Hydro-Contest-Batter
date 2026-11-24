import fs from 'node:fs';
import path from 'node:path';
import {
    ContestModel, type Context, Handler, NotFoundError, ObjectId, param, PERM, PRIV, type Tdoc, Types, ValidationError,
} from 'hydrooj';
import { type BalloonSettings } from './balloons';
import { contestPhase, patchBoard, presetIds, presetOf, presets, type PresetId } from './control';
import type { CaptureSettings } from './live/capture';
import { resolverCodeBase } from './resolver-data';
import { type BoardSettings, toScriptJson } from './settings';

class ControlError extends Error {
    constructor(message: string, public status = 400) { super(message); }
}

/**
 * 比赛配置与工作台 (/contest/:tid/control): the board's rules, awards and access, the balloons, printing, the public
 * screens and 解除封榜 on one page, each saved through its own module; plus the rejudges waiting for review.
 */
export function applyControl(ctx: Context, dependencies: {
    loadSettings: (tdoc: Tdoc) => Promise<BoardSettings>;
    saveSettings: (tdoc: Tdoc, settings: BoardSettings, uid: number) => Promise<BoardSettings>;
    balloons: { get: (tdoc: Tdoc) => Promise<BalloonSettings>; save: (tdoc: Tdoc, input: unknown) => Promise<BalloonSettings> };
    capture: { get: (tdoc: Tdoc) => Promise<CaptureSettings>; save: (tdoc: Tdoc, input: unknown, uid: number) => Promise<CaptureSettings> } | null;
    reactions?: { summary(tdoc: Tdoc): Promise<{ready: number; waiting: number; failed: number; publicEnabled: boolean}>;
        setPublic(tdoc: Tdoc, enabled: boolean): Promise<unknown> };
    live: boolean;
    review: (tdoc: Tdoc) => Promise<{ changes: number; pending: number; stale: number }>;
}) {
    const codeBase = resolverCodeBase(JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8')).version);
    const contestBase = (tdoc: Tdoc) => `/d/${encodeURIComponent(tdoc.domainId)}/contest/${tdoc.docId}`;

    async function state(tdoc: Tdoc, systemAdmin: boolean) {
        const [board, balloons, capture, review, reactions] = await Promise.all([
            dependencies.loadSettings(tdoc), dependencies.balloons.get(tdoc), dependencies.capture?.get(tdoc) ?? null,
            dependencies.review(tdoc).catch(() => null), dependencies.reactions?.summary(tdoc),
        ]);
        const base = contestBase(tdoc);
        return {
            contest: {
                title: tdoc.title, beginAt: tdoc.beginAt, endAt: tdoc.endAt, lockAt: tdoc.lockAt || null, unlocked: !!tdoc.unlocked,
                phase: contestPhase(tdoc, Date.now()), allowPrint: !!(tdoc as { allowPrint?: boolean }).allowPrint,
            },
            preset: presetOf(board, balloons),
            presets: presetIds.map((id) => ({ id, name: presets[id].name })),
            board: {
                tieBreak: board.tieBreak, ccpcBoard: board.ccpcBoard, ignoreAfterAccept: board.ignoreAfterAccept,
                medals: board.medals, medalBasis: board.medalBasis, medalRanking: board.medalRanking, medalSameScore: board.medalSameScore,
                podiumEnabled: board.podiumEnabled, podiumBasis: board.podiumBasis, podiumTie: board.podiumTie, podiumNames: board.podiumNames,
                firstSolve: board.firstSolve, unofficialFirstSolve: board.unofficialFirstSolve,
                schoolBoards: board.schoolBoards, participationBoards: board.participationBoards, manualBoards: board.manualBoards.length,
                specialAwards: board.specialAwards.length,
                publicAccess: board.publicAccess, showIdentity: board.showIdentity, ccsApi: board.ccsApi,
            },
            balloons: { enabled: balloons.enabled, afterFreeze: balloons.afterFreeze, first: balloons.first, teamColors: balloons.teamColors, tickets: balloons.tickets.enabled },
            reactions,
            capture: capture && { clips: capture.recording.clips.enabled, archive: capture.recording.archive.enabled, enabled: capture.enabled, screenDuringContest: capture.screenDuringContest, webcam: capture.webcam },
            review,
            links: {
                settings: `${base}/xcpcio-settings`, board: `${base}/scoreboard/xcpcio-plus`, publicBoard: board.publicAccess ? `${base}/xcpcio-public` : null,
                results: `${base}/results`, review: `${base}/rejudge-review`, resolver: `${base}/resolver`, screens: `${base}/screens`,
                reactions: `${base}/reactions/manage`, balloons: `${base}/balloons`, live: dependencies.live ? `${base}/live` : null, capture: dependencies.capture ? `${base}/live/capture` : null,
                presence: `${base}/presence`, monitor: `${base}/monitor`, overview: `${base}/overview`, desk: `${base}/clarification-desk`,
                printers: systemAdmin ? '/manage/xcpcio-printers' : null, rejudge: systemAdmin ? '/manage/xcpcio-rejudge' : null,
                judges: systemAdmin ? '/manage/xcpcio-judges' : null, seats: systemAdmin ? '/manage/xcpcio-users#seats' : null, edit: `${base}/edit`,
            },
        };
    }

    abstract class ControlBase extends Handler {
        tdoc!: Tdoc;

        @param('tid', Types.ObjectId)
        async prepare(_domainId: string, tid: ObjectId) {
            this.response.addHeader('Cache-Control', 'no-store');
            const tdoc = await ContestModel.get(this.domain._id, tid);
            if (!tdoc) throw new NotFoundError('Contest not found');
            if (!this.user._id) throw new ControlError('请登录比赛管理账号', 403);
            if (!this.user.own(tdoc)) this.checkPerm(PERM.PERM_EDIT_CONTEST);
            if (tdoc.rule !== 'acm') throw new ControlError('比赛配置仅支持 ACM 比赛');
            this.tdoc = tdoc;
        }

        payload(input: string): Record<string, unknown> {
            try {
                const value = JSON.parse(input);
                if (value && typeof value === 'object' && !Array.isArray(value)) return value;
            } catch { /* below */ }
            throw new ControlError('请求格式无效');
        }

        async onerror(error: Parameters<Handler['onerror']>[0]) {
            // The modules' own validation (settings, balloons, capture) speaks Chinese; Hydro's errors carry a code.
            const hydro = typeof (error as { code?: unknown }).code === 'number';
            if (error instanceof ValidationError || (error instanceof Error && !hydro)) {
                this.response.status = (error as { status?: number }).status ?? 400;
                const detail = (error as { params?: unknown[] }).params?.[1];
                this.response.body = { error: typeof detail === 'string' && detail ? detail : error.message };
                return;
            }
            return super.onerror(error);
        }
    }

    class ControlHandler extends ControlBase {
        async get() {
            const base = `${contestBase(this.tdoc)}/control`;
            this.response.template = 'xcpcio_control.html';
            this.response.body = { tdoc: this.tdoc, codeBase, runtimeJson: toScriptJson({ base, dataUrl: `${base}/data` }) };
        }

        @param('payload', Types.String)
        async postBoard(_domainId: string, input: string) {
            const settings = patchBoard(await dependencies.loadSettings(this.tdoc), this.payload(input));
            await dependencies.saveSettings(this.tdoc, settings, this.user._id);
            this.response.body = { ok: true };
        }

        @param('payload', Types.String)
        async postBalloons(_domainId: string, input: string) {
            await dependencies.balloons.save(this.tdoc, this.payload(input));
            this.response.body = { ok: true };
        }

        @param('payload', Types.String)
        async postCapture(_domainId: string, input: string) {
            if (!dependencies.capture) throw new ControlError('画面采集未启用', 404);
            await dependencies.capture.save(this.tdoc, this.payload(input), this.user._id);
            this.response.body = { ok: true };
        }

        @param('payload', Types.String)
        async postReactions(_domainId: string, input: string) {
            const { enabled } = this.payload(input);
            if (!dependencies.reactions || typeof enabled !== 'boolean') throw new ControlError('公开视频设置无效');
            await dependencies.reactions.setPublic(this.tdoc, enabled);
            this.response.body = { ok: true };
        }

        @param('payload', Types.String)
        async postPrint(_domainId: string, input: string) {
            const allowPrint = this.payload(input).allowPrint;
            if (typeof allowPrint !== 'boolean') throw new ControlError('打印开关无效');
            await ContestModel.edit(this.tdoc.domainId, this.tdoc.docId, { allowPrint } as Partial<Tdoc>);
            this.response.body = { ok: true };
        }

        @param('payload', Types.String)
        async postPreset(_domainId: string, input: string) {
            const id = this.payload(input).id as PresetId;
            if (!presetIds.includes(id)) throw new ControlError('未知的赛制');
            const settings = patchBoard(await dependencies.loadSettings(this.tdoc), presets[id].board as Record<string, unknown>);
            await dependencies.saveSettings(this.tdoc, settings, this.user._id);
            await dependencies.balloons.save(this.tdoc, presets[id].balloons);
            this.response.body = { ok: true };
        }

        /** Hydro's 解除封榜 (ContestModel.unlockScoreboard), once the contest is over. */
        async postUnlock() {
            if (!this.tdoc.lockAt || this.tdoc.unlocked) throw new ControlError('榜单没有封榜或已经解除');
            if (!ContestModel.isDone(this.tdoc)) throw new ControlError('比赛结束后才能解除封榜');
            await ContestModel.unlockScoreboard(this.tdoc.domainId, this.tdoc.docId);
            this.response.body = { ok: true };
        }
    }

    class ControlDataHandler extends ControlBase {
        notUsage = true;

        async get() {
            this.response.type = 'application/json';
            this.response.body = await state(this.tdoc, this.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM));
        }
    }

    ctx.Route('contest_xcpcio_control', '/contest/:tid/control', ControlHandler);
    ctx.Route('contest_xcpcio_control_data', '/contest/:tid/control/data', ControlDataHandler);
    ctx.i18n.load('zh', { contest_xcpcio_control: '比赛配置与工作台' });
}
