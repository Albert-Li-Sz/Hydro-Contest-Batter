import type { LiveContestTimes } from './live/model';
import { labelsHidden } from './ccpc-board';
import type { BoardSettings } from './settings';

export const elementKinds = ['webcam', 'screen', 'card', 'logo', 'text', 'image'] as const;
export type ElementKind = (typeof elementKinds)[number];
export type Match = 'first' | 'accepted' | 'other';
export interface LayoutItem {
    id: string;
    kind: ElementKind;
    x: number;
    y: number;
    width: number;
    height: number;
    z: number;
    fit: 'cover' | 'contain' | 'fill';
    visible: boolean;
    locked: boolean;
    props: { text?: string; image?: string; color?: string };
}
export const cardFields = ['team', 'school', 'logo', 'problem', 'verdict', 'time', 'rank'] as const;
export interface ReactionLayout {
    template?: 'icpc-portrait' | 'icpc-landscape';
    artwork?: string | null;
    id: string;
    name: string;
    canvas: { width: number; height: number };
    background: { color: string; image: string | null };
    items: LayoutItem[];
    card: { fields: string[]; primary: string; text: string };
    applies: Match[];
    revision: number;
}
export class ReactionError extends Error {
    constructor(
        message: string,
        public status = 400,
    ) {
        super(message);
    }
}
const object = (input: unknown) => (input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {});
function asset(value: unknown) {
    if (value == null || value === '') return null;
    if (typeof value !== 'string' || !/^[a-f\d]{24}$/.test(value)) throw new ReactionError('图片必须来自本场比赛的上传素材');
    return value;
}
// Original snapshots are still used to decide which existing MP4s may be shown.
function legacyDefaults(): ReactionLayout[] {
    const item = (kind: ElementKind, y: number, w: number, h: number): LayoutItem => ({
        id: kind,
        kind,
        x: 0,
        y,
        width: w,
        height: h,
        z: y,
        fit: 'contain',
        visible: true,
        locked: false,
        props: {},
    });
    return [
        {
            id: 'portrait',
            name: '竖屏 · 选手反应',
            canvas: { width: 1080, height: 1920 },
            items: [item('webcam', 0, 1080, 1380), item('card', 1380, 1080, 540)],
        },
        {
            id: 'landscape',
            name: '横屏 · 屏幕与摄像头',
            canvas: { width: 1920, height: 1080 },
            items: [
                item('screen', 0, 1440, 1080),
                { ...item('webcam', 0, 480, 590), x: 1440 },
                { ...item('card', 590, 480, 490), x: 1440 },
            ],
        },
    ].map((layout) => ({
        ...layout,
        background: { color: '#15202d', image: null },
        card: { fields: ['team', 'problem', 'verdict', 'time', 'rank'], primary: '#174461', text: '#ffffff' },
        applies: ['first', 'accepted', 'other'],
        revision: 1,
    }));
}
// Rectangles match icpc/reactions-generator Defaults after its 4:2:0 chroma alignment.
function officialLayout(legacy: ReactionLayout): ReactionLayout {
    const portrait = legacy.canvas.height >= legacy.canvas.width;
    const layer = (kind: 'webcam' | 'screen' | 'card', x: number, y: number, width: number, height: number, z: number): LayoutItem =>
        ({ id: kind, kind, x, y, width, height, z, fit: 'fill', visible: true, locked: true, props: {} });
    return {
        ...legacy,
        template: portrait ? 'icpc-portrait' : 'icpc-landscape',
        name: legacy.id === 'portrait' ? '竖屏 · ICPC Live' : legacy.id === 'landscape' ? '横屏 · ICPC Live' : legacy.name,
        canvas: portrait ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 },
        items: portrait
            ? [layer('webcam', 40, 194, 1000, 562, 0), layer('screen', 40, 1162, 1000, 562, 1), layer('card', 40, 806, 1000, 306, 2)]
            : [layer('webcam', 0, 0, 1920, 1080, 0), layer('screen', 1264, 16, 640, 360, 1), layer('card', 16, 16, 1000, 306, 2)],
        background: { color: '#ffffff', image: null },
        artwork: null,
        card: { fields: [...cardFields], primary: '#1b8041', text: '#ffffff' },
        revision: legacy.revision + 1,
    };
}

type LayoutVersion = { layout: ReactionLayout; effectiveAt: number; migrated?: boolean };
export function layoutHistory(saved: LayoutVersion[]) {
    const rows: LayoutVersion[] = [...legacyDefaults().map(layout => ({ layout, effectiveAt: 0 })), ...saved];
    const legacy = new Map<string, { layout: ReactionLayout; effectiveAt: number }>();
    for (const row of rows) {
        if (row.layout.template) continue;
        const old = legacy.get(row.layout.id);
        legacy.set(row.layout.id, {
            layout: !old || old.layout.revision < row.layout.revision ? row.layout : old.layout,
            effectiveAt: Math.min(old?.effectiveAt ?? row.effectiveAt, row.effectiveAt),
        });
    }
    for (const { layout, effectiveAt } of legacy.values()) rows.push({ layout: officialLayout(layout), effectiveAt, migrated: true });
    return rows.sort((a, b) => a.layout.revision - b.layout.revision);
}

export const defaultLayouts = () => legacyDefaults().map(officialLayout);

export function updateArtwork(current: ReactionLayout | undefined, input: unknown): ReactionLayout {
    const patch = object(input);
    if (!current?.template || patch.id !== current.id || Object.keys(patch).some(k => !['id', 'revision', 'artwork'].includes(k)))
        throw new ReactionError('版式已固定，仅可替换竖屏底部图样');
    if (patch.revision !== current.revision) throw new ReactionError('版式已经更新，请刷新后再保存', 409);
    if (current.template !== 'icpc-portrait' || !Object.hasOwn(patch, 'artwork')) throw new ReactionError('此版式没有可替换的图样');
    return { ...current, artwork: asset(patch.artwork), revision: current.revision + 1 };
}

export function matchesLayout(layout: ReactionLayout, accepted: boolean, first: boolean) {
    return (first && layout.applies.includes('first')) || layout.applies.includes(accepted ? 'accepted' : 'other');
}
export interface ReactionPublic {
    enabled: boolean;
    scope: 'first' | 'accepted' | 'all';
    timing: 'unlock' | 'end' | 'live';
    screen: 'none' | 'capture';
    layoutId: string;
    download: boolean;
    school: 'board' | 'show' | 'hide';
}
export const defaultReactionPublic: ReactionPublic = {
    enabled: false,
    scope: 'first',
    timing: 'unlock',
    screen: 'none',
    layoutId: 'portrait',
    download: false,
    school: 'board',
};
export function publicSettings(input: unknown, old: ReactionPublic): ReactionPublic {
    const v = { ...old, ...object(input) };
    if (
        !['first', 'accepted', 'all'].includes(v.scope) ||
        !['unlock', 'end', 'live'].includes(v.timing) ||
        !['none', 'capture'].includes(v.screen) ||
        !['board', 'show', 'hide'].includes(v.school) ||
        typeof v.layoutId !== 'string' ||
        !/^[\w-]{1,48}$/.test(v.layoutId) ||
        typeof v.enabled !== 'boolean' ||
        typeof v.download !== 'boolean'
    )
        throw new ReactionError('公开设置无效');
    return {
        enabled: v.enabled,
        scope: v.scope,
        timing: v.timing,
        screen: v.screen,
        layoutId: v.layoutId,
        download: v.download,
        school: v.school,
    };
}
export function canPublish(
    video: { state: string; hidden?: unknown; firstSolve: boolean; accepted: boolean; submittedAt: number; layout: ReactionLayout },
    config: ReactionPublic,
    contest: LiveContestTimes,
    board: Pick<BoardSettings, 'showIdentity' | 'ccpcBoard'>,
    screenAllowed: boolean,
    now: number,
) {
    if (!config.enabled || video.hidden || video.state !== 'ready' || video.layout.id !== config.layoutId || now < +contest.beginAt)
        return false;
    if ((config.scope === 'first' && !video.firstSolve) || (config.scope === 'accepted' && !video.accepted)) return false;
    const running = now < +contest.endAt;
    if ((config.timing !== 'live' && running) || (config.timing === 'unlock' && contest.lockAt && !contest.unlocked)) return false;
    if (contest.lockAt && !contest.unlocked && video.submittedAt > +contest.lockAt) return false;
    if (running && labelsHidden(board.ccpcBoard, contest, now)) return false;
    const visible = video.layout.items.filter((i) => i.visible);
    if (running && visible.some((i) => i.kind === 'screen') && !(config.screen === 'capture' && screenAllowed)) return false;
    if (
        (config.school === 'hide' || (config.school === 'board' && !board.showIdentity)) &&
        (visible.some((i) => i.kind === 'logo') ||
            (visible.some((i) => i.kind === 'card') && video.layout.card.fields.some((f) => f === 'school' || f === 'logo')))
    )
        return false;
    return true;
}

export function layoutsAt(history: { layout: ReactionLayout; effectiveAt: number }[], judgedAt: number) {
    const revisions = new Map<string, ReactionLayout>();
    for (const row of history) {
        const saved = revisions.get(row.layout.id);
        if (row.effectiveAt <= judgedAt && (!saved || saved.revision < row.layout.revision)) revisions.set(row.layout.id, row.layout);
    }
    return [...revisions.values()];
}

export function needsRender(
    existing: { state: string; verdict: string; firstSolve: boolean; layoutRevision: number },
    verdict: string,
    firstSolve: boolean,
    revision: number,
) {
    return (
        existing.state !== 'removed' &&
        (existing.state === 'ineligible' ||
            existing.verdict !== verdict ||
            existing.firstSolve !== firstSolve ||
            existing.layoutRevision !== revision)
    );
}
