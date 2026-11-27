/**
 * Minimal zip archives for submission files (CCS `files`: one application/zip with the sources
 * at its root). Writes deflated entries and reads stored or deflated ones; Node's zlib only.
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

export function crc32(data: Uint8Array) {
    let crc = 0xffffffff;
    for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

/** DOS date and time for the entry headers. */
function dosTime(date: Date) {
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const day = ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time, day };
}

export interface ZipEntry { name: string; data: Buffer; mode?: number }

export function writeZip(entries: ZipEntry[], modified = new Date()): Buffer {
    const { time, day } = dosTime(modified);
    const local: Buffer[] = [];
    const central: Buffer[] = [];
    let offset = 0;
    for (const entry of entries) {
        const name = Buffer.from(entry.name, 'utf8');
        const compressed = deflateRawSync(entry.data);
        const crc = crc32(entry.data);
        const header = Buffer.alloc(30);
        header.writeUInt32LE(0x04034b50, 0);
        header.writeUInt16LE(20, 4); // version needed
        header.writeUInt16LE(0x0800, 6); // UTF-8 names
        header.writeUInt16LE(8, 8); // deflate
        header.writeUInt16LE(time, 10);
        header.writeUInt16LE(day, 12);
        header.writeUInt32LE(crc, 14);
        header.writeUInt32LE(compressed.length, 18);
        header.writeUInt32LE(entry.data.length, 22);
        header.writeUInt16LE(name.length, 26);
        local.push(header, name, compressed);
        const record = Buffer.alloc(46);
        record.writeUInt32LE(0x02014b50, 0);
        record.writeUInt16LE(entry.mode === undefined ? 20 : 0x0314, 4);
        record.writeUInt16LE(20, 6);
        record.writeUInt16LE(0x0800, 8);
        record.writeUInt16LE(8, 10);
        record.writeUInt16LE(time, 12);
        record.writeUInt16LE(day, 14);
        record.writeUInt32LE(crc, 16);
        record.writeUInt32LE(compressed.length, 20);
        record.writeUInt32LE(entry.data.length, 24);
        record.writeUInt16LE(name.length, 28);
        record.writeUInt32LE(((0o100000 | (entry.mode ?? 0o644)) << 16) >>> 0, 38); // Unix regular-file permissions
        record.writeUInt32LE(offset, 42);
        central.push(record, name);
        offset += header.length + name.length + compressed.length;
    }
    const directory = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...local, directory, end]);
}

export class ZipError extends Error {}

/**
 * Reads the files of an archive (directories skipped). Limits guard against archives that are too
 * large once unpacked.
 */
export function readZip(archive: Buffer, limits: { maxFiles: number; maxBytes: number }): ZipEntry[] {
    let end = -1;
    for (let i = archive.length - 22; i >= Math.max(0, archive.length - 22 - 0xffff); i--) {
        if (archive.readUInt32LE(i) === 0x06054b50) { end = i; break; }
    }
    if (end < 0) throw new ZipError('不是有效的 zip 文件');
    if (end + 22 + archive.readUInt16LE(end + 20) !== archive.length
        || archive.readUInt16LE(end + 4) !== 0 || archive.readUInt16LE(end + 6) !== 0
        || archive.readUInt16LE(end + 8) !== archive.readUInt16LE(end + 10)) throw new ZipError('不支持分卷或损坏的 zip');
    const count = archive.readUInt16LE(end + 10);
    let pointer = archive.readUInt32LE(end + 16);
    const directoryEnd = pointer + archive.readUInt32LE(end + 12);
    if (count === 0xffff || directoryEnd !== end) throw new ZipError('不支持 ZIP64 或损坏的 zip 目录');
    if (count > limits.maxFiles) throw new ZipError(`zip 中文件过多（最多 ${limits.maxFiles} 个）`);
    const entries: ZipEntry[] = [];
    let total = 0;
    for (let i = 0; i < count; i++) {
        if (pointer + 46 > directoryEnd || archive.readUInt32LE(pointer) !== 0x02014b50) throw new ZipError('zip 目录损坏');
        const flags = archive.readUInt16LE(pointer + 8);
        if (flags & 0x41 || archive.readUInt16LE(pointer + 34) !== 0) throw new ZipError('不支持加密或分卷 zip');
        const unixType = archive.readUInt32LE(pointer + 38) >>> 28;
        if (unixType && unixType !== 8 && unixType !== 4) throw new ZipError('zip 只能包含普通文件');
        const method = archive.readUInt16LE(pointer + 10);
        const crc = archive.readUInt32LE(pointer + 16);
        const compressedSize = archive.readUInt32LE(pointer + 20);
        const size = archive.readUInt32LE(pointer + 24);
        const nameLength = archive.readUInt16LE(pointer + 28);
        const extraLength = archive.readUInt16LE(pointer + 30);
        const commentLength = archive.readUInt16LE(pointer + 32);
        const localOffset = archive.readUInt32LE(pointer + 42);
        const name = archive.subarray(pointer + 46, pointer + 46 + nameLength).toString('utf8');
        pointer += 46 + nameLength + extraLength + commentLength;
        if (pointer > directoryEnd) throw new ZipError('zip 目录损坏');
        if (name.endsWith('/')) continue;
        if (!name || name.split('/').some(part => !part || part === '..' || part === '.') || /[\\:\x00-\x1f]/.test(name)
            || entries.some(entry => entry.name === name)) throw new ZipError('zip 中的文件名无效或重复');
        total += size;
        if (total > limits.maxBytes) throw new ZipError(`zip 解压后过大（最多 ${limits.maxBytes} 字节）`);
        if (localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== 0x04034b50) throw new ZipError('zip 文件头损坏');
        const start = localOffset + 30 + archive.readUInt16LE(localOffset + 26) + archive.readUInt16LE(localOffset + 28);
        if (start + compressedSize > archive.readUInt32LE(end + 16)
            || archive.readUInt16LE(localOffset + 8) !== method || archive.readUInt16LE(localOffset + 6) !== flags
            || archive.subarray(localOffset + 30, localOffset + 30 + archive.readUInt16LE(localOffset + 26)).toString('utf8') !== name) throw new ZipError('zip 文件头与目录不一致');
        const raw = archive.subarray(start, start + compressedSize);
        let data: Buffer;
        if (method === 0) data = Buffer.from(raw);
        else if (method === 8) {
            try { data = inflateRawSync(raw, { maxOutputLength: Math.max(1, limits.maxBytes) }); }
            catch { throw new ZipError('zip 压缩数据损坏或解压后过大'); }
        }
        else throw new ZipError('zip 使用了不支持的压缩方式');
        if (data.length !== size || crc32(data) !== crc) throw new ZipError(`zip 中的文件 ${name} 校验失败`);
        entries.push({ name, data });
    }
    if (pointer !== directoryEnd) throw new ZipError('zip 目录长度不一致');
    return entries;
}
