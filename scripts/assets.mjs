import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPackage } from './manage-addon.mjs';
import { patchBoardFilter, patchBoardEngine, patchBoardInk, patchBoardLayouts, patchBoardSharing } from '../lib/patch-engine.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error('无效的插件版本号');
// Published archives carry the built assets, while their large build inputs only live in the checkout.
if (!existsSync(path.join(root, 'resolver/public/assets')) && !existsSync(path.join(root, 'live/dist'))) {
    checkPackage(root);
    console.log(`Using packaged XCPCIO, Resolver and Live assets for ${version}`);
    process.exit(0);
}
const { scopeBoardCss } = await import('../lib/style-scope.mjs');
const dist = path.join(path.dirname(require.resolve('@xcpcio/board-app/package.json')), 'dist');
const publicRoot = path.join(root, 'public/hydro-xcpcio');
const target = path.join(publicRoot, version);
const html = await readFile(path.join(dist, 'index.html'), 'utf8');
const js = html.match(/assets\/(index-[\w-]+\.js)/)?.[1];
const css = html.match(/assets\/(index-[\w-]+\.css)/)?.[1];
if (!js || !css) throw new Error('无法识别 XCPCIO 入口文件');
await rm(publicRoot, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(dist, target, { recursive: true });
let extendedEngines = 0;
let layoutSwitches = 0;
let patchedShareMenus = 0;
let inkRules = 0;
for (const file of await readdir(path.join(target, 'assets'))) {
    if (file.endsWith('.js')) {
        const scriptPath = path.join(target, 'assets', file);
        let source = await readFile(scriptPath, 'utf8');
        if (/^rank-.*\.js$/.test(file)) {
            source = patchBoardEngine(source);
            extendedEngines++;
        }
        if (/^Board-.*\.js$/.test(file)) {
            source = patchBoardFilter(patchBoardSharing(source));
            patchedShareMenus++;
        }
        const layouts = patchBoardLayouts(source);
        layoutSwitches += layouts.count;
        const ink = patchBoardInk(layouts.source);
        inkRules += ink.count;
        await writeFile(scriptPath, ink.source);
    }
    if (!file.endsWith('.css')) continue;
    const cssPath = path.join(target, 'assets', file);
    await writeFile(cssPath, scopeBoardCss(await readFile(cssPath, 'utf8'), cssPath));
}
if (extendedEngines !== 1) throw new Error('无法定位唯一的 XCPCIO 榜单引擎');
if (patchedShareMenus !== 1) throw new Error('无法定位唯一的 XCPCIO 榜单页面');
if (inkRules !== 1) throw new Error(`XCPCIO 气球文字颜色规则有 ${inkRules} 处，预期 1 处，请检查上游构建产物`);
// The pinned XCPCIO build has 14 layout switches across the board and its components.
if (layoutSwitches !== 14) throw new Error(`XCPCIO 布局切换数量为 ${layoutSwitches}，预期 14 处，请检查上游构建产物`);
await cp(path.join(root, 'client'), target, { recursive: true });
const awardPolicy = await readFile(path.join(root, 'lib/award-policy.mjs'), 'utf8');
const policyImports = { '../resolver/public/js/standings.js': './standings.js', '../resolver/public/js/trophies.js': './trophies.js' };
let policyBundle = awardPolicy;
for (const [from, to] of Object.entries(policyImports)) {
    if (!policyBundle.includes(`'${from}'`)) throw new Error(`award-policy.mjs 缺少 ${from} 的引用`);
    policyBundle = policyBundle.replace(`'${from}'`, `'${to}'`);
}
await writeFile(path.join(target, 'award-policy.mjs'), policyBundle);
await cp(path.join(root, 'resolver/public/js/standings.js'), path.join(target, 'standings.js'));
await cp(path.join(root, 'resolver/public/js/trophies.js'), path.join(target, 'trophies.js'));
await cp(path.join(root, 'licenses/XCPCIO-MIT.txt'), path.join(target, 'XCPCIO-LICENSE.txt'));
// School logos are fetched ahead of time by scripts/fetch-logos.mjs; the board works without them.
// The board shows them at icon size, so it gets the thumbnails and a name index without the
// per-image provenance records; the originals are only published for the resolver below.
const logoSource = path.join(root, 'logos');
const logoIndex = await readFile(path.join(logoSource, 'index.json'), 'utf8').then(JSON.parse).catch((error) => { if (error.code !== 'ENOENT') throw error; return null; });
if (logoIndex) {
    const thumbs = await readdir(path.join(logoSource, 'thumb')).catch(() => null);
    if (thumbs) await cp(path.join(logoSource, 'thumb'), path.join(target, 'logos'), { recursive: true });
    else await cp(logoSource, path.join(target, 'logos'), { recursive: true });
    await writeFile(path.join(target, 'logos', 'index.json'), JSON.stringify({ source: logoIndex.source, names: logoIndex.names }));
}
await writeFile(path.join(publicRoot, 'manifest.json'), JSON.stringify({ base: version, js: `assets/${js}`, css: `assets/${css}` }));
console.log(`XCPCIO assets ready: ${js} (${layoutSwitches} layout switches kept on the desktop table)`);
const resolverTarget = path.join(root, 'public/hydro-resolver');
await rm(resolverTarget, { recursive: true, force: true });
// Scripts and styles live under the plugin version so an upgrade is never served from Hydro's
// one-day static cache. Images, fonts and logos keep stable paths: saved sessions refer to them.
const resolverCode = path.join(resolverTarget, version);
await mkdir(resolverCode, { recursive: true });
await cp(path.join(root, 'resolver/public'), resolverTarget, { recursive: true, filter: (source) => !/\.css$/.test(source) && path.relative(path.join(root, 'resolver/public'), source).split(path.sep)[0] !== 'js' });
await cp(path.join(root, 'resolver/public/js'), path.join(resolverCode, 'js'), { recursive: true });
for (const file of await readdir(path.join(root, 'resolver/public'))) {
    if (file.endsWith('.css')) await cp(path.join(root, 'resolver/public', file), path.join(resolverCode, file));
}
await cp(logoSource, path.join(resolverTarget, 'logos'), { recursive: true, filter: (source) => path.basename(source) !== 'thumb' });
await cp(path.join(root, 'licenses'), path.join(resolverTarget, 'licenses'), { recursive: true });
console.log('Resolver assets ready: v1.4.0 with Hydro adapters');
// ICPC Live overlay and director console, built by scripts/build-live.mjs (hashed file names).
const liveTarget = path.join(root, 'public/hydro-live');
await rm(liveTarget, { recursive: true, force: true });
await cp(path.join(root, 'live/dist'), liveTarget, { recursive: true });
await cp(path.join(root, 'live/LICENSE.txt'), path.join(liveTarget, 'LICENSE.txt'));
console.log('ICPC Live assets ready: v3.5.1 with Hydro adapters');
// Print client binaries (scripts/build-print-client.mjs), offered for download on 打印服务器管理.
const clientSource = path.join(root, 'print-client/dist');
const clientTarget = path.join(root, 'public/hydro-print-client');
const clients = await readdir(clientSource).catch(() => []);
// The installed package ships only public/hydro-print-client; keep it when there is no fresh build.
if (clients.length) {
    await rm(clientTarget, { recursive: true, force: true });
    await cp(clientSource, clientTarget, { recursive: true });
    console.log(`Print client ready: ${clients.length} platforms`);
}

// Release archives keep these binaries; a source build supplies all six together.
const submitSource = path.join(root, 'submit-client/dist');
const submitTarget = path.join(root, 'public/hydro-submit-client');
const submitBinaries = (await readdir(submitSource).catch(() => [])).filter(file => /^hydro-submit-(?:windows-(?:amd64|arm64)\.exe|(?:darwin|linux)-(?:amd64|arm64))$/.test(file));
if (submitBinaries.length) {
    if (submitBinaries.length !== 6) throw new Error('请先运行 pnpm build:submit-client 以生成六个平台');
    await mkdir(submitTarget, { recursive: true });
    await Promise.all(submitBinaries.map(async file => {
        const target = path.join(submitTarget, file);
        const temp = target + '.' + randomUUID();
        try {
            await cp(path.join(submitSource, file), temp);
            await rename(temp, target);
        } finally { await rm(temp, { force: true }); }
    }));
}
