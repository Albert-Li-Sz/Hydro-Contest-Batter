/** A certificate's page from its template and issued values (lib/certificates/pdf.ts). */
import { fillText, pageSize, type CertificateKind, type CertificateTemplate, type Placeholder } from './model';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { parseImage, type NativeSignature, type PdfImage, type PdfPage, type PdfText, type PlacedImage } from './pdf';
import { awardEnglish, decorationBox, fieldInk, logoBox, type DecorationPlacement } from '../../resolver/public/js/certificate-frame.js';
import { eventEmblem, eventLines, eventSignatures, eventSourceImage, eventText, eventTrophy, isEventDesign, signatureFile, type EventBox } from '../../resolver/public/js/certificate-event.js';
import { qrMatrix } from './qr';

const rgb = (hex: string): [number, number, number] => [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16)) as [number, number, number];
const masterImages = new Map<string, PdfImage>();
const art = (file: string) => readFileSync(path.join(__dirname, 'event-art', file));
function masterImage(file: string) {
    if (!masterImages.has(file)) {
        const data = file.endsWith('.png') ? readFileSync(path.join(__dirname, '../../resolver/public/js/certificate-event', file)) : art(file);
        masterImages.set(file, parseImage(data, true));
    }
    return masterImages.get(file)!;
}
function contain(box: EventBox, image: PdfImage): PlacedImage {
    const scale = Math.min(box.width / image.width, box.height / image.height);
    const width = image.width * scale, height = image.height * scale;
    return { image, width, height, x: box.x + (box.width - width) / 2, y: box.y + (box.height - height) / 2 };
}
let nativeSignature: NativeSignature | undefined;
function originalRightSignature() {
    return nativeSignature ??= { image: { ...masterImage('right.jpg'), alpha: art('right-alpha.z') }, drawing: deflateSync(art('right.pdfops')) };
}

export function certificatePage(template: CertificateTemplate, kind: CertificateKind, values: Partial<Record<Placeholder, string>>,
    verifyUrl: string, background: PdfImage | null, logos: readonly { slot: number; image: PdfImage }[] = [],
    decorations: readonly (DecorationPlacement & { image: PdfImage })[] = [],
    signatures: ReadonlyMap<number, PdfImage | null> = new Map(), emblem: 'icpc' | 'none' | PdfImage = 'icpc'): PdfPage {
    const fields = template.fields.filter((field) => !field.kinds.length || field.kinds.includes(kind));
    const qr = fields.find((field) => field.type === 'qr');
    const dimensions = pageSize(template);
    const design = template.frame === 'classic' ? undefined : template.frame;
    const master: PlacedImage[] = [];
    let originalSignature: NativeSignature | undefined;
    if (isEventDesign(design)) {
        if (design === 'event-zh') {
            if (!background) master.push({ ...eventTrophy, image: masterImage(eventTrophy.file) });
            if (emblem !== 'none') master.push(contain(eventEmblem, emblem === 'icpc' ? masterImage(eventEmblem.file) : emblem));
        } else if (!background) master.push({ ...eventSourceImage, image: masterImage('letterhead.jpg') });
        eventSignatures.forEach((box, slot) => {
            if (signatures.has(slot)) {
                const image = signatures.get(slot);
                if (image) master.push({ ...box, image });
            } else if (design === 'event-zh') master.push({ ...box, image: masterImage(signatureFile(design, slot)) });
            else if (slot === 2) originalSignature = originalRightSignature();
            // Each master contains only its own artwork, on the original JPEG sampling grid.
            else master.push({ ...eventSourceImage, clip: box, image: masterImage(slot === 0 ? 'left.jpg' : 'middle.jpg') });
        });
    }
    return {
        ...dimensions, background, border: !background && !design, engraved: !background && !!design && !isEventDesign(design), design,
        ...(isEventDesign(design) ? { master, originalSignature } : {}),
        decorations: decorations.map((item) => ({ image: item.image, ...decorationBox(dimensions, item) })),
        logos: logos.map(({ slot, image }) => contain(logoBox(dimensions.width, slot), image)),
        texts: fields.filter((field) => field.type === 'text').flatMap((field): PdfText[] => {
            const style = { x: field.x, align: field.align, font: template.font, width: field.width, color: rgb(fieldInk(field, values.award)) };
            if (isEventDesign(design)) {
                const content = eventText(field.text, values, kind, awardEnglish(values.award || ''), design);
                return eventLines(field, content, design).map(({ y, size, text, bold }): PdfText => ({ ...style, y, size, text,
                    ...(design === 'event' ? { eventWeight: bold ? 'bold' : 'regular' } : { bold }) }));
            }
            return [{ ...style, y: field.y, size: field.size, text: fillText(field.text, values) }];
        }),
        qr: qr && verifyUrl ? { matrix: qrMatrix(verifyUrl), x: qr.x, y: qr.y, size: qr.size } : null,
    };
}
