const MIME = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/mp4', 'video/webm'];
export const selectMime = (supported) => MIME.find((type) => supported(type));

export async function recordingSource(source, quality, withAudio) {
    const original = source.getVideoTracks()[0];
    if (!original || original.readyState === 'ended') throw new Error('采集轨道已结束');
    const videoTrack = original.clone();
    const clean = [() => videoTrack.stop()];
    try {
        let track = videoTrack;
        const settings = original.getSettings();
        const ratio = settings.aspectRatio || (settings.width && settings.height ? settings.width / settings.height : 16 / 9);
        const limits = { width: { max: Math.round(quality.height * ratio) }, height: { max: quality.height }, frameRate: { max: quality.fps } };
        let constrained = true;
        try { await videoTrack.applyConstraints(limits); } catch { constrained = false; }
        const actual = videoTrack.getSettings();
        if ((!constrained || !actual.height || actual.height > quality.height || !actual.frameRate || actual.frameRate > quality.fps + 0.1)
            && typeof HTMLCanvasElement.prototype.captureStream === 'function') {
            // Drawing the source video avoids altering the track feeding WebRTC.
            const player = document.createElement('video');
            player.muted = true;
            player.playsInline = true;
            player.srcObject = new MediaStream([videoTrack]);
            clean.push(() => { player.pause(); player.srcObject = null; });
            await Promise.race([player.play(), new Promise((_, reject) => {
                const t = setTimeout(() => reject(new Error('无法读取采集画面')), 5000);
                clean.push(() => clearTimeout(t));
            })]);
            const canvas = document.createElement('canvas');
            canvas.height = Math.max(2, Math.round(Math.min(player.videoHeight || quality.height, quality.height) / 2) * 2);
            canvas.width = Math.max(2, 2 * Math.round(canvas.height * (player.videoWidth || 16) / (player.videoHeight || 9) / 2));
            const ctx = canvas.getContext('2d');
            const draw = () => { if (player.readyState >= 2) ctx.drawImage(player, 0, 0, canvas.width, canvas.height); };
            draw();
            const timer = setInterval(draw, 1000 / quality.fps);
            clean.push(() => clearInterval(timer));
            track = canvas.captureStream(quality.fps).getVideoTracks()[0];
            clean.push(() => track.stop());
        }
        const audio = withAudio ? source.getAudioTracks().map((audioTrack) => audioTrack.clone()) : [];
        clean.push(() => audio.forEach((t) => t.stop()));
        return { stream: new MediaStream([track, ...audio]), close: () => clean.forEach((f) => f()) };
    } catch (error) { clean.forEach((f) => f()); throw error; }
}

// Every stop closes a real independently decodable container. Reusing one recorder with a
// timeslice yields continuation fragments which cannot be sought or played on their own.
export function recordSegment(stream, quality, durationMs, signal, serverNow, test = false) {
    return new Promise((resolve, reject) => {
        if (signal.aborted || durationMs <= 0) { resolve(null); return; }
        const mimeType = selectMime((type) => MediaRecorder.isTypeSupported(type));
        if (!mimeType) { reject(new Error('浏览器不支持 MP4 或 WebM 录像')); return; }
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
        const stop = () => { if (recorder.state !== 'inactive') recorder.stop(); };
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
        recorder.onerror = (e) => { cleanup(); reject(e.error || new Error('浏览器编码失败')); };
        recorder.onstop = async () => {
            const endMs = startMs + Math.max(1, Math.round(performance.now() - startTick));
            const final = test && dropped();
            let dropRate = null;
            if (initial && final && final[0] > initial[0]) dropRate = Math.max(0, (final[1] - initial[1]) / (final[0] - initial[0]));
            else if (frames > 1) dropRate = Math.max(0, 1 - frames / (lastPresented - firstPresented + 1));
            cleanup();
            if (!chunks.length) { resolve(null); return; }
            try {
                const mime = mimeType.split(';')[0];
                let blob = new Blob(chunks, { type: mime });
                if (mime === 'video/webm') blob = await window.ysFixWebmDuration(blob, endMs - startMs, { logger: false });
                resolve({ blob, mime, startMs, endMs, dropRate });
            } catch (error) { reject(error); }
        };
        try { recorder.start(); } catch (error) { cleanup(); reject(error); }
    });
}
