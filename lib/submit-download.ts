import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { writeZip } from './ccs/zip';
import { SUBMIT_CLIENT_PREFIX, SubmitError, submitPlatforms } from './submit';

export function submitDownloads(base: string) {
    return Object.entries(submitPlatforms).map(([platform, title]) => ({ title, url: `${base}/${platform}` }));
}

// Reuse the current site package per platform, including concurrent downloads from a room of teams.
const cached = new Map<string, { key: string; result: Promise<Buffer> }>();

export async function submitDownload(platform: string, baseURL: string, publicRoot = path.resolve(__dirname, '../public')) {
    if (!Object.hasOwn(submitPlatforms, platform)) throw new SubmitError('没有这个平台的安装包', 404);
    const url = new URL(baseURL);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new SubmitError('比赛服务器地址无效');
    const file = path.join(publicRoot, 'hydro-submit-client', SUBMIT_CLIENT_PREFIX + platform);
    const attributes = await stat(file).catch((error) => {
        if (error.code === 'ENOENT') throw new SubmitError('此平台的命令行程序尚未构建', 503);
        throw error;
    });
    const key = JSON.stringify([url.href, file, attributes.size, attributes.mtimeMs]);
    const previous = cached.get(platform);
    if (previous?.key === key) return previous.result;
    const result = readFile(file).then(binary => writeZip([
        { name: platform.endsWith('.exe') ? 'submit.exe' : 'submit', data: binary, mode: 0o755 },
        { name: 'submit-server.json', data: Buffer.from(JSON.stringify({ server: url.href.replace(/\/$/, '') }) + '\n') },
    ]));
    cached.set(platform, { key, result });
    try { return await result; } catch (error) {
        if (cached.get(platform)?.result === result) cached.delete(platform);
        throw error;
    }
}
