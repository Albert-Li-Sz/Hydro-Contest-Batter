/**
 * Receipt printer output. ESC/POS (Epson's command set, which nearly every thermal receipt printer
 * speaks, Chinese models in GB18030/GBK) is built here, so the print client only passes the bytes
 * to the printer; the same lines go along for printers driven through their system driver.
 */
import type { ReceiptConfig, ReceiptLine } from './balloons';

let gbk: Map<string, number> | null | undefined;

/**
 * Unicode → GBK double-byte code, from Node's own GBK decoder (full ICU, the default build): no
 * encoding library needed. null when this Node cannot decode GBK.
 */
function gbkTable() {
    if (gbk !== undefined) return gbk;
    try {
        const decoder = new TextDecoder('gbk', { fatal: true });
        const table = new Map<string, number>();
        const pair = new Uint8Array(2);
        for (let lead = 0x81; lead <= 0xfe; lead++) {
            for (let trail = 0x40; trail <= 0xfe; trail++) {
                if (trail === 0x7f) continue;
                pair[0] = lead; pair[1] = trail;
                let text: string;
                try { text = decoder.decode(pair); } catch { continue; }
                if (text.length === 1 && !table.has(text)) table.set(text, (lead << 8) | trail);
            }
        }
        gbk = table;
    } catch { gbk = null; }
    return gbk;
}

export const gbkAvailable = () => !!gbkTable();

/** Text as the printer's Chinese mode reads it; characters GBK lacks print as `?`. */
export function encodeGbk(text: string) {
    const table = gbkTable();
    const bytes: number[] = [];
    for (const char of text) {
        const code = char.codePointAt(0)!;
        if (code < 0x80) { bytes.push(code); continue; }
        const double = table?.get(char);
        if (double !== undefined) bytes.push(double >> 8, double & 0xff);
        else bytes.push(0x3f);
    }
    return bytes;
}

/** Columns a character takes in the printer's font A: CJK and full-width forms take two. */
const columnsOf = (char: string) => (char.codePointAt(0)! < 0x80 ? 1 : 2);

/** Characters per line at each size: 48 / 32 columns of font A on 80 / 58 mm paper. */
const scaleOf: Record<ReceiptLine['size'], number> = { s: 1, m: 1, l: 2, xl: 3 };

export function wrapColumns(text: string, columns: number) {
    const lines: string[] = [];
    let current = '';
    let used = 0;
    for (const char of text) {
        const width = columnsOf(char);
        if (used + width > columns && current) {
            lines.push(current);
            current = '';
            used = 0;
        }
        current += char;
        used += width;
    }
    lines.push(current);
    return lines;
}

const ESC = 0x1b;
const GS = 0x1d;
const FS = 0x1c;

/** ESC/POS for a ticket: initialise, Chinese mode, the lines (sized, bold, centred, inverted), feed and cut. */
export function escposTicket(lines: ReceiptLine[], config: Pick<ReceiptConfig, 'width' | 'cut'>) {
    const columns = config.width === 58 ? 32 : 48;
    const out: number[] = [ESC, 0x40, FS, 0x26];
    for (const line of lines) {
        const scale = scaleOf[line.size];
        out.push(ESC, 0x61, line.align === 'center' ? 1 : 0);
        out.push(GS, 0x21, ((scale - 1) << 4) | (scale - 1));
        out.push(ESC, 0x45, line.bold ? 1 : 0);
        out.push(GS, 0x42, line.invert ? 1 : 0);
        const text = line.rule ? '-'.repeat(columns) : line.text;
        for (const part of wrapColumns(text, Math.max(1, Math.floor(columns / scale)))) {
            out.push(...encodeGbk(part), 0x0a);
        }
    }
    // Back to normal, feed past the cutter, cut (partial cut, which every cutter supports).
    out.push(GS, 0x42, 0, ESC, 0x45, 0, GS, 0x21, 0, ESC, 0x61, 0, ESC, 0x64, 4);
    if (config.cut) out.push(GS, 0x56, 66, 0);
    return Buffer.from(out);
}

export interface ReceiptJob {
    id: string;
    kind: 'receipt';
    /** Name in the printer queue. */
    title: string;
    printer: string;
    receipt: ReceiptConfig & {
        lines: ReceiptLine[];
        /** ESC/POS bytes (base64) when the printer takes them. */
        raw?: string;
    };
}

export function receiptJob(id: string, title: string, printer: string, lines: ReceiptLine[], config: ReceiptConfig): ReceiptJob {
    return {
        id, kind: 'receipt', title: title.slice(0, 120), printer,
        receipt: { ...config, lines, ...config.mode === 'escpos' ? { raw: escposTicket(lines, config).toString('base64') } : {} },
    };
}
