import type { CertificateKind, CertificateTemplate, Placeholder, TemplateField } from '../../../lib/certificates/model';
export interface EventBox { x: number; y: number; width: number; height: number }
export type EventDesign = 'event' | 'event-zh';
export function isEventDesign(design: unknown): design is EventDesign;
export const eventPaper: { width: number; height: number };
export const eventSourceImage: EventBox;
export const eventLetterhead: EventBox & { file: string };
export const eventTrophy: EventBox & { file: string };
export const eventEmblem: EventBox & { file: string };
export const eventSignatures: (EventBox & { label: string; name: string; role: string })[];
export function signatureSlots(design: EventDesign): typeof eventSignatures;
export function signatureFile(design: EventDesign, slot: number): string;
export function eventTemplate(kind: 'award' | 'participation', design?: EventDesign): CertificateTemplate;
export function eventBold(id: string, design?: EventDesign): boolean;
export function eventText(template: string, values: Partial<Record<Placeholder, string>>, kind: CertificateKind, englishAward: string, design?: EventDesign): string;
export function eventLines(field: TemplateField, content: string, design?: EventDesign): { text: string; size: number; y: number; bold: boolean }[];
