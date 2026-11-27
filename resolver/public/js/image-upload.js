// Canvas decoding applies EXIF orientation and converts the source colour space to sRGB.
export async function printableImage(blob, longest, type = 'image/png', byteLimit = Infinity) {
    const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    try {
        if (bitmap.width * bitmap.height > 40_000_000) throw new Error('图片超过 4000 万像素，请缩小后再上传');
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, longest / Math.max(bitmap.width, bitmap.height));
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const output = blob.type === 'image/jpeg' ? 'image/jpeg' : type;
        const context = canvas.getContext('2d', { colorSpace: 'srgb' });
        if (output === 'image/jpeg') {
            context.fillStyle = '#fff';
            context.fillRect(0, 0, canvas.width, canvas.height);
        }
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
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
