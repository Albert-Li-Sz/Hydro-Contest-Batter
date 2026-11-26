export interface FramePath {
    stroke: string | null;
    weight: number;
    fill?: string;
    commands: (['M' | 'L', number, number] | ['C', number, number, number, number, number, number] | ['Z'])[];
}
import type { CertificateDesign } from './certificate-designs.js';
export function certificateFrame(width: number, height: number, design?: CertificateDesign): FramePath[];
export interface DecorationPlacement { x: number; y: number; width: number; aspect: number }
export function decorationBox(page: { width: number; height: number }, placement: DecorationPlacement): { x: number; y: number; width: number; height: number };
export function logoBox(width: number, slot: number): { x: number; y: number; width: number; height: number };
export function medalTier(award?: string, awardId?: string): 'gold' | 'silver' | 'bronze' | null;
export function awardEnglish(value?: string, awardId?: string): string;
export function fieldInk(field: { color: string; medalColor?: boolean }, award?: string, awardId?: string): string;
