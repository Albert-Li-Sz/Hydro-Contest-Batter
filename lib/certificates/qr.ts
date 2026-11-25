/**
 * QR Code (ISO/IEC 18004) for certificate verification links: byte mode, error correction level M, versions 1
 * to 10 (up to 213 bytes), the mask with the lowest penalty. The plugin installs without npm dependencies,
 * so it carries its own encoder; the structure follows Project Nayuki's reference implementation (MIT).
 */

// Error correction level M, versions 1–10 (index 0 unused).
const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const ECC_BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const FORMAT_M = 0;
const MAX_VERSION = 10;

function rawModules(version: number) {
    let result = (16 * version + 128) * version + 64;
    if (version >= 2) {
        const align = Math.floor(version / 7) + 2;
        result -= (25 * align - 10) * align - 55;
        if (version >= 7) result -= 36;
    }
    return result;
}
const dataCodewords = (version: number) => Math.floor(rawModules(version) / 8) - ECC_PER_BLOCK[version] * ECC_BLOCKS[version];

function multiply(x: number, y: number) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
        z = (z << 1) ^ ((z >>> 7) * 0x11d);
        z ^= ((y >>> i) & 1) * x;
    }
    return z;
}

function divisor(degree: number) {
    const result = new Array<number>(degree).fill(0);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
        for (let j = 0; j < degree; j++) {
            result[j] = multiply(result[j], root);
            if (j + 1 < degree) result[j] ^= result[j + 1];
        }
        root = multiply(root, 0x02);
    }
    return result;
}

function remainder(data: number[], div: number[]) {
    const result = div.map(() => 0);
    for (const byte of data) {
        const factor = byte ^ result.shift()!;
        result.push(0);
        div.forEach((coefficient, index) => { result[index] ^= multiply(coefficient, factor); });
    }
    return result;
}

function interleave(data: number[], version: number) {
    const blocks = ECC_BLOCKS[version];
    const eccLength = ECC_PER_BLOCK[version];
    const raw = Math.floor(rawModules(version) / 8);
    const shortBlocks = blocks - (raw % blocks);
    const shortLength = Math.floor(raw / blocks);
    const div = divisor(eccLength);
    const parts: number[][] = [];
    for (let i = 0, k = 0; i < blocks; i++) {
        const part = data.slice(k, k + shortLength - eccLength + (i < shortBlocks ? 0 : 1));
        k += part.length;
        const ecc = remainder(part, div);
        if (i < shortBlocks) part.push(0);
        parts.push(part.concat(ecc));
    }
    const result: number[] = [];
    for (let i = 0; i < parts[0].length; i++) {
        parts.forEach((part, j) => { if (i !== shortLength - eccLength || j >= shortBlocks) result.push(part[i]); });
    }
    return result;
}

function encodeData(bytes: Uint8Array, version: number) {
    const bits: number[] = [];
    const push = (value: number, length: number) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
    push(0b0100, 4);
    push(bytes.length, version <= 9 ? 8 : 16);
    for (const byte of bytes) push(byte, 8);
    const capacity = dataCodewords(version) * 8;
    push(0, Math.min(4, capacity - bits.length));
    push(0, (8 - (bits.length % 8)) % 8);
    for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
    const codewords: number[] = [];
    for (let i = 0; i < bits.length; i += 8) codewords.push(bits.slice(i, i + 8).reduce((value, bit) => (value << 1) | bit, 0));
    return codewords;
}

function alignmentPositions(version: number, size: number) {
    if (version === 1) return [];
    const count = Math.floor(version / 7) + 2;
    const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
    const result = [6];
    for (let position = size - 7; result.length < count; position -= step) result.splice(1, 0, position);
    return result;
}

const masks: ((x: number, y: number) => boolean)[] = [
    (x, y) => (x + y) % 2 === 0,
    (_x, y) => y % 2 === 0,
    (x) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** Penalty rules 1 (runs), 2 (2×2 blocks), 3 (finder-like patterns) and 4 (balance). */
function penalty(modules: boolean[][]) {
    const size = modules.length;
    let result = 0;
    const line = (get: (i: number) => boolean) => {
        let score = 0;
        let run = 1;
        for (let i = 1; i <= size; i++) {
            if (i < size && get(i) === get(i - 1)) { run++; continue; }
            if (run >= 5) score += run - 2;
            run = 1;
        }
        const pattern = [true, false, true, true, true, false, true];
        for (let i = 0; i + 7 <= size; i++) {
            if (!pattern.every((dark, k) => get(i + k) === dark)) continue;
            const before = i - 4 >= 0 && [0, 1, 2, 3].every((k) => !get(i - 4 + k));
            const after = i + 11 <= size && [0, 1, 2, 3].every((k) => !get(i + 7 + k));
            if (before || after) score += 40;
        }
        return score;
    };
    for (let y = 0; y < size; y++) result += line((x) => modules[y][x]);
    for (let x = 0; x < size; x++) result += line((y) => modules[y][x]);
    for (let y = 0; y < size - 1; y++) {
        for (let x = 0; x < size - 1; x++) {
            const color = modules[y][x];
            if (color === modules[y][x + 1] && color === modules[y + 1][x] && color === modules[y + 1][x + 1]) result += 3;
        }
    }
    const dark = modules.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
    const total = size * size;
    result += Math.max(0, Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return result;
}

/** The modules of the symbol, `true` for dark, without the quiet zone. */
export function qrMatrix(text: string): boolean[][] {
    const bytes = new TextEncoder().encode(text);
    let version = 1;
    while (version <= MAX_VERSION && bytes.length * 8 + 4 + (version <= 9 ? 8 : 16) > dataCodewords(version) * 8) version++;
    if (version > MAX_VERSION) throw new Error('二维码内容过长');
    const size = version * 4 + 17;
    const modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    const reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    const set = (x: number, y: number, dark: boolean) => { modules[y][x] = dark; reserved[y][x] = true; };

    for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
        for (let dy = -4; dy <= 4; dy++) {
            for (let dx = -4; dx <= 4; dx++) {
                const x = cx + dx; const y = cy + dy;
                if (x < 0 || y < 0 || x >= size || y >= size) continue;
                const distance = Math.max(Math.abs(dx), Math.abs(dy));
                set(x, y, distance !== 2 && distance !== 4);
            }
        }
    }
    const positions = alignmentPositions(version, size);
    const last = positions.length - 1;
    positions.forEach((ax, i) => positions.forEach((ay, j) => {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }));
    const drawFormat = (mask: number) => {
        const data = (FORMAT_M << 3) | mask;
        let rem = data;
        for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
        const bits = ((data << 10) | rem) ^ 0x5412;
        const bit = (i: number) => ((bits >>> i) & 1) === 1;
        for (let i = 0; i <= 5; i++) set(8, i, bit(i));
        set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
        for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
        for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
        for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
        set(8, size - 8, true);
    };
    drawFormat(0);
    if (version >= 7) {
        let rem = version;
        for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
        const bits = (version << 12) | rem;
        for (let i = 0; i < 18; i++) {
            const dark = ((bits >>> i) & 1) === 1;
            const a = size - 11 + (i % 3); const b = Math.floor(i / 3);
            set(a, b, dark); set(b, a, dark);
        }
    }

    const codewords = interleave(encodeData(bytes, version), version);
    let index = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        for (let vertical = 0; vertical < size; vertical++) {
            for (let j = 0; j < 2; j++) {
                const x = right - j;
                const upward = ((right + 1) & 2) === 0;
                const y = upward ? size - 1 - vertical : vertical;
                if (reserved[y][x] || index >= codewords.length * 8) continue;
                modules[y][x] = ((codewords[index >>> 3] >>> (7 - (index & 7))) & 1) === 1;
                index++;
            }
        }
    }

    const apply = (mask: number) => {
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!reserved[y][x] && masks[mask](x, y)) modules[y][x] = !modules[y][x];
    };
    let best = 0;
    let lowest = Infinity;
    for (let mask = 0; mask < 8; mask++) {
        apply(mask); drawFormat(mask);
        const score = penalty(modules);
        if (score < lowest) { lowest = score; best = mask; }
        apply(mask);
    }
    apply(best); drawFormat(best);
    return modules;
}
