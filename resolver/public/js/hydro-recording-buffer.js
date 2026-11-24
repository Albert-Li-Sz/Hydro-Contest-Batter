// Metadata is cheap to scan. Keep the actual Blobs separate so a maintenance pass cannot
// pull hundreds of MB into the renderer. Each device/team binding has its own database.
const stores = ['segments', 'blobs', 'jobs', 'requests', 'gaps'];
export const CLIP_AGE = 600_000;
const ARCHIVE_AGE = 1_800_000;
const ARCHIVE_BYTES = 300 * 1024 * 1024;

export function evictedSegments(rows, now, protectedIds) {
    let archiveBytes = 0;
    return rows.slice().sort((a, b) => b.endMs - a.endMs).filter((row) => {
        if (row.kind === 'archive') {
            archiveBytes += row.bytes;
            return row.endMs < now - ARCHIVE_AGE || archiveBytes > ARCHIVE_BYTES;
        }
        return row.endMs < now - CLIP_AGE && !protectedIds.has(row.id);
    });
}

export function segmentsFor(request, rows) {
    const overlapping = rows.filter((s) => s.kind === 'clip' && request.streams.includes(s.stream)
        && s.endMs > request.windowStartMs && s.startMs < request.windowEndMs);
    const reduced = overlapping.filter((s) => s.reduced);
    if (request.priority !== 2 || !reduced.length) return overlapping.filter((s) => !s.reduced);
    // At the transition into congestion keep the high-quality segment that covers a gap.
    return overlapping.filter((s) => s.reduced || !reduced.some((low) => low.stream === s.stream
        && low.startMs <= s.startMs + 300 && low.endMs >= s.endMs - 300));
}

export function nextUpload(jobs, now) {
    return jobs.filter((j) => (j.retryAt || 0) <= now)
        .sort((a, b) => a.priority - b.priority || a.created - b.created)[0];
}

export function openBuffer(name) {
    return new Promise((resolve, reject) => {
        const opening = indexedDB.open('hydro-recording-v1:' + name, 1);
        opening.onupgradeneeded = () => {
            for (const store of stores) opening.result.createObjectStore(store);
        };
        opening.onerror = () => reject(opening.error);
        opening.onsuccess = () => {
            const db = opening.result;
            db.onversionchange = () => db.close();
            const read = (store, key) => new Promise((ok, fail) => {
                const request = db.transaction(store).objectStore(store);
                const result = key === undefined ? request.getAll() : request.get(key);
                result.onsuccess = () => ok(result.result);
                result.onerror = () => fail(result.error);
            });
            // One transaction publishes metadata, Blob and initial upload together.
            const write = (entries) => new Promise((ok, fail) => {
                if (!entries.length) { ok(); return; }
                const tx = db.transaction([...new Set(entries.map(([store]) => store))], 'readwrite');
                tx.oncomplete = () => ok();
                tx.onabort = tx.onerror = () => fail(tx.error || new Error('无法保存录像缓存'));
                for (const [store, key, value] of entries) {
                    if (value === undefined) tx.objectStore(store).delete(key);
                    else tx.objectStore(store).put(value, key);
                }
            });
            resolve({ read, write, close: () => db.close() });
        };
    });
}
