const MIME = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/mp4', 'video/webm'];
const HEVC = ['video/mp4;codecs=hvc1', 'video/mp4;codecs=hev1', 'video/mp4;codecs=hvc1.1.6.L93.B0', 'video/mp4;codecs=hev1.1.6.L93.B0'];
const ARCHIVE_MIME = [...HEVC, 'video/mp4;codecs=av01', 'video/mp4;codecs=av01.0.05M.08', 'video/webm;codecs=av1',
    'video/mp4;codecs=avc1', 'video/mp4;codecs=avc1.42E01F', 'video/webm;codecs=h264'];
export const selectMime = (supported, archiveHd = false) => (archiveHd ? ARCHIVE_MIME : MIME).find(supported);
export class ArchiveEncoderUnavailable extends Error {
    constructor(reason) { super('高清屏幕留档已停止：' + reason); }
}

export function outputSize(width, height, limit) {
    if (!(width >= 2 && height >= 2 && limit >= 2)) return null;
    const h = Math.floor(Math.min(height, limit) / 2) * 2;
    const w = Math.max(2, 2 * Math.floor(Math.min(width, h * width / height) / 2));
    return { width: w, height: h };
}

// WebRTC keeps the original track. The recording canvas keeps its initial, even dimensions.
// A resolution change in the source fits inside that frame without stretching or enlarging it.
async function canvasSource(track, quality, clean, manual, allowFrame) {
    const player = document.createElement('video');
    player.muted = true;
    player.playsInline = true;
    player.srcObject = new MediaStream([track]);
    clean.push(() => { player.pause(); player.srcObject = null; });
    const settings = track.getSettings();
    const playing = player.play();
    // Inactive documents may suspend the video element. Chromium's processor still supplies
    // source frames and sizes when available, so do not require DOM playback in that case.
    if (!manual || !settings.width || !settings.height || typeof MediaStreamTrackProcessor !== 'function') {
        let timer;
        try { await Promise.race([playing, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('无法读取采集画面')), 5000); })]); }
        finally { clearTimeout(timer); }
    } else playing.catch(() => {});
    const size = outputSize(player.videoWidth || settings.width, player.videoHeight || settings.height, quality.height);
    if (!size) throw new Error('无法确定采集画面尺寸');
    const canvas = document.createElement('canvas');
    Object.assign(canvas, size);
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('浏览器无法创建录制画布');
    let out;
    if (manual) {
        try { out = canvas.captureStream(0).getVideoTracks()[0]; } catch { /* timed capture below */ }
        if (out && typeof out.requestFrame !== 'function') { out.stop(); out = null; }
    }
    if (!out) out = canvas.captureStream(quality.fps).getVideoTracks()[0];
    if (!out) throw new Error('浏览器无法从画布采集视频');
    clean.push(() => out.stop());
    let lastDraw = -Infinity;
    const interval = 1000 / quality.fps;
    const paint = (source, width, height) => {
        if (!(width && height) || !allowFrame()) return;
        const now = performance.now();
        // Preserve clock phase at 24/30 and other non-integer source/output ratios.
        if (now + 0.5 < lastDraw + interval) return;
        const scale = Math.min(1, size.width / width, size.height / height);
        const w = Math.round(width * scale), h = Math.round(height * scale);
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, size.width, size.height);
        ctx.drawImage(source, (size.width - w) / 2, (size.height - h) / 2, w, h);
        if (typeof out.requestFrame === 'function') out.requestFrame();
        lastDraw = Number.isFinite(lastDraw) && now - lastDraw < interval * 2 ? lastDraw + interval : now;
    };
    const drawVideo = () => { if (player.readyState >= 2) paint(player, player.videoWidth, player.videoHeight); };
    // Source-driven reads continue without visible animation frames. Playback and a timer cover
    // browsers without a processor, suspended video callbacks, and static screens.
    let stopped = false, callback, reader;
    if (manual && typeof MediaStreamTrackProcessor === 'function') {
        try {
            reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
            (async () => {
                while (!stopped) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    try { if (!stopped) paint(value, value.displayWidth, value.displayHeight); }
                    finally { value.close(); }
                }
            })().catch(() => {});
        } catch { /* The video element supplies frames on platforms with a worker-only processor. */ }
    }
    if (manual && typeof player.requestVideoFrameCallback === 'function') {
        const onFrame = () => { if (!stopped) { drawVideo(); callback = player.requestVideoFrameCallback(onFrame); } };
        callback = player.requestVideoFrameCallback(onFrame);
    }
    drawVideo();
    const timer = setInterval(drawVideo, interval);
    clean.push(() => {
        stopped = true;
        clearInterval(timer);
        if (callback !== undefined) player.cancelVideoFrameCallback(callback);
        reader?.cancel().catch(() => {});
    });
    return { track: out, ...size };
}

export async function recordingSource(source, quality, withAudio, archiveScreen = false, archiveHd = false, allowFrame = () => true) {
    if (archiveHd && !selectMime((m) => MediaRecorder.isTypeSupported(m), true)) throw new ArchiveEncoderUnavailable('此浏览器无法使用 H.265、AV1 或 H.264 编码');
    const original = source.getVideoTracks()[0];
    if (!original || original.readyState === 'ended') throw new Error('采集轨道已结束');
    const videoTrack = original.clone();
    const clean = [() => videoTrack.stop()];
    const close = () => { for (const f of clean.splice(0).reverse()) f(); };
    try {
        const canDraw = typeof HTMLCanvasElement.prototype.captureStream === 'function';
        let output;
        if (archiveScreen && canDraw) {
            const resources = [];
            try { output = await canvasSource(videoTrack, quality, resources, true, allowFrame); clean.push(...resources); }
            catch { for (const f of resources.reverse()) f(); }
        }
        if (!output) {
            const settings = original.getSettings();
            const ratio = settings.aspectRatio || (settings.width && settings.height ? settings.width / settings.height : 16 / 9);
            const limits = { width: { max: Math.round(quality.height * ratio) }, height: { max: quality.height }, frameRate: { max: quality.fps } };
            let constrained = true;
            try { await videoTrack.applyConstraints(limits); } catch { constrained = false; }
            const actual = videoTrack.getSettings();
            if (!archiveScreen && canDraw && (!constrained || !actual.height || actual.height > quality.height || !actual.frameRate || actual.frameRate > quality.fps + 0.1)) {
                output = await canvasSource(videoTrack, quality, clean, false, allowFrame);
            } else {
                if (archiveHd && (!actual.width || !actual.height || actual.height > quality.height || !actual.frameRate || actual.frameRate > quality.fps + 0.1)) {
                    throw new ArchiveEncoderUnavailable('无法按所选尺寸和帧率采集屏幕');
                }
                output = { track: videoTrack, width: actual.width, height: actual.height };
            }
        }
        const audio = withAudio ? source.getAudioTracks().map((audioTrack) => audioTrack.clone()) : [];
        clean.push(() => audio.forEach((t) => t.stop()));
        return { stream: new MediaStream([output.track, ...audio]), width: output.width, height: output.height, archiveHd, close };
    } catch (error) { close(); throw error; }
}

const codecOf = (value) => /\b(hvc1|hev1|hevc|h265)\b/i.test(value) ? 'hevc' : /\b(avc1|avc3|h264)\b/i.test(value) ? 'h264'
    : /\b(av01|av1)\b/i.test(value) ? 'av1' : /\b(vp9|vp09)\b/i.test(value) ? 'vp9' : /\b(vp8|vp08)\b/i.test(value) ? 'vp8' : 'unknown';

function box(view, offset, end) {
    if (offset + 8 > view.byteLength) return null;
    let bytes = view.getUint32(offset), header = 8;
    const type = String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + offset + 4, 4));
    if (bytes === 1) {
        if (offset + 16 > view.byteLength) return null;
        bytes = Number(view.getBigUint64(offset + 8)); header = 16;
    }
    if (!bytes) bytes = end - offset;
    if (!Number.isSafeInteger(bytes) || bytes < header || offset + bytes > end) return null;
    return { type, body: offset + header, end: offset + bytes };
}

// MediaRecorder's MIME is a negotiation hint. Check the video sample entry of the actual MP4;
// major/compatible brands alone do not identify the video track. Skip mdat without reading it.
export async function mp4VideoInfo(blob) {
    const containers = ['trak', 'mdia', 'minf', 'stbl'];
    function scan(view, from, end, depth) {
        for (let i = from; i < end;) {
            const part = box(view, i, end);
            if (!part) break;
            if (depth < containers.length && part.type === containers[depth]) {
                const found = scan(view, part.body, part.end, depth + 1);
                if (found) return found;
            }
            if (depth === containers.length && part.type === 'stsd' && part.body + 8 <= part.end) {
                for (let j = part.body + 8; j < part.end;) {
                    const entry = box(view, j, part.end);
                    if (!entry) break;
                    const codec = codecOf(entry.type);
                    if (codec !== 'unknown' && entry.body + 28 <= entry.end) {
                        return { codec, width: view.getUint16(entry.body + 24), height: view.getUint16(entry.body + 26) };
                    }
                    j = entry.end;
                }
            }
            i = part.end;
        }
        return null;
    }
    for (let i = 0; i + 8 <= blob.size;) {
        const prefix = new DataView(await blob.slice(i, i + 16).arrayBuffer());
        const part = box(prefix, 0, blob.size - i);
        if (!part) break;
        if (part.type === 'moov' && part.end - part.body <= 4 * 1024 * 1024) {
            const view = new DataView(await blob.slice(i + part.body, i + part.end).arrayBuffer());
            return scan(view, 0, view.byteLength, 0);
        }
        i += part.end;
    }
    return null;
}

// WebM exposes the codec in the selected video TrackEntry, including generic MIME responses.
export async function webmVideoInfo(blob) {
    const data = new Uint8Array(await blob.slice(0, 256 * 1024).arrayBuffer());
    function vint(at, isId) {
        if (at >= data.length || !data[at]) return null;
        let marker = 128, length = 1;
        while (!(data[at] & marker)) { length++; marker >>= 1; }
        if (length > (isId ? 4 : 8) || at + length > data.length) return null;
        let value = isId ? data[at] : data[at] & (marker - 1);
        let unknown = !isId && value === marker - 1;
        for (let i = 1; i < length; i++) {
            value = value * 256 + data[at + i];
            unknown &&= data[at + i] === 255;
        }
        return { length, value: unknown ? Infinity : value };
    }
    function* children(from, to) {
        for (let at = from; at < to;) {
            const id = vint(at, true);
            if (!id) return;
            const size = vint(at + id.length, false);
            if (!size) return;
            const body = at + id.length + size.length;
            const end = Math.min(to, body + size.value);
            if (body > end) return;
            yield { id: id.value, body, end };
            at = end;
        }
    }
    const integer = (entry) => data.slice(entry.body, entry.end).reduce((n, b) => n * 256 + b, 0);
    for (const segment of children(0, data.length)) if (segment.id === 0x18538067) {
        for (const tracks of children(segment.body, segment.end)) if (tracks.id === 0x1654ae6b) {
            for (const entry of children(tracks.body, tracks.end)) if (entry.id === 0xae) {
                const fields = [...children(entry.body, entry.end)];
                const type = fields.find((f) => f.id === 0x83);
                const id = fields.find((f) => f.id === 0x86);
                if (!type || integer(type) !== 1 || !id) continue;
                const code = new TextDecoder().decode(data.slice(id.body, id.end));
                const codec = { V_AV1: 'av1', 'V_MPEG4/ISO/AVC': 'h264', 'V_MPEGH/ISO/HEVC': 'hevc', V_VP9: 'vp9', V_VP8: 'vp8' }[code] || 'unknown';
                const output = { codec };
                const video = fields.find((f) => f.id === 0xe0);
                if (video) for (const size of children(video.body, video.end)) {
                    if (size.id === 0xb0) output.width = integer(size);
                    if (size.id === 0xba) output.height = integer(size);
                }
                return output;
            }
        }
    }
    return null;
}

// Every stop closes an independently decodable container. An encoder can reject a stream
// after isTypeSupported succeeded; try other spellings or encoders within this stream's policy.
export async function recordSegment(source, quality, durationMs, signal, serverNow, test = false, limit = Infinity) {
    const cutoff = typeof limit === 'function' ? limit : () => limit;
    const candidates = (source.archiveHd ? ARCHIVE_MIME : MIME).filter((type) => MediaRecorder.isTypeSupported(type));
    const preferred = source.workingMime;
    if (preferred && candidates.includes(preferred)) {
        candidates.splice(candidates.indexOf(preferred), 1);
        candidates.unshift(preferred);
    }
    const deadline = performance.now() + durationMs;
    const failed = source.failedMimes ||= new Set();
    let lastError;
    for (const mime of candidates) {
        if (failed.has(mime)) continue;
        if (signal.aborted || source.stream.getVideoTracks()[0].readyState === 'ended') return null;
        const attemptTick = performance.now(), attemptMs = serverNow();
        const limitAtStart = cutoff();
        const remaining = Math.min(deadline - attemptTick, limitAtStart - attemptMs);
        if (remaining <= 0) return null;
        try {
            // Persist a good probe as an ordinary segment. A lying or unavailable encoder
            // can cost a short probe, never a whole minute on every segment rotation.
            const duration = source.archiveHd && mime !== preferred ? Math.min(2000, remaining) : remaining;
            const result = await encodeSegment(source.stream, quality, duration, signal, serverNow, test, mime);
            if (!result) {
                if (signal.aborted) return null;
                throw new Error('编码器没有生成视频');
            }
            const info = result.mime === 'video/mp4' ? await mp4VideoInfo(result.blob)
                : source.archiveHd ? await webmVideoInfo(result.blob) : null;
            const codec = info?.codec ?? codecOf(result.reportedMime);
            if (source.archiveHd && info?.codec !== codecOf(mime)) throw new Error('无法验证归档文件的实际视频编码');
            source.workingMime = mime;
            const { reportedMime, ...segment } = result;
            const currentLimit = cutoff();
            // A retroactive end time can cut through already encoded media. We cannot trim
            // a browser container by changing its timestamps; discard it and report the gap.
            if (currentLimit < limitAtStart && segment.endMs > currentLimit) {
                if (currentLimit > segment.startMs) await source.onLost?.(segment.startMs, currentLimit);
                return null;
            }
            const endMs = Math.min(segment.endMs, currentLimit);
            return endMs > segment.startMs ? { ...segment, endMs, codec, width: info?.width || source.width, height: info?.height || source.height } : null;
        } catch (error) {
            if (signal.aborted || source.stream.getVideoTracks()[0].readyState === 'ended') return null;
            failed.add(mime);
            if (source.workingMime === mime) source.workingMime = null;
            lastError = error;
            const to = Math.min(cutoff(), attemptMs + Math.round(performance.now() - attemptTick));
            if (to - attemptMs > 250) await source.onLost?.(attemptMs, to);
        }
    }
    if (signal.aborted) return null;
    const reason = lastError?.message || '浏览器没有可用的视频编码器';
    if (source.archiveHd) throw new ArchiveEncoderUnavailable(reason);
    throw new Error(reason);
}

function encodeSegment(stream, quality, durationMs, signal, serverNow, test, mimeType) {
    return new Promise((resolve, reject) => {
        const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: quality.kbps * 1000 });
        const startMs = serverNow();
        const startTick = performance.now();
        const track = stream.getVideoTracks()[0];
        const chunks = [];
        const dropped = () => {
            try {
                const stats = track.stats?.toJSON?.() || track.stats;
                return Number.isFinite(stats?.totalFrames) ? [stats.totalFrames, stats.discardedFrames || 0] : null;
            } catch { return null; }
        };
        const initial = test ? dropped() : null;
        let probe = null;
        let frames = 0;
        let callback;
        let firstPresented;
        let lastPresented;
        if (test && !initial && typeof HTMLVideoElement.prototype.requestVideoFrameCallback === 'function') {
            probe = document.createElement('video');
            probe.muted = true;
            probe.playsInline = true;
            probe.srcObject = new MediaStream([track]);
            const count = (_, meta) => {
                if (!probe) return;
                firstPresented ??= meta.presentedFrames;
                lastPresented = meta.presentedFrames;
                frames++;
                callback = probe.requestVideoFrameCallback(count);
            };
            probe.play().catch(() => {});
            callback = probe.requestVideoFrameCallback(count);
        }
        let stoppedAt;
        const stop = () => {
            stoppedAt ??= performance.now();
            if (recorder.state !== 'inactive') recorder.stop();
        };
        const timer = setTimeout(stop, durationMs);
        const cleanup = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', stop);
            track.removeEventListener('ended', stop);
            if (probe) { probe.cancelVideoFrameCallback(callback); probe.pause(); probe.srcObject = null; probe = null; }
        };
        signal.addEventListener('abort', stop, { once: true });
        track.addEventListener('ended', stop, { once: true });
        recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
        recorder.onerror = (e) => {
            cleanup();
            reject(e.error || new Error('浏览器编码失败'));
            try { stop(); } catch { /* The failed encoder may have already stopped. */ }
        };
        recorder.onstop = async () => {
            const endMs = startMs + Math.max(1, Math.round((stoppedAt ?? performance.now()) - startTick));
            const final = test && dropped();
            let dropRate = null;
            if (initial && final && final[0] > initial[0]) dropRate = Math.max(0, (final[1] - initial[1]) / (final[0] - initial[0]));
            else if (frames > 1) dropRate = Math.max(0, 1 - frames / (lastPresented - firstPresented + 1));
            cleanup();
            if (!chunks.length) { resolve(null); return; }
            try {
                const reportedMime = chunks[0]?.type || recorder.mimeType || mimeType;
                const mime = reportedMime.split(';')[0].trim().toLowerCase();
                let blob = new Blob(chunks, { type: mime });
                if (mime === 'video/webm') blob = await window.ysFixWebmDuration(blob, endMs - startMs, { logger: false });
                resolve({ blob, mime, reportedMime, startMs, endMs, dropRate });
            } catch (error) { reject(error); }
        };
        try { recorder.start(); } catch (error) { cleanup(); reject(error); }
    });
}
