import { readFileSync } from 'node:fs';
import path from 'node:path';
import metrics from './event-fonts/metrics.json';
import advances from './event-fonts/advances.json';

/** Only the two subsets embedded in the reference certificate are used. Characters outside them use the PDF writer's fallback fonts. */
export type EventWeight = keyof typeof metrics;
export const eventGlyphs = (weight: EventWeight): Record<string, number[]> => metrics[weight].glyphs;
const hex = (value: number) => value.toString(16).padStart(4, '0');
export const eventString = (text: string, weight: EventWeight) => '<' + [...text].map((c) => hex(eventGlyphs(weight)[c][0])).join('') + '>';

// The reference typesetter placed letters individually on its print grid. Retain its advances
// at the original sizes, including the wider space between the institution and the date.
export function eventAdvances(weight: EventWeight, size: number): { width: Record<string, number>; kern: Record<string, number> } | undefined {
    const key = weight + '-' + (Number.isInteger(size) ? size.toFixed(1) : String(size));
    return advances[key as keyof typeof advances];
}

const embedded = new Map<EventWeight, Buffer>();
export function addEventFont(weight: EventWeight, add: (body: string | Buffer) => number, stream: (attrs: string, data: Buffer) => Buffer) {
    const font = metrics[weight];
    if (!embedded.has(weight)) embedded.set(weight, readFileSync(path.join(__dirname, 'event-fonts', weight + '.ttf.z')));
    const file = add(stream(`/Filter /FlateDecode /Length1 ${font.length}`, embedded.get(weight)!));
    const descriptor = add(`<< /Type /FontDescriptor /FontName /${font.name} /Flags 32 /FontBBox [${font.bounds.join(' ')}] /Ascent ${font.ascent} /Descent ${font.descent} /CapHeight ${font.cap} /ItalicAngle 0 /StemV ${font.stem} /FontFile2 ${file} 0 R >>`);
    const entries = Object.entries(eventGlyphs(weight)).sort((a, b) => a[1][0] - b[1][0]);
    const widths = entries.map(([, [id, width]]) => `${id} [${width}]`).join(' ');
    const descendant = add(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${font.name} /CIDToGIDMap /Identity /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descriptor} 0 R /DW 750 /W [${widths}] >>`);
    const map = entries.map(([char, [id]]) => `<${hex(id)}> <${hex(char.charCodeAt(0))}>`).join('\n');
    const unicode = add(stream('', Buffer.from(`/CIDInit /ProcSet findresource begin 12 dict begin begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /EventUnicode def /CMapType 2 def
1 begincodespacerange <0000> <FFFF> endcodespacerange
${entries.length} beginbfchar
${map}
endbfchar endcmap CMapName currentdict /CMap defineresource pop end end`)));
    return add(`<< /Type /Font /Subtype /Type0 /BaseFont /${font.name} /Encoding /Identity-H /DescendantFonts [${descendant} 0 R] /ToUnicode ${unicode} 0 R >>`);
}
