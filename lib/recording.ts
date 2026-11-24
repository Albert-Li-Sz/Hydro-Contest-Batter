/** Recording policies shared by Hydro's capture, storage and reporting code. All times are epoch milliseconds. */
export class RecordingError extends Error {
    constructor(message: string, public status = 400) { super(message); }
}
export function reportedVideoCodec(value: unknown) {
    if (value === 'hevc' || value === 'av1' || value === 'h264' || value === 'vp9' || value === 'vp8') return value;
    return undefined;
}

export function uploadedRecordingQuality(raw: unknown) {
    if (typeof raw !== 'string' || !raw) return undefined;
    let q;
    try { q = JSON.parse(raw); } catch { throw new RecordingError('画质格式无效'); }
    const inRange = (n: unknown, min: number, max: number) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
    if (!q || !inRange(q.height, 1, 8192) || !inRange(q.fps, 0.01, 240) || !inRange(q.kbps, 1, 100000)) return undefined;
    const codec = reportedVideoCodec(q.codec);
    return { height: q.height, fps: q.fps, kbps: q.kbps,
        ...(Number.isInteger(q.width) && inRange(q.width, 1, 16384) ? { width: q.width } : {}),
        ...(inRange(q.requestedHeight, 1, 8192) ? { requestedHeight: q.requestedHeight } : {}),
        ...(codec ? { codec } : {}) };
}

export type StreamName = 'screen' | 'webcam';
export type SourceName = 'clipScreen' | 'clipWebcam' | 'archiveScreen' | 'archiveWebcam';
type CommonPreset = 'low' | 'standard' | 'high';
export type Preset = CommonPreset | 'archiveHd';
export interface Quality { preset: Preset | 'custom'; height: number; fps: number; kbps: number }
type Triple = [number, number, number];
type SourcePresets = Record<CommonPreset, Triple> & { archiveHd?: Triple };
export const presets: Record<SourceName, SourcePresets> = {
    clipScreen: { low: [720, 5, 500], standard: [720, 10, 1000], high: [1080, 15, 2500] },
    clipWebcam: { low: [360, 15, 300], standard: [480, 15, 500], high: [720, 30, 1200] },
    archiveScreen: { low: [480, 0.5, 50], standard: [480, 1, 100], high: [720, 2, 250], archiveHd: [720, 24, 1200] },
    archiveWebcam: { low: [240, 1, 30], standard: [360, 2, 60], high: [480, 5, 150], archiveHd: [720, 24, 1200] },
};
export interface RecordingSettings {
    clips: { enabled: boolean; scope: 'all' | 'accepted' | 'first'; beforeSeconds: number; afterAcceptedSeconds: number; afterOtherSeconds: number; screen: Quality; webcam: Quality | null };
    archive: { enabled: boolean; screen: Quality; webcam: Quality | null; segmentSeconds: 60 };
    autoDowngrade: boolean;
    planning: { uplinkMbps: number | null; submissionsPerTeam: number; acceptedPerTeam: number; peakFactor: number };
}
export function qualityPreset(source: SourceName, preset: Preset): Quality {
    const choices = presets[source];
    const values = Object.hasOwn(choices, preset) ? choices[preset] : undefined;
    if (!values) throw new RecordingError('该录制通道不支持此画质预设');
    const [height, fps, kbps] = values;
    return { preset, height, fps, kbps };
}
export const defaultRecordingSettings = (): RecordingSettings => ({
    clips: { enabled: false, scope: 'all', beforeSeconds: 20, afterAcceptedSeconds: 40, afterOtherSeconds: 10, screen: qualityPreset('clipScreen', 'standard'), webcam: qualityPreset('clipWebcam', 'standard') },
    archive: { enabled: false, screen: qualityPreset('archiveScreen', 'archiveHd'), webcam: qualityPreset('archiveWebcam', 'archiveHd'), segmentSeconds: 60 },
    autoDowngrade: false, planning: { uplinkMbps: null, submissionsPerTeam: 40, acceptedPerTeam: 10, peakFactor: 3 },
});
const object = (raw: unknown): Record<string, any> => raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, any> : {};
function numeric(raw: unknown, min: number, max: number, name: string) {
    const n = typeof raw === 'number' || typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
    if (!Number.isFinite(n) || n < min || n > max) throw new RecordingError(`${name}应在 ${min} 至 ${max} 之间`);
    return n;
}
const bool = (x: unknown, base: boolean) => typeof x === 'boolean' ? x : base;

export function normalizeRecording(input: unknown, base: RecordingSettings, capture: { screenHeight: number; webcamHeight: number; webcam?: boolean }) {
    const raw = object(input), clips = object(raw.clips), archive = object(raw.archive), plan = object(raw.planning);
    function quality(x: unknown, old: Quality | null, source: SourceName, enabled: boolean, allowNull: boolean): Quality | null {
        const q = x === undefined ? old : x;
        if (q === null && allowNull) return null;
        if (!q || typeof q !== 'object') throw new RecordingError('录制画质无效');
        const fields = object(q);
        const preset = fields.preset;
        if (typeof preset !== 'string') throw new RecordingError('请选择画质预设');
        const value: Quality = preset !== 'custom' ? qualityPreset(source, preset as Preset) : {
            preset, height: numeric(fields.height, 120, 2160, '录制高度'), fps: numeric(fields.fps, 0.1, 60, '录制帧率'), kbps: numeric(fields.kbps, 10, 20000, '录制码率'),
        };
        if (enabled && value.height > (source.endsWith('Screen') ? capture.screenHeight : capture.webcamHeight)) throw new RecordingError('录制分辨率不能超过采集分辨率');
        return value;
    }
    const clipOn = bool(clips.enabled, base.clips.enabled), archiveOn = bool(archive.enabled, base.archive.enabled);
    const scope = clips.scope ?? base.clips.scope;
    if (!['all', 'accepted', 'first'].includes(scope)) throw new RecordingError('录制范围无效');
    const settings: RecordingSettings = {
        clips: {
            enabled: clipOn, scope,
            beforeSeconds: numeric(clips.beforeSeconds ?? base.clips.beforeSeconds, 0, 120, '提交前时长'),
            afterAcceptedSeconds: numeric(clips.afterAcceptedSeconds ?? base.clips.afterAcceptedSeconds, 0, 120, '通过后时长'),
            afterOtherSeconds: numeric(clips.afterOtherSeconds ?? base.clips.afterOtherSeconds, 0, 120, '判题后时长'),
            screen: quality(clips.screen, base.clips.screen, 'clipScreen', clipOn, false)!,
            webcam: quality(clips.webcam, base.clips.webcam, 'clipWebcam', clipOn && capture.webcam !== false, true),
        },
        archive: {
            enabled: archiveOn, segmentSeconds: 60,
            screen: quality(archive.screen, base.archive.screen, 'archiveScreen', archiveOn, false)!,
            webcam: quality(archive.webcam, base.archive.webcam, 'archiveWebcam', archiveOn && capture.webcam !== false, true),
        },
        autoDowngrade: bool(raw.autoDowngrade, base.autoDowngrade),
        planning: {
            uplinkMbps: plan.uplinkMbps === undefined ? base.planning.uplinkMbps : plan.uplinkMbps === null || plan.uplinkMbps === '' ? null : numeric(plan.uplinkMbps, 0.01, 1000000, '上行带宽'),
            submissionsPerTeam: numeric(plan.submissionsPerTeam ?? base.planning.submissionsPerTeam, 0, 10000, '每队提交数'),
            acceptedPerTeam: numeric(plan.acceptedPerTeam ?? base.planning.acceptedPerTeam, 0, 10000, '每队通过数'),
            peakFactor: numeric(plan.peakFactor ?? base.planning.peakFactor, 1, 100, '峰值系数'),
        },
    };
    if (settings.planning.acceptedPerTeam > settings.planning.submissionsPerTeam) throw new RecordingError('通过数不能超过提交数');
    return settings;
}
export const clipPriority = (status: number, first: boolean) => first && status === 1 ? 0 : status === 1 ? 1 : 2;
export const inScope = (scope: RecordingSettings['clips']['scope'], priority: number) => priority <= ({ all: 2, accepted: 1, first: 0 })[scope];
export function clipWindow(submittedAt: number, judgedAt: number, accepted: boolean, settings: RecordingSettings['clips']) {
    const end = Math.max(judgedAt, submittedAt) + 1000 * (accepted ? settings.afterAcceptedSeconds : settings.afterOtherSeconds);
    return { windowStart: Math.max(submittedAt - settings.beforeSeconds * 1000, end - 120000), windowEnd: end };
}
export interface Interval { from: number; to: number }
export function missingIntervals(from: number, to: number, segments: { startAt: number; endAt: number }[], tolerance = 250) {
    const missing: Interval[] = [];
    let cursor = from;
    for (const s of [...segments].sort((a, b) => a.startAt - b.startAt)) {
        if (s.endAt <= from || s.startAt >= to) continue;
        if (s.startAt > cursor + tolerance) missing.push({ from: cursor, to: Math.min(s.startAt, to) });
        cursor = Math.max(s.endAt, cursor);
    }
    if (!segments.length || cursor < to - tolerance) missing.push({ from: cursor, to });
    return missing;
}
export type Measured = Partial<Record<SourceName, number>>;
export interface PlanStats { teams: number; seconds: number; submissions?: number; accepted?: number; elapsed?: number; problems?: number }
export function estimateRecording(s: RecordingSettings, stats: PlanStats, measured: Measured = {}, webcam = true) {
    const { teams, seconds } = stats;
    const elapsed = Math.min(seconds, stats.elapsed || 0);
    const real = elapsed > 0 && stats.submissions !== undefined;
    const submissions = real ? stats.submissions! * seconds / elapsed : teams * s.planning.submissionsPerTeam;
    const accepted = real ? (stats.accepted || 0) * seconds / elapsed : teams * s.planning.acceptedPerTeam;
    const ac = s.clips.scope === 'first' ? Math.min(accepted, stats.problems ?? accepted) : accepted;
    const clipSeconds = s.clips.enabled ? ac * Math.min(120, s.clips.beforeSeconds + s.clips.afterAcceptedSeconds)
        + (s.clips.scope === 'all' ? Math.max(0, submissions - accepted) : 0) * Math.min(120, s.clips.beforeSeconds + s.clips.afterOtherSeconds) : 0;
    const archiveSeconds = s.archive.enabled ? teams * seconds : 0;
    function bytes(key: SourceName, quality: Quality | null, duration: number) {
        return quality ? (measured[key] || quality.kbps) * 125 * duration : 0;
    }
    const sources = { clipScreen: bytes('clipScreen', s.clips.screen, clipSeconds), clipWebcam: bytes('clipWebcam', webcam ? s.clips.webcam : null, clipSeconds),
        archiveScreen: bytes('archiveScreen', s.archive.screen, archiveSeconds), archiveWebcam: bytes('archiveWebcam', webcam ? s.archive.webcam : null, archiveSeconds) };
    const total = Object.values(sources).reduce((sum, x) => sum + x, 0);
    const averageMbps = seconds > 0 ? total * 8 / seconds / 1e6 : 0;
    const peakMbps = averageMbps * s.planning.peakFactor;
    return { sources, averageMbps, peakMbps, storageBytes: Math.ceil(total * 1.05), utilization: s.planning.uplinkMbps ? peakMbps / s.planning.uplinkMbps : null, real };
}
export function gradeTest(dropRate: number | null, pressure: string, throughputMbps: number | null, peakMbps: number) {
    if ((dropRate !== null && dropRate >= .05) || ['serious', 'critical'].includes(pressure) || (throughputMbps !== null && throughputMbps <= peakMbps * 2)) return 'fail';
    if (dropRate === null || !['nominal', 'fair'].includes(pressure) || throughputMbps === null) return 'unknown';
    if (dropRate >= .04 || pressure === 'fair' || throughputMbps < peakMbps * 2.4) return 'marginal';
    return 'pass';
}
export function readRange(range: unknown, bytes: number) {
    if (range === undefined || range === null) return null;
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(range));
    if (!match || (!match[1] && !match[2])) throw new RecordingError('无效的字节范围', 416);
    const start = match[1] ? Number(match[1]) : Math.max(0, bytes - Number(match[2]));
    const end = match[1] && match[2] ? Math.min(bytes - 1, Number(match[2])) : bytes - 1;
    if (!Number.isSafeInteger(start) || start < 0 || start > end || start >= bytes) throw new RecordingError('无效的字节范围', 416);
    return { start, end };
}
