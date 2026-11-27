export function cropBox(width: number, height: number, aspect: number, focus?: { x: number; y: number }): { x: number; y: number; width: number; height: number };
export function photoFocus(bitmap: ImageBitmap): Promise<{ x: number; y: number } | undefined>;
export function printableImage(blob: Blob, longest: number, type?: string, byteLimit?: number, crop?: { aspect: number; focus?: { x: number; y: number } | 'auto' } | null): Promise<Blob>;
export function imageData(blob: Blob): Promise<string>;
