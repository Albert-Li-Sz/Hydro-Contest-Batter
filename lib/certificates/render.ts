/** A certificate's page from its template and issued values (lib/certificates/pdf.ts). */
import { fillText, pageSize, type CertificateKind, type CertificateTemplate, type Placeholder } from './model';
import type { PdfImage, PdfPage } from './pdf';
import { qrMatrix } from './qr';

const rgb = (hex: string): [number, number, number] => [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16)) as [number, number, number];

export function certificatePage(template: CertificateTemplate, kind: CertificateKind, values: Partial<Record<Placeholder, string>>,
    verifyUrl: string, background: PdfImage | null): PdfPage {
    const fields = template.fields.filter((field) => !field.kinds.length || field.kinds.includes(kind));
    const qr = fields.find((field) => field.type === 'qr');
    return {
        ...pageSize(template), background, border: !background,
        texts: fields.filter((field) => field.type === 'text').map((field) => ({
            text: fillText(field.text, values), x: field.x, y: field.y, size: field.size, align: field.align, font: template.font,
            width: field.width, color: rgb(field.color),
        })),
        qr: qr && verifyUrl ? { matrix: qrMatrix(verifyUrl), x: qr.x, y: qr.y, size: qr.size } : null,
    };
}
