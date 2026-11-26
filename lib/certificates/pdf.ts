/**
 * A small PDF 1.7 writer for certificates: A4 pages with an optional background image, text lines and a QR code.
 *
 * Chinese text uses the PDF reader's own Adobe-GB1 fonts (STSong-Light for 宋体, STHeiti-Regular for 黑体, UTF-16
 * CMap), which Acrobat, Preview, Chrome and pdf.js provide without embedding; Latin text uses the standard Times
 * and Helvetica fonts. The event certificate also embeds the two Arial subsets from its reference PDF.
 */
import { deflateSync, inflateSync } from 'node:zlib';
import { addEventFont, eventAdvances, eventGlyphs, eventString, type EventWeight } from './event-fonts';
import { certificateFrame } from '../../resolver/public/js/certificate-frame.js';
import type { CertificateDesign } from '../../resolver/public/js/certificate-designs.js';

export type FontStyle = 'serif' | 'sans';
export type Align = 'left' | 'center' | 'right';
export interface PdfImage { width: number; height: number; colors: 1 | 3; filter: 'DCTDecode' | 'FlateDecode'; data: Buffer; alpha?: Buffer }
interface ImageBox { x: number; y: number; width: number; height: number }
export interface PlacedImage extends ImageBox { image: PdfImage; clip?: ImageBox }
export interface NativeSignature { image: PdfImage; drawing: Buffer }
export interface PdfText {
    text: string;
    /** Millimetres from the left edge to the anchor given by `align`. */
    x: number;
    /** Millimetres from the top edge to the middle of the line. */
    y: number;
    /** Points. */
    size: number;
    align: Align;
    font: FontStyle;
    eventWeight?: EventWeight;
    bold?: boolean;
    /** Longest line in millimetres; longer text is set smaller. 0: no limit. */
    width: number;
    color: [number, number, number];
}
export interface PdfQr { matrix: boolean[][]; x: number; y: number; size: number }
export interface PdfPage {
    width: number;
    height: number;
    background?: PdfImage | null;
    border?: boolean;
    engraved?: boolean;
    design?: CertificateDesign;
    master?: PlacedImage[];
    originalSignature?: NativeSignature;
    logos?: PlacedImage[];
    decorations?: PlacedImage[];
    texts: PdfText[];
    qr?: PdfQr | null;
}

const PT = 72 / 25.4;

// Advance widths (1/1000 em) of the standard fonts for ASCII 32–126 (Adobe font metrics).
const TIMES = [250, 333, 408, 500, 500, 833, 778, 180, 333, 333, 500, 564, 250, 333, 250, 278, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500,
    278, 278, 564, 564, 564, 444, 921, 722, 667, 667, 722, 611, 556, 722, 722, 333, 389, 722, 611, 889, 722, 722, 556, 722, 667, 556, 611, 722,
    722, 944, 722, 722, 611, 333, 278, 333, 469, 500, 333, 444, 500, 444, 500, 444, 333, 500, 500, 278, 278, 500, 278, 778, 500, 500, 500, 500,
    333, 389, 278, 500, 500, 722, 500, 500, 444, 480, 200, 480, 541];
const HELVETICA = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
    278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722,
    667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556,
    333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];

const latin = (code: number) => code >= 32 && code <= 126;

/** Runs of Latin (standard font) and other (Adobe-GB1) characters. */
function runs(text: string) {
    const result: { latin: boolean; text: string }[] = [];
    for (const char of text) {
        const isLatin = latin(char.codePointAt(0)!);
        const last = result.at(-1);
        if (last && last.latin === isLatin) last.text += char;
        else result.push({ latin: isLatin, text: char });
    }
    return result;
}

function runWidth(run: { latin: boolean; text: string }, font: FontStyle) {
    if (!run.latin) return [...run.text].length * 1000;
    const table = font === 'serif' ? TIMES : HELVETICA;
    return [...run.text].reduce((sum, char) => sum + table[char.charCodeAt(0) - 32], 0);
}

/** Width of `text` in points at `size`. */
export function textWidth(text: string, size: number, font: FontStyle) {
    return runs(text).reduce((sum, run) => sum + runWidth(run, font), 0) * size / 1000;
}

const latinString = (text: string) => `(${text.replace(/[\\()]/g, '\\$&')})`;
function utf16Hex(text: string) {
    let hex = '';
    for (let i = 0; i < text.length; i++) hex += text.charCodeAt(i).toString(16).padStart(4, '0');
    return `<${hex}>`;
}
const num = (value: number) => (Math.round(value * 100) / 100).toString();

const MAX_IMAGE_PIXELS = 16_000_000;
const TOO_MANY_PIXELS = `图片超过 ${MAX_IMAGE_PIXELS / 10_000} 万像素，请缩小后再上传`;

/** A JPEG (baseline or progressive, grey or RGB) or a non-interlaced 8-bit PNG, ready to embed. */
export function parseImage(buffer: Buffer, preserveAlpha = false): PdfImage {
    if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8) {
        let offset = 2;
        while (offset < buffer.length) {
            if (buffer[offset] !== 0xff) throw new Error('JPEG 图片已损坏');
            while (offset < buffer.length && buffer[offset] === 0xff) offset++;
            if (offset >= buffer.length) break;
            const marker = buffer[offset++];
            // Standalone markers have no length payload; SOS (0xDA) starts entropy-coded scan data.
            if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
            if (marker === 0xd9 || marker === 0xda) break;
            if (offset + 2 > buffer.length) throw new Error('JPEG 图片已损坏');
            const length = buffer.readUInt16BE(offset);
            if (length < 2 || offset + length > buffer.length) throw new Error('JPEG 图片已损坏');
            if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
                if (length < 8) throw new Error('JPEG 图片已损坏');
                const components = buffer[offset + 7];
                if (components !== 1 && components !== 3) throw new Error('请使用 RGB 或灰度 JPEG（不支持 CMYK）');
                const height = buffer.readUInt16BE(offset + 3); const width = buffer.readUInt16BE(offset + 5);
                if (!height || !width) throw new Error('JPEG 图片尺寸无效');
                if (width * height > MAX_IMAGE_PIXELS) throw new Error(TOO_MANY_PIXELS);
                return { height, width, colors: components, filter: 'DCTDecode', data: buffer };
            }
            offset += length;
        }
        throw new Error('JPEG 图片已损坏');
    }
    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return parsePng(buffer, preserveAlpha);
    throw new Error('请上传 JPEG 或 PNG 图片');
}

function parsePng(buffer: Buffer, preserveAlpha: boolean): PdfImage {
    let offset = 8;
    let width = 0; let height = 0; let depth = 0; let type = 0; let interlace = 0;
    let palette: Buffer | null = null;
    let transparency: Buffer | null = null;
    const data: Buffer[] = [];
    while (offset + 12 <= buffer.length) {
        const length = buffer.readUInt32BE(offset);
        if (offset + 12 + length > buffer.length) throw new Error('PNG 图片已损坏');
        const name = buffer.toString('latin1', offset + 4, offset + 8);
        const body = buffer.subarray(offset + 8, offset + 8 + length);
        if (name === 'IHDR') {
            if (body.length < 13) throw new Error('PNG 图片已损坏');
            width = body.readUInt32BE(0); height = body.readUInt32BE(4); depth = body[8]; type = body[9]; interlace = body[12];
        } else if (name === 'PLTE') palette = body;
        else if (name === 'tRNS') transparency = body;
        else if (name === 'IDAT') data.push(body);
        else if (name === 'IEND') break;
        offset += 12 + length;
    }
    if (depth !== 8 || interlace !== 0 || ![0, 2, 3, 4, 6].includes(type)) throw new Error('请使用 8 位、非隔行扫描的 PNG');
    if (!width || !height) throw new Error('PNG 图片尺寸无效');
    if (width * height > MAX_IMAGE_PIXELS) throw new Error(TOO_MANY_PIXELS);
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type]!;
    const stride = width * channels;
    const expected = (stride + 1) * height;
    const raw = inflateSync(Buffer.concat(data), { maxOutputLength: expected });
    if (raw.length !== expected) throw new Error('PNG 像素数据无效');
    const pixels = Buffer.alloc(stride * height);
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)];
        if (filter > 4) throw new Error('PNG 滤波类型无效');
        const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
        const out = pixels.subarray(y * stride, (y + 1) * stride);
        const up = y ? pixels.subarray((y - 1) * stride, y * stride) : null;
        for (let i = 0; i < stride; i++) {
            const a = i >= channels ? out[i - channels] : 0;
            const b = up ? up[i] : 0;
            const c = up && i >= channels ? up[i - channels] : 0;
            let value = line[i];
            if (filter === 1) value += a;
            else if (filter === 2) value += b;
            else if (filter === 3) value += (a + b) >> 1;
            else if (filter === 4) {
                const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
                value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
            }
            out[i] = value & 0xff;
        }
    }
    // Backgrounds print over white. Logo masks must retain the paper or uploaded artwork behind them.
    const gray = type === 0 || type === 4;
    const colors = gray ? 1 : 3;
    const result = Buffer.alloc(width * height * colors);
    const mask = preserveAlpha && (type === 4 || type === 6 || transparency) ? Buffer.alloc(width * height) : null;
    for (let i = 0; i < width * height; i++) {
        let rgb: number[];
        let alpha = 255;
        if (type === 3) {
            const index = pixels[i];
            if (!palette || index * 3 + 2 >= palette.length) throw new Error('PNG 调色板无效');
            rgb = [palette[index * 3], palette[index * 3 + 1], palette[index * 3 + 2]];
            if (transparency && index < transparency.length) alpha = transparency[index];
        } else {
            const base = i * channels;
            rgb = gray ? [pixels[base]] : [pixels[base], pixels[base + 1], pixels[base + 2]];
            if (type === 4) alpha = pixels[base + 1];
            if (type === 6) alpha = pixels[base + 3];
            if ((type === 0 || type === 2) && transparency?.length === colors * 2
                && rgb.every((value, k) => value === transparency!.readUInt16BE(k * 2))) alpha = 0;
        }
        if (mask) mask[i] = alpha;
        rgb.forEach((value, k) => { result[i * colors + k] = mask ? value : Math.round((value * alpha + 255 * (255 - alpha)) / 255); });
    }
    return { width, height, colors, filter: 'FlateDecode', data: deflateSync(result),
        ...(mask?.some((alpha) => alpha !== 255) ? { alpha: deflateSync(mask) } : {}) };
}

/** Choose a font and its actual advance for each run, including fallback characters outside the event subsets. */
function encodedRuns(item: PdfText) {
    const weight = item.eventWeight;
    if (!weight) return runs(item.text).map((run) => ({
        font: run.latin ? (item.font === 'serif' ? 'F1' : 'F2') : (item.font === 'serif' ? 'F3' : 'F4'),
        width: runWidth(run, item.font), encoded: run.latin ? latinString(run.text) : utf16Hex(run.text),
    }));
    const glyphs = eventGlyphs(weight);
    const advances = eventAdvances(weight, item.size);
    const parts: { font: string; text: string; width: number }[] = [];
    const tokens = item.text.match(/ +|[^ ]/gu) || [];
    for (const [index, token] of tokens.entries()) {
        const char = token[0];
        const glyph = glyphs[char];
        const ascii = latin(char.codePointAt(0)!);
        const font = glyph ? (weight === 'bold' ? 'EB' : 'ER') : ascii ? (weight === 'bold' ? 'FB' : 'F2') : 'F4';
        const next = tokens[index + 1] || '';
        const measured = next ? advances?.width[token] ?? (char === ' ' && advances?.width[' '] ? advances.width[' '] * token.length : undefined) : undefined;
        const pair = token + next + (next.startsWith(' ') ? tokens[index + 2] || '' : '');
        const kern = advances?.kern[pair] || 0;
        const advance = measured !== undefined ? measured * 1000 / item.size
            : (glyph ? glyph[1] : ascii ? HELVETICA[char.charCodeAt(0) - 32] : 1000) * [...token].length;
        const width = advance + kern * 1000 / item.size;
        const last = parts.at(-1);
        if (!advances && last?.font === font) { last.text += token; last.width += width; }
        else parts.push({ font, text: token, width });
    }
    return parts.map((part) => ({ ...part, encoded: part.font === 'EB' || part.font === 'ER'
        ? eventString(part.text, weight) : part.font === 'F4' ? utf16Hex(part.text) : latinString(part.text) }));
}

function fitted(text: PdfText, width: number) {
    let size = text.size;
    if (text.width > 0) {
        const limit = text.width * PT;
        if (width > limit) size = Math.max(4, size * limit / width);
    }
    return size;
}

// A ZIP prints each recipient to a separate PDF using the same A4 engraving.
const a4Frames = new Map<string, Buffer>();
function frameContent(width: number, height: number, design: CertificateDesign = 'engraved') {
    const key = `${design}/${width}/${height}`;
    const cached = a4Frames.get(key);
    if (cached) return cached;
    const ops = [`q ${PT} 0 0 ${-PT} 0 ${num(height * PT)} cm 1 J 1 j`];
    const color = (hex: string) => [1, 3, 5].map((i) => num(parseInt(hex.slice(i, i + 2), 16) / 255)).join(' ');
    for (const path of certificateFrame(width, height, design)) {
        if (path.fill) ops.push(`${color(path.fill)} rg`);
        if (path.stroke) ops.push(`${color(path.stroke)} RG ${path.weight} w`);
        for (const [op, ...coords] of path.commands) ops.push(op === 'Z' ? 'h' : `${coords.join(' ')} ${op.toLowerCase()}`);
        ops.push(path.fill ? 'f' : 'S');
    }
    const compressed = deflateSync(ops.concat('Q').join('\n'));
    if ((width === 297 && height === 210) || (width === 210 && height === 297)) a4Frames.set(key, compressed);
    return compressed;
}

function pageContent(page: PdfPage, paint: string[]) {
    const height = page.height * PT;
    const ops = [...paint];
    for (const item of page.texts) {
        if (!item.text) continue;
        const parts = encodedRuns(item);
        const em = parts.reduce((sum, part) => sum + part.width, 0) / 1000;
        const size = fitted(item, em * item.size);
        const total = em * size;
        let x = item.x * PT - (item.align === 'center' ? total / 2 : item.align === 'right' ? total : 0);
        // The middle of a CJK line sits about 0.35 em above its baseline.
        const y = height - item.y * PT - size * 0.35;
        // Coordinate rounding would collapse adjacent 8-bit colors (e.g. #010101 and black).
        const color = item.color.map((channel) => Number((channel / 255).toFixed(6))).join(' ');
        if (item.bold) ops.push(`q ${color} RG ${num(size * .017)} w 1 j`);
        ops.push(`${color} rg`);
        for (const run of parts) {
            ops.push(`BT ${item.bold ? '2 Tr ' : ''}/${run.font} ${num(size)} Tf 1 0 0 1 ${num(x)} ${num(y)} Tm ${run.encoded} Tj ET`);
            x += run.width * size / 1000;
        }
        if (item.bold) ops.push('Q');
    }
    if (page.qr) {
        const count = page.qr.matrix.length + 8;
        const cell = page.qr.size * PT / count;
        const left = (page.qr.x - page.qr.size / 2) * PT;
        const top = height - (page.qr.y - page.qr.size / 2) * PT;
        ops.push('q 1 1 1 rg', `${num(left)} ${num(top - count * cell)} ${num(count * cell)} ${num(count * cell)} re f`, '0 0 0 rg');
        page.qr.matrix.forEach((row, y) => {
            for (let x = 0; x < row.length;) {
                if (!row[x]) { x++; continue; }
                let end = x;
                while (end < row.length && row[end]) end++;
                ops.push(`${num(left + (x + 4) * cell)} ${num(top - (y + 5) * cell)} ${num((end - x) * cell)} ${num(cell)} re`);
                x = end;
            }
        });
        ops.push('f Q');
    }
    return ops.join('\n');
}

/** Shared imagery and each engraved master are embedded once in a multi-page export. */
export function buildPdf(pages: PdfPage[], title = '证书'): Buffer {
    const objects: (Buffer | string)[] = [];
    const add = (body: Buffer | string) => { objects.push(body); return objects.length; };
    const stream = (dictionary: string, data: Buffer) => Buffer.concat([Buffer.from(`<< ${dictionary} /Length ${data.length} >>\nstream\n`), data, Buffer.from('\nendstream')]);
    const catalog = add('');
    const pagesId = add('');
    const cjk = (name: string, flags: number) => {
        const descriptor = add(`<< /Type /FontDescriptor /FontName /${name} /Flags ${flags} /FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 93 >>`);
        const descendant = add(`<< /Type /Font /Subtype /CIDFontType0 /BaseFont /${name} /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /FontDescriptor ${descriptor} 0 R /DW 1000 >>`);
        return add(`<< /Type /Font /Subtype /Type0 /BaseFont /${name}-UniGB-UTF16-H /Encoding /UniGB-UTF16-H /DescendantFonts [${descendant} 0 R] >>`);
    };
    const fonts: Record<string, number> = {
        F1: add('<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /WinAnsiEncoding >>'),
        F2: add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'),
        F3: cjk('STSong-Light', 6),
        F4: cjk('STHeiti-Regular', 4),
    };
    if (pages.some((page) => page.originalSignature || page.texts.some((item) => item.eventWeight))) {
        fonts.ER = addEventFont('regular', add, stream);
        fonts.EB = addEventFont('bold', add, stream);
        fonts.FB = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    }
    const fontDict = Object.entries(fonts).map(([name, id]) => `/${name} ${id} 0 R`).join(' ');
    const images = new Map<PdfImage, number>();
    const imageId = (image: PdfImage) => {
        const known = images.get(image);
        if (known) return known;
        const common = `/Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /BitsPerComponent 8`;
        const mask = image.alpha ? add(stream(`${common} /ColorSpace /DeviceGray /Filter /FlateDecode`, image.alpha)) : null;
        const id = add(stream(`${common} /ColorSpace /${image.colors === 1 ? 'DeviceGray' : 'DeviceRGB'} /Filter /${image.filter}${mask ? ` /SMask ${mask} 0 R` : ''}`, image.data));
        images.set(image, id);
        return id;
    };
    const frames = new Map<string, number>();
    let signatureForm: number | undefined;
    const kids: number[] = [];
    for (const page of pages) {
        const resources = [`/Font << ${fontDict} >>`];
        const objects = new Map<string, number>();
        const paint: string[] = [];
        if (page.engraved && !page.background) {
            const key = `${page.design ?? 'engraved'}/${page.width}/${page.height}`;
            if (!frames.has(key)) {
                const bounds = `0 0 ${num(page.width * PT)} ${num(page.height * PT)}`;
                const drawing = stream(`/Type /XObject /Subtype /Form /BBox [${bounds}] /Resources << >> /Filter /FlateDecode`, frameContent(page.width, page.height, page.design));
                frames.set(key, add(drawing));
            }
            objects.set('Frame', frames.get(key)!);
            paint.push('q /Frame Do Q');
        }
        const draw = ({ image, x, y, width, height, clip }: PlacedImage) => {
            const id = imageId(image);
            objects.set(`Im${id}`, id);
            const mask = clip ? `${num(clip.x * PT)} ${num((page.height - clip.y - clip.height) * PT)} ${num(clip.width * PT)} ${num(clip.height * PT)} re W n ` : '';
            paint.push(`q ${mask}${num(width * PT)} 0 0 ${num(height * PT)} ${num(x * PT)} ${num((page.height - y - height) * PT)} cm /Im${id} Do Q`);
        };
        if (page.background) draw({ image: page.background, x: 0, y: 0, width: page.width, height: page.height });
        if (page.border) {
            const rect = (d: number) => `${num(d * PT)} ${num(d * PT)} ${num((page.width - 2*d) * PT)} ${num((page.height - 2*d) * PT)} re S`;
            paint.push('q 0.55 0.42 0.18 RG 2 w', rect(10), '0.6 w', rect(13), 'Q');
        }
        for (const image of page.master || []) draw(image);
        if (page.originalSignature) {
            if (!signatureForm) {
                const image = imageId(page.originalSignature.image);
                const resources = `/Resources << /Font << /FT10 ${fonts.ER} 0 R /FT15 ${fonts.EB} 0 R >> /XObject << /IM20 ${image} 0 R >> >>`;
                signatureForm = add(stream(`/Type /XObject /Subtype /Form /BBox [0 0 841.9 595.3] ${resources} /Filter /FlateDecode`, page.originalSignature.drawing));
            }
            objects.set('Signature', signatureForm);
            paint.push('q /Signature Do Q');
        }
        for (const decoration of page.decorations || []) draw(decoration);
        for (const logo of page.logos || []) draw(logo);
        if (objects.size) resources.push(`/XObject << ${[...objects].map(([key, id]) => `/${key} ${id} 0 R`).join(' ')} >>`);
        const content = add(stream('/Filter /FlateDecode', deflateSync(Buffer.from(pageContent(page, paint), 'latin1'))));
        kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${num(page.width * PT)} ${num(page.height * PT)}] /Resources << ${resources.join(' ')} >> /Contents ${content} 0 R >>`));
    }
    objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
    objects[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(' ')}] /Count ${kids.length} >>`;
    const info = add(`<< /Title ${utf16Hex(`﻿${title}`)} /Producer (Hydro Contest Better) >>`);
    const parts: Buffer[] = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
    let length = parts[0].length;
    const offsets: number[] = [];
    objects.forEach((body, index) => {
        offsets.push(length);
        const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'), Buffer.from('\nendobj\n')]);
        parts.push(chunk);
        length += chunk.length;
    });
    const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)].join('');
    parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${length}\n%%EOF\n`));
    return Buffer.concat(parts);
}
