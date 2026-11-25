export interface FramePath {
    stroke: string | null;
    weight: number;
    fill?: string;
    commands: (['M' | 'L', number, number] | ['C', number, number, number, number, number, number] | ['Z'])[];
}
export function certificateFrame(width: number, height: number): FramePath[];
export function logoBox(width: number, slot: number): { x: number; y: number; width: number; height: number };
export function awardEnglish(value: string): string;
export function fieldInk(field: { color: string; medalColor?: boolean }, award?: string): string;
