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
    fit: 'cover' | 'contain';
    visible: boolean;
    locked: boolean;
    props: { text?: string; image?: string; color?: string };
}
export const cardFields = ['team', 'school', 'logo', 'problem', 'verdict', 'time', 'rank'] as const;
export interface ReactionLayout {
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
function integer(raw: unknown, min: number, max: number, field: string) {
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max)
        throw new ReactionError(`${field}须为 ${min} 至 ${max} 的整数`);
    return raw;
}
function color(value: unknown) {
    if (typeof value !== 'string' || !/^#[\da-f]{6}$/i.test(value)) throw new ReactionError('请选择六位十六进制颜色');
    return value;
}
function asset(value: unknown) {
    if (value == null || value === '') return null;
    if (typeof value !== 'string' || !/^[a-f\d]{24}$/.test(value)) throw new ReactionError('图片必须来自本场比赛的上传素材');
    return value;
}
export function defaultLayouts(): ReactionLayout[] {
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
export function normalizeLayout(input: unknown, id: string, revision: number): ReactionLayout {
    const value = object(input),
        canvas = object(value.canvas),
        background = object(value.background),
        card = object(value.card);
    const width = integer(canvas.width, 16, 3840, '画布宽度'),
        height = integer(canvas.height, 16, 3840, '画布高度');
    if (!['1080x1920', '1920x1080', '1080x1080'].includes(`${width}x${height}`) && (width % 16 || height % 16))
        throw new ReactionError('自定义画布宽、高必须是 16 的倍数');
    if (typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 80)
        throw new ReactionError('版式名称需要 1 至 80 个字符');
    if (!Array.isArray(value.items) || !value.items.length || value.items.length > 33) throw new ReactionError('请添加 1 至 33 个元素');
    const seen = new Set<string>(),
        counts = new Map<ElementKind, number>();
    const items = value.items.map((raw): LayoutItem => {
        const it = object(raw),
            props = object(it.props),
            kind = it.kind as ElementKind;
        if (!elementKinds.includes(kind) || typeof it.id !== 'string' || !/^[\w-]{1,48}$/.test(it.id) || seen.has(it.id))
            throw new ReactionError('元素类型或编号无效');
        seen.add(it.id);
        counts.set(kind, (counts.get(kind) || 0) + 1);
        if (counts.get(kind)! > (['webcam', 'screen', 'card'].includes(kind) ? 1 : 10)) throw new ReactionError('同类元素过多');
        const image = asset(props.image);
        return {
            id: it.id,
            kind,
            x: integer(it.x, -3840, 3840, '横坐标'),
            y: integer(it.y, -3840, 3840, '纵坐标'),
            width: integer(it.width, 1, 7680, '元素宽度'),
            height: integer(it.height, 1, 7680, '元素高度'),
            z: integer(it.z, -9999, 9999, '层次'),
            fit: it.fit === 'cover' ? 'cover' : 'contain',
            visible: it.visible !== false,
            locked: it.locked === true,
            props: {
                ...(kind === 'text' ? { text: String(props.text || '').slice(0, 500), color: color(props.color || '#ffffff') } : {}),
                ...(kind === 'image' && image ? { image } : {}),
            },
        };
    });
    if (!Array.isArray(value.applies)) throw new ReactionError('请选择适用的提交');
    const applies = [...new Set(value.applies as Match[])];
    if (!applies.length || !applies.every((m) => ['first', 'accepted', 'other'].includes(m))) throw new ReactionError('请选择适用的提交');
    if (!Array.isArray(card.fields) || !card.fields.every((f) => cardFields.includes(f))) throw new ReactionError('卡片字段无效');
    return {
        id,
        revision,
        name: value.name.trim(),
        canvas: { width, height },
        items,
        background: { color: color(background.color), image: asset(background.image) },
        card: { fields: [...new Set(card.fields)], primary: color(card.primary), text: color(card.text) },
        applies,
    };
}
export function layoutWarnings(layout: ReactionLayout, nvidia = false) {
    const { width, height } = layout.canvas;
    const visible = [...layout.items].filter((i) => i.visible).sort((a, b) => a.z - b.z);
    const warnings: string[] = [];
    visible.forEach((i, idx) => {
        if (i.x < 0 || i.y < 0 || i.x + i.width > width || i.y + i.height > height) {
            if (nvidia) throw new ReactionError('nvidia_full 要求所有元素都在画布内');
            warnings.push(`${i.id} 超出画布`);
        }
        if (i.width % 2 || i.height % 2) warnings.push(`${i.id} 的宽或高是奇数`);
        if (i.kind !== 'webcam' && i.kind !== 'screen') return;
        // Check the union of opaque layers. Text, logos and contain-fit images may be transparent.
        const above = visible
            .slice(idx + 1)
            .filter((e) => e.kind === 'card' || ((e.kind === 'webcam' || e.kind === 'screen') && e.fit === 'cover'));
        const xs = [
            ...new Set([i.x, i.x + i.width, ...above.flatMap((e) => [e.x, e.x + e.width]).filter((x) => x > i.x && x < i.x + i.width)]),
        ].sort((a, b) => a - b);
        const ys = [
            ...new Set([i.y, i.y + i.height, ...above.flatMap((e) => [e.y, e.y + e.height]).filter((y) => y > i.y && y < i.y + i.height)]),
        ].sort((a, b) => a - b);
        if (
            xs
                .slice(0, -1)
                .every((x) =>
                    ys.slice(0, -1).every((y) => above.some((e) => e.x <= x && e.y <= y && e.x + e.width > x && e.y + e.height > y)),
                )
        )
            warnings.push(`${i.id} 完全被遮挡`);
    });
    return warnings;
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
