import type { CertificateTemplate } from '../../../lib/certificates/model';
import type { FramePath } from './certificate-frame.js';
export type CertificateDesign = 'engraved' | 'icpc' | 'ccpc' | 'gplt' | 'lanqiao';
export const designLabels: Record<CertificateDesign, string>;
export function styledTemplate(base: CertificateTemplate, design: CertificateDesign, kind: 'award' | 'participation'): CertificateTemplate;
export function presetFrame(width: number, height: number, design: CertificateDesign): FramePath[];
