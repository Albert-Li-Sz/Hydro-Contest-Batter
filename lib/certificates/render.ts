/** A certificate's page from its template and issued values (lib/certificates/pdf.ts). */
import { fillText, pageSize, type CertificateKind, type CertificateTemplate, type Placeholder } from './model';
import type { PdfImage, PdfPage } from './pdf';
import { decorationBox, fieldInk, logoBox, type DecorationPlacement } from '../../resolver/public/js/certificate-frame.js';
import { qrMatrix } from './qr';

const rgb = (hex: string): [number, number, number] => [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16)) as [number, number, number];

export function certificatePage(template: CertificateTemplate, kind: CertificateKind, values: Partial<Record<Placeholder, string>>,
    verifyUrl: string, background: PdfImage | null, logos: readonly { slot: number; image: PdfImage }[] = [],
    decorations: readonly (DecorationPlacement & { image: PdfImage })[] = []): PdfPage {
    const fields = template.fields.filter((field) => !field.kinds.length || field.kinds.includes(kind));
    const qr = fields.find((field) => field.type === 'qr');
    const dimensions = pageSize(template);
    const design = template.frame === 'classic' ? undefined : template.frame;
    return {
        ...dimensions, background, border: !background && !design, engraved: !background && !!design, design,
        decorations: decorations.map((item) => ({ image: item.image, ...decorationBox(dimensions, item) })),
        logos: logos.map(({ slot, image }) => {
            const box = logoBox(dimensions.width, slot);
            const scale = Math.min(box.width / image.width, box.height / image.height);
            const width = image.width * scale; const height = image.height * scale;
            return { image, width, height, x: box.x + (box.width - width) / 2, y: box.y + (box.height - height) / 2 };
        }),
        texts: fields.filter((field) => field.type === 'text').map((field) => ({
            text: fillText(field.text, values), x: field.x, y: field.y, size: field.size, align: field.align, font: template.font,
            width: field.width, color: rgb(fieldInk(field, values.award)),
        })),
        qr: qr && verifyUrl ? { matrix: qrMatrix(verifyUrl), x: qr.x, y: qr.y, size: qr.size } : null,
    };
}
