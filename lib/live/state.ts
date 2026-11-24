import type { PresetId, PresetState, WidgetState } from './widgets';

export interface FeaturedSelection { runId: string; mediaType: string; expiresAt: number }

export interface LiveState {
    controllers?: Record<string, WidgetState<unknown>>;
    presets?: Record<string, PresetState<unknown>[]>;
    featuredRun?: FeaturedSelection | null;
}

/** One MongoDB field per controller or preset. Null in a patch means deletion. */
export type LiveStateEntries = Record<string, WidgetState<unknown> | PresetState<unknown>>;
export type LiveStatePatch = Record<string, LiveStateEntries[string] | null>;

export function stateEntries(state: LiveState): LiveStateEntries {
    const entries: LiveStateEntries = {};
    if (state.featuredRun) entries.featuredRun = { settings: state.featuredRun, showOrder: null };
    for (const [name, value] of Object.entries(state.controllers || {})) entries[`controller/${name}`] = value;
    for (const [name, presets] of Object.entries(state.presets || {})) {
        // Before 0.8.0 some presets had no ID. Assign the same legacy IDs in every process.
        let legacyId = 0;
        const used = new Set<PresetId>();
        for (const preset of presets) {
            let id = preset.id;
            if (id === undefined || used.has(id)) id = ++legacyId;
            if (typeof id === 'number') legacyId = Math.max(legacyId, id);
            used.add(id);
            entries[`preset/${name}/${id}`] = { ...preset, id };
        }
    }
    return entries;
}

export function stateFromEntries(entries: LiveStateEntries): LiveState {
    const state: Required<LiveState> = { controllers: {}, presets: {}, featuredRun: null };
    for (const [key, value] of Object.entries(entries)) {
        if (key === 'featuredRun') state.featuredRun = value.settings as FeaturedSelection;
        else if (key.startsWith('controller/')) state.controllers[key.slice(11)] = value;
        else if (key.startsWith('preset/')) (state.presets[key.split('/')[1]] ||= []).push(value as PresetState<unknown>);
    }
    return state;
}

export function stateUpdate(patch: LiveStatePatch) {
    const $set: Record<string, unknown> = { updatedAt: new Date() };
    const $unset: Record<string, ''> = {};
    for (const [key, value] of Object.entries(patch)) {
        if (key.includes('.') || key.includes('$')) throw new Error('Invalid live state key');
        if (value === null) $unset[`stateEntries.${key}`] = '';
        else $set[`stateEntries.${key}`] = value;
    }
    return { $set, $unset, $inc: { stateRevision: 1 } };
}
