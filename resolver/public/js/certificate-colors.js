export const BLACK = '#000000';
export const WHITE = '#ffffff';
export const isInkColor = (value) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
