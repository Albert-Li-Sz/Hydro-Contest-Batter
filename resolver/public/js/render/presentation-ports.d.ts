export class PortHost {
    constructor(image: (url: string) => unknown);
    render(ctx: CanvasRenderingContext2D, data: unknown, item: Record<string, unknown>, variant: string,
        options: { width: number; height: number; now: number; elapsed: number; words: Record<string, string>; scale?: number }): boolean;
}
