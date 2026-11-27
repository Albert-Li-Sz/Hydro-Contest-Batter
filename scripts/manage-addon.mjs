import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageName = 'hydro-scoreboard-xcpcio-plus';
const sourceDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = process.env.HYDRO_PROFILE;
const hydroDirectory = profile
    ? path.resolve(os.homedir(), '.hydro/profiles', profile)
    : path.join(os.homedir(), '.hydro');
const addonFile = path.join(hydroDirectory, 'addon.json');
const staticNames = ['hydro-xcpcio', 'hydro-resolver', 'hydro-live', 'hydro-print-client', 'hydro-submit-client'];

function help() {
    console.log(`用法
  bash install.sh install [选项]
  bash install.sh upgrade [选项]
  bash install.sh uninstall [选项]

install / upgrade 使用当前解压目录中的安装包，自动注册 addon 并重启 Hydro。
upgrade 请运行新安装包中的 install.sh。
uninstall 解除注册，将插件目录及静态资源移入备份，保留 MongoDB 数据。

选项
  --dir <目录>       安装目录，默认当前 Hydro 配置的 addons/${packageName}
  --service <名称>   PM2 进程名，默认 hydrooj
  --no-restart       由容器或服务管理器另行重启
  --help            显示帮助

请使用运行 Hydro 的系统用户执行。HYDRO_PROFILE 与 Hydro 自身保持一致。`);
}

function options(args) {
    const result = { action: args.shift(), target: path.join(hydroDirectory, 'addons', packageName), service: 'hydrooj', restart: true };
    if (!result.action || ['--help', '-h'].includes(result.action)) return null;
    if (!['install', 'upgrade', 'uninstall'].includes(result.action)) throw new Error('操作必须为 install、upgrade 或 uninstall');
    while (args.length) {
        const option = args.shift();
        if (option === '--help') return null;
        if (option === '--no-restart') result.restart = false;
        else if (option === '--dir' || option === '--service') {
            const value = args.shift();
            if (!value || value.startsWith('--')) throw new Error(`${option} 缺少参数`);
            if (option === '--dir') result.target = path.resolve(value);
            else result.service = value;
        } else throw new Error(`未知选项 ${option}`);
    }
    return result;
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readAddons() {
    const addons = readJson(addonFile);
    if (!Array.isArray(addons) || addons.some((item) => typeof item !== 'string')) throw new Error(`无效的 addon 列表 ${addonFile}`);
    return addons;
}

function isPlugin(entry, target) {
    if (entry === packageName || entry === target) return true;
    if (!path.isAbsolute(entry)) return false;
    try { return readJson(path.join(entry, 'package.json')).name === packageName; } catch { return false; }
}

function run(command, args, quiet = false) {
    const result = spawnSync(command, args, { stdio: quiet ? 'pipe' : 'inherit', encoding: 'utf8' });
    if (result.error) throw new Error(`${command} 执行失败，请检查运行环境`, { cause: result.error });
    if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} 执行失败${quiet ? `\n${result.stderr || result.stdout}` : ''}`);
}

export function checkPackage(directory) {
    const pkg = readJson(path.join(directory, 'package.json'));
    if (pkg.name !== packageName || pkg.main !== 'index.ts' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(pkg.version)) {
        throw new Error(`不是本插件的安装包 ${directory}`);
    }
    const manifest = readJson(path.join(directory, 'public/hydro-xcpcio/manifest.json'));
    if (manifest.base !== pkg.version) throw new Error('安装包版本与静态资源版本不一致，请重新打包');
    const files = [
        'index.ts', 'install.sh', 'scripts/manage-addon.mjs',
        `public/hydro-xcpcio/${pkg.version}/${manifest.js}`,
        `public/hydro-xcpcio/${pkg.version}/${manifest.css}`,
        `public/hydro-xcpcio/${pkg.version}/award-policy.mjs`,
        `public/hydro-xcpcio/${pkg.version}/standings.js`,
        `public/hydro-xcpcio/${pkg.version}/trophies.js`,
        `public/hydro-resolver/${pkg.version}/js/play.js`,
        'public/hydro-resolver/logos/index.json',
        'public/hydro-live/admin/index.html', 'public/hydro-live/overlay/index.html',
    ];
    const [major, minor] = pkg.version.split('.').map(Number);
    if (major > 1 || major === 1 && minor >= 21) {
        const resolver = `public/hydro-resolver/${pkg.version}`;
        files.push(
            'lib/recording-routes.ts', 'lib/reactions-routes.ts',
            `${resolver}/js/hydro-capture-recorder.js`, `${resolver}/js/hydro-recording-buffer.js`, `${resolver}/js/hydro-recording-media.js`,
            `${resolver}/js/vendor/fix-webm-duration.js`, `${resolver}/js/hydro-recordings.js`, `${resolver}/hydro-recordings.css`,
            `${resolver}/js/hydro-reactions.js`, `${resolver}/js/hydro-reaction-layout.js`, `${resolver}/js/hydro-reactions-public.js`, `${resolver}/hydro-reactions.css`,
            'public/hydro-resolver/assets/font/NotoSansSC-VF.ttf', 'public/hydro-resolver/assets/reaction-samples/screen.mp4',
            'public/hydro-resolver/assets/reaction-samples/webcam.mp4', 'licenses/fix-webm-duration-MIT.txt',
        );
    }
    if (pkg.files?.includes('submit-client/go.mod')) {
        for (const platform of ['windows-amd64.exe', 'windows-arm64.exe', 'darwin-amd64', 'darwin-arm64', 'linux-amd64', 'linux-arm64']) {
            files.push(`public/hydro-submit-client/hydro-submit-${platform}`);
        }
    }
    for (const file of files) {
        if (!fs.statSync(path.join(directory, file), { throwIfNoEntry: false })?.isFile()) {
            throw new Error(`安装包缺少 ${file}，请下载 0.8.1 起的完整安装包`);
        }
    }
    return pkg;
}

function stagePackage(target, pkg) {
    const directory = fs.mkdtempSync(path.join(path.dirname(target), '.xcpcio-stage-'));
    try {
        // Copy the published files only, so running from a development checkout does not copy
        // node_modules, Git metadata, local credentials or preview data into the deployment.
        for (const entry of new Set(['package.json', ...pkg.files])) {
            if (path.isAbsolute(entry) || entry.split(/[\\/]/).includes('..') || /[!*?]/.test(entry)) {
                throw new Error(`安装包文件列表包含不支持的路径 ${entry}`);
            }
            fs.cpSync(path.join(sourceDirectory, entry), path.join(directory, entry), { recursive: true });
        }
        checkPackage(directory);
        return directory;
    } catch (error) {
        fs.rmSync(directory, { recursive: true, force: true });
        throw error;
    }
}

function restoreAddons(previous, target) {
    // Keep unrelated addons that may have been added while the installation was running.
    const current = readAddons().filter((entry) => !isPlugin(entry, target));
    const restored = [...new Set([
        ...previous.filter((entry) => isPlugin(entry, target) || current.includes(entry)),
        ...current,
    ])];
    const temporary = `${addonFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(restored, null, 2)}\n`);
    fs.renameSync(temporary, addonFile);
}

function changeRegistration(action, target, previous) {
    if (action !== 'uninstall') {
        run('hydrooj', ['addon', 'add', target]);
        // Hydro 5 can print an add failure and still exit 0. Read back its actual registry.
        if (!readAddons().includes(target)) throw new Error('Hydro 未成功注册插件目录');
    }
    for (const entry of previous.filter((item) => isPlugin(item, target))) {
        if (action === 'uninstall' || entry !== target) run('hydrooj', ['addon', 'remove', entry]);
    }
    const actual = readAddons().filter((entry) => isPlugin(entry, target));
    if (action === 'uninstall' ? actual.length !== 0 : actual.length !== 1 || actual[0] !== target) {
        throw new Error('Hydro addon 注册结果与预期不一致');
    }
}

function verifyPm2Online(service) {
    const result = spawnSync('pm2', ['jlist'], { stdio: 'pipe', encoding: 'utf8' });
    if (result.error || result.status !== 0 || !result.stdout?.trim()) return;
    let processes;
    try { processes = JSON.parse(result.stdout); } catch { return; }
    if (!Array.isArray(processes)) return;
    const matched = processes.filter((item) => item?.name === service);
    if (matched.length && matched.every((item) => ['errored', 'stopped'].includes(item?.pm2_env?.status))) {
        throw new Error(`PM2 进程 ${service} 重启后未能进入在线状态`);
    }
}

function install(config) {
    const { action, target, service, restart } = config;
    if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('需要 Node.js 22 或以上版本');
    if (!fs.existsSync(hydroDirectory)) throw new Error(`请先完成 Hydro 安装并确认运行用户，未找到 ${hydroDirectory}`);
    const lock = path.join(hydroDirectory, '.xcpcio-install.lock');
    try { fs.mkdirSync(lock, { mode: 0o700 }); } catch (error) {
        if (error.code === 'EEXIST') throw new Error(`另一个安装操作持有锁 ${lock}，请等它结束。若进程已异常退出，请核对备份后移除此锁目录。`);
        throw error;
    }
    fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
    let staged;
    const cleanupLock = () => {
        if (staged) try { fs.rmSync(staged, { recursive: true, force: true }); } catch { /* ignore */ }
        try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* ignore */ }
    };
    const onSignal = (signal) => {
        cleanupLock();
        process.exit(signal === 'SIGINT' ? 130 : 143);
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    try {
        run('hydrooj', ['addon', 'list'], true);
        const previous = readAddons();
        if (restart) run('pm2', ['describe', service], true);

        let targetInfo = fs.lstatSync(target, { throwIfNoEntry: false });
        // An empty directory (for example made by the manual steps' mkdir) is free to use.
        if (targetInfo?.isDirectory() && !targetInfo.isSymbolicLink() && fs.readdirSync(target).length === 0) {
            fs.rmdirSync(target);
            targetInfo = undefined;
        }
        const ownPackage = () => {
            try { return readJson(path.join(target, 'package.json')).name === packageName; } catch { return false; }
        };
        if (targetInfo && (targetInfo.isSymbolicLink() || !targetInfo.isDirectory() || !ownPackage())) {
            throw new Error(`安装目录已被其他文件占用 ${target}`);
        }
        const cached = staticNames.map((name) => path.join(hydroDirectory, 'static', name)).filter((file) => fs.existsSync(file));
        if (action === 'uninstall' && !targetInfo && !previous.some((entry) => isPlugin(entry, target)) && !cached.length) {
            console.log('插件已经卸载。');
            return;
        }
        let pkg;
        if (action !== 'uninstall') {
            pkg = checkPackage(sourceDirectory);
            const relative = path.relative(sourceDirectory, target);
            if (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
                throw new Error('安装目录应位于当前解压目录之外');
            }
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        if (pkg && sourceDirectory !== target) staged = stagePackage(target, pkg);
        const backupRoot = path.join(path.dirname(target), '.hydro-addon-backups', packageName);
        fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
        const backup = fs.mkdtempSync(path.join(backupRoot, `${new Date().toISOString().replace(/[:.]/g, '-')}-`));
        fs.copyFileSync(addonFile, path.join(backup, 'addon.json'));
        fs.writeFileSync(path.join(backup, 'operation.json'), JSON.stringify({ action, target, service, previous, version: pkg?.version }, null, 2));
        console.log(`备份目录 ${backup}`);
        let oldDirectoryMoved = false;
        let newDirectoryPlaced = false;
        let restartAttempted = false;
        const movedStatic = [];
        try {
            if (targetInfo && (staged || action === 'uninstall')) {
                fs.renameSync(target, path.join(backup, 'plugin'));
                oldDirectoryMoved = true;
            }
            if (staged) {
                fs.renameSync(staged, target);
                staged = undefined;
                newDirectoryPlaced = true;
            }
            changeRegistration(action, target, previous);
            if (action === 'uninstall') {
                for (const file of cached) {
                    const saved = path.join(backup, path.basename(file));
                    fs.cpSync(file, saved, { recursive: true });
                    movedStatic.push([file, saved]);
                    fs.rmSync(file, { recursive: true, force: true });
                }
            }
            if (restart) {
                restartAttempted = true;
                run('pm2', ['restart', service]);
                verifyPm2Online(service);
            }
        } catch (error) {
            // Execute each rollback step independently so one failure cannot leave addon.json or old files unrestored.
            if (newDirectoryPlaced) try { fs.rmSync(target, { recursive: true, force: true }); } catch (e) { console.error('回滚删除新目录失败:', e.message); }
            if (oldDirectoryMoved) try { fs.renameSync(path.join(backup, 'plugin'), target); } catch (e) { console.error('回滚恢复旧目录失败:', e.message); }
            for (const [file, saved] of movedStatic) try { fs.cpSync(saved, file, { recursive: true }); } catch (e) { console.error(`回滚恢复静态资源 ${file} 失败:`, e.message); }
            try { restoreAddons(previous, target); } catch (e) { console.error('回滚恢复 addon.json 失败:', e.message); }
            console.error(`操作失败，已恢复插件目录与 addon 注册。备份位于 ${backup}`);
            if (restartAttempted) {
                try { run('pm2', ['restart', service]); } catch { console.error(`请检查并手动重启 PM2 进程 ${service}`); }
            }
            throw error;
        }
        console.log(action === 'uninstall' ? '插件已卸载，文件已归档到备份，MongoDB 数据保留。' : `插件 ${pkg.version} 已安装到 ${target}`);
        if (!restart) console.log('请通过当前部署的服务管理器重启 Hydro，使更改生效。');
    } finally {
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
        cleanupLock();
    }
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const config = options(process.argv.slice(2));
        if (config) install(config);
        else help();
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
