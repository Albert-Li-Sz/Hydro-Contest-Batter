/**
 * The largest `aspect` (width / height) rectangle inside the image, centred on `focus` (fractions of
 * the width and height) as far as the edges allow. The default focus sits above the middle, where
 * the heads are in a team photo.
 */
export function cropBox(width, height, aspect, focus = { x: 0.5, y: 0.35 }) {
    const w = Math.min(width, height * aspect), h = w / aspect;
    const clamp = (value, max) => Math.max(0, Math.min(max, value));
    return { x: clamp(focus.x * width - w / 2, width - w), y: clamp(focus.y * height - h / 2, height - h), width: w, height: h };
}

/** Where the faces are, when the browser can tell (Shape Detection API); otherwise the default focus. */
export async function photoFocus(bitmap) {
    try {
        if (typeof FaceDetector !== 'function') return undefined;
        const faces = await new FaceDetector({ fastMode: true, maxDetectedFaces: 12 }).detect(bitmap);
        if (!faces.length) return undefined;
        const left = Math.min(...faces.map(f => f.boundingBox.left)), right = Math.max(...faces.map(f => f.boundingBox.right));
        const top = Math.min(...faces.map(f => f.boundingBox.top)), bottom = Math.max(...faces.map(f => f.boundingBox.bottom));
        return { x: (left + right) / 2 / bitmap.width, y: (top + bottom) / 2 / bitmap.height };
    } catch { return undefined; }
}

// Canvas decoding applies EXIF orientation and converts the source colour space to sRGB.
// `crop` ({ aspect, focus }) cuts the picture to that shape first; focus 'auto' looks for faces.
export async function printableImage(blob, longest, type = 'image/png', byteLimit = Infinity, crop = null) {
    const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    try {
        if (bitmap.width * bitmap.height > 40_000_000) throw new Error('图片超过 4000 万像素，请缩小后再上传');
        const canvas = document.createElement('canvas');
        const focus = crop?.focus === 'auto' ? await photoFocus(bitmap) : crop?.focus;
        const box = crop ? cropBox(bitmap.width, bitmap.height, crop.aspect, focus) : { x: 0, y: 0, width: bitmap.width, height: bitmap.height };
        const scale = Math.min(1, longest / Math.max(box.width, box.height));
        canvas.width = Math.max(1, Math.round(box.width * scale));
        canvas.height = Math.max(1, Math.round(box.height * scale));
        const output = blob.type === 'image/jpeg' ? 'image/jpeg' : type;
        const context = canvas.getContext('2d', { colorSpace: 'srgb' });
        if (output === 'image/jpeg') {
            context.fillStyle = '#fff';
            context.fillRect(0, 0, canvas.width, canvas.height);
        }
        context.drawImage(bitmap, box.x, box.y, box.width, box.height, 0, 0, canvas.width, canvas.height);
        for (const quality of [.96, .85, .72, .55, .38]) {
            const image = await new Promise((resolve, reject) => canvas.toBlob(
                (out) => out ? resolve(out) : reject(new Error('无法读取图片')), output, quality));
            if (image.size <= byteLimit) return image;
        }
        throw new Error('图片过大，请缩小后再上传');
    } finally { bitmap.close(); }
}
export async function imageData(blob) {
    if (blob.size > 6 * 1024 * 1024) throw new Error('图片最大 6 MiB');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
}
