/** Validation for the settings objects the ICPC Live admin sends (backend-api Settings.kt). */
import { ApiActionError } from './widgets';

type Json = Record<string, unknown>;

function object(value: unknown): Json {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiActionError('Failed to deserialize data: expected an object');
    return value as Json;
}

function bool(input: Json, key: string, fallback: boolean) {
    const value = input[key];
    if (value === undefined || value === null) return fallback;
    if (typeof value !== 'boolean') throw new ApiActionError(`Failed to deserialize data: ${key} must be a boolean`);
    return value;
}

function text(input: Json, key: string, fallback?: string, max = 10000) {
    const value = input[key];
    if ((value === undefined || value === null) && fallback !== undefined) return fallback;
    if (typeof value !== 'string' || value.length > max) throw new ApiActionError(`Failed to deserialize data: ${key} must be a string`);
    return value;
}

function optionalText(input: Json, key: string, max = 200) {
    const value = input[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || value.length > max) throw new ApiActionError(`Failed to deserialize data: ${key} must be a string`);
    return value;
}

function choice<T extends string>(input: Json, key: string, allowed: readonly T[], fallback: T): T {
    const value = input[key];
    if (value === undefined || value === null) return fallback;
    if (!allowed.includes(value as T)) throw new ApiActionError(`Failed to deserialize data: ${key} must be one of ${allowed.join(', ')}`);
    return value as T;
}

function int(input: Json, key: string, fallback?: number, min = -1e9, max = 1e9) {
    const value = input[key];
    if ((value === undefined || value === null) && fallback !== undefined) return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
        throw new ApiActionError(`Failed to deserialize data: ${key} must be a number`);
    }
    return Math.round(value);
}

export const teamViewPositions = ['SINGLE', 'PVP_TOP', 'PVP_BOTTOM', 'TOP_LEFT', 'TOP_RIGHT', 'BOTTOM_LEFT', 'BOTTOM_RIGHT'] as const;
export type TeamViewPosition = typeof teamViewPositions[number];
const mediaTypes = ['camera', 'screen', 'record', 'photo', 'reactionVideo', 'achievement', 'audio', 'backup', 'keylog', 'toolData'];
const clockTypes = ['standard', 'countdown', 'global'] as const;

export const emptySettings = (value: unknown) => { object(value); return {}; };

export const queueSettings = (value: unknown) => ({ horizontal: bool(object(value), 'horizontal', false) });

export const scoreboardSettings = (value: unknown) => {
    const input = object(value);
    return {
        scrollDirection: choice(input, 'scrollDirection', ['FirstPage', 'Back', 'Pause', 'Forward', 'LastPage'] as const, 'Forward'),
        optimismLevel: choice(input, 'optimismLevel', ['normal', 'optimistic', 'pessimistic'] as const, 'normal'),
        group: text(input, 'group', 'all', 100),
    };
};

export const medalCutoffSettings = (value: unknown) => {
    const input = object(value);
    return { group: text(input, 'group', 'all', 100), medal: choice(input, 'medal', ['gold', 'silver', 'bronze'] as const, 'gold') };
};
export const problemFocusSettings = (value: unknown) => ({ problemId: text(object(value), 'problemId', '0', 32) });

export const clockSettings = (value: unknown) => {
    const input = object(value);
    const timeZone = optionalText(input, 'timeZone', 64);
    return {
        clockType: choice(input, 'clockType', clockTypes, 'standard'),
        showSeconds: bool(input, 'showSeconds', true),
        timeZone: timeZone?.trim() ? timeZone.trim() : null,
    };
};

/** 赛况总览: which panels show, how many teams the ranking lists, and the language of its labels. */
export const overviewSettings = (value: unknown) => {
    const input = object(value);
    return {
        language: choice(input, 'language', ['zh', 'en'] as const, 'zh'),
        title: text(input, 'title', '', 100),
        topTeams: int(input, 'topTeams', 10, 3, 10),
        showRanking: bool(input, 'showRanking', true),
        showProblems: bool(input, 'showProblems', true),
        showSchools: bool(input, 'showSchools', true),
        showRecent: bool(input, 'showRecent', true),
        showCharts: bool(input, 'showCharts', true),
    };
};

export const teamViewSettings = (position: TeamViewPosition) => (value: unknown) => {
    const input = object(value);
    const types = input.mediaTypes ?? [];
    if (!Array.isArray(types) || types.some((type) => !mediaTypes.includes(type))) throw new ApiActionError('Failed to deserialize data: mediaTypes');
    return {
        teamId: optionalText(input, 'teamId', 64),
        mediaTypes: types as string[],
        showTaskStatus: bool(input, 'showTaskStatus', true),
        showAchievement: bool(input, 'showAchievement', false),
        showTimeLine: bool(input, 'showTimeLine', false),
        position: choice(input, 'position', teamViewPositions, position),
    };
};

export const locatorSettings = (value: unknown) => {
    const input = object(value);
    const circles = input.circles ?? [];
    if (!Array.isArray(circles) || circles.length > 100) throw new ApiActionError('Failed to deserialize data: circles');
    return {
        circles: circles.map((circle) => {
            const item = object(circle);
            return { x: int(item, 'x'), y: int(item, 'y'), radius: int(item, 'radius', undefined, 0), teamId: optionalText(item, 'teamId', 64) };
        }),
        scene: text(input, 'scene', 'default', 100),
    };
};

export const advertisementSettings = (value: unknown) => ({ text: text(object(value), 'text', undefined, 2000) });

export const pictureSettings = (value: unknown) => {
    const input = object(value);
    return { url: text(input, 'url', undefined, 2000), name: text(input, 'name', '', 200) };
};

export const titleSettings = (value: unknown) => {
    const input = object(value);
    const data = object(input.data ?? {});
    const entries = Object.entries(data);
    if (entries.length > 50 || entries.some(([, item]) => typeof item !== 'string' || item.length > 2000)) {
        throw new ApiActionError('Failed to deserialize data: data must map names to strings');
    }
    return {
        preset: text(input, 'preset', undefined, 300),
        leftPreset: optionalText(input, 'leftPreset', 300),
        rightPreset: optionalText(input, 'rightPreset', 300),
        data: Object.fromEntries(entries) as Record<string, string>,
    };
};

export const tickerMessageSettings = (value: unknown) => {
    const input = object(value);
    const base = {
        part: choice(input, 'part', ['short', 'long'] as const, 'long'),
        periodMs: int(input, 'periodMs', undefined, 100, 3600_000),
    };
    const type = choice(input, 'type', ['text', 'image', 'clock', 'scoreboard', 'empty'] as const, 'text');
    switch (type) {
    case 'text': return { type, ...base, text: text(input, 'text', undefined, 2000) };
    case 'image': return { type, ...base, path: text(input, 'path', undefined, 2000) };
    case 'clock': return { type, ...base, ...clockSettings(input) };
    case 'scoreboard': return { type, ...base, from: int(input, 'from', undefined, 1), to: int(input, 'to', undefined, 1) };
    default: return { type, ...base };
    }
};
