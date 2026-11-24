import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const packageName = 'hydro-scoreboard-xcpcio-plus';
let directory: string;
let profile: string;
let binaries: string;
let target: string;
let source: string;

function write(file: string, content: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
}

function registry(entries?: string[]) {
    const file = path.join(profile, 'addon.json');
    if (entries) fs.writeFileSync(file, JSON.stringify(entries));
    return JSON.parse(fs.readFileSync(file, 'utf8')) as string[];
}

function makePackage(folder: string, version = '0.8.1') {
    const files = ['index.ts', 'public', 'scripts/manage-addon.mjs', 'install.sh', 'README.md'];
    write(path.join(folder, 'package.json'), JSON.stringify({ name: packageName, version, main: 'index.ts', files }));
    write(path.join(folder, 'index.ts'), `export const version = '${version}';`);
    write(path.join(folder, 'README.md'), 'Fixture');
    for (const file of ['install.sh', 'scripts/manage-addon.mjs']) write(path.join(folder, file), fs.readFileSync(file, 'utf8'));
    write(path.join(folder, 'public/hydro-xcpcio/manifest.json'), JSON.stringify({ base: version, js: 'app.js', css: 'app.css' }));
    for (const file of [
        `public/hydro-xcpcio/${version}/app.js`, `public/hydro-xcpcio/${version}/app.css`,
        `public/hydro-xcpcio/${version}/award-policy.mjs`, `public/hydro-xcpcio/${version}/standings.js`, `public/hydro-xcpcio/${version}/trophies.js`,
        `public/hydro-resolver/${version}/js/play.js`, 'public/hydro-resolver/logos/index.json',
        'public/hydro-live/admin/index.html', 'public/hydro-live/overlay/index.html',
    ]) write(path.join(folder, file), '{}');
}

function invoke(action: string, args: string[] = [], extraEnv: Record<string, string> = {}, packageDirectory = source) {
    return spawnSync('bash', [path.join(packageDirectory, 'install.sh'), action, ...args], {
        encoding: 'utf8', timeout: 15_000,
        env: { ...process.env, PATH: `${binaries}${path.delimiter}${process.env.PATH}`, HYDRO_PROFILE: profile, ...extraEnv },
    });
}

function calls() {
    const file = path.join(profile, 'commands.jsonl');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
}

function backups() {
    const root = path.join(path.dirname(target), '.hydro-addon-backups', packageName);
    return fs.existsSync(root) ? fs.readdirSync(root).map((name) => path.join(root, name)) : [];
}

beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hydro-addon-test-'));
    profile = path.join(directory, 'isolated profile');
    binaries = path.join(directory, 'bin');
    target = path.join(profile, 'addons', packageName);
    source = path.join(directory, 'download with spaces', 'package');
    fs.mkdirSync(profile, { recursive: true });
    fs.mkdirSync(binaries);
    registry(['other-plugin']);
    makePackage(source);
    const fakeCommand = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const root = process.env.HYDRO_PROFILE;
const name = path.basename(process.argv[1]);
fs.appendFileSync(path.join(root, 'commands.jsonl'), JSON.stringify([name, ...args]) + '\\n');
if (name === 'hydrooj') {
  const file = path.join(root, 'addon.json');
  let entries = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (args[1] === 'add' && !process.env.TEST_SILENT_ADD_FAILURE) entries = [...new Set([...entries, args[2]])];
  if (args[1] === 'add' && process.env.TEST_CONCURRENT_ADD) entries.push('new-plugin');
  if (args[1] === 'remove' && !process.env.TEST_SILENT_REMOVE_FAILURE) entries = entries.filter(entry => entry !== args[2]);
  fs.writeFileSync(file, JSON.stringify(entries));
} else if (args[0] === 'restart' && process.env.TEST_RESTART_FAILURE) {
  const marker = path.join(root, 'restart-failed-once');
  if (!fs.existsSync(marker)) {
    fs.writeFileSync(marker, '1');
    process.exit(1);
  }
}
`;
    for (const name of ['hydrooj', 'pm2']) {
        write(path.join(binaries, name), fakeCommand);
        fs.chmodSync(path.join(binaries, name), 0o755);
    }
});

afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });

describe('安装脚本', () => {
    it('从解压目录安装并注册绝对路径，按指定进程名重启', () => {
        const result = invoke('install', ['--service', 'hydro-contest']);
        expect(result.status, result.stderr).toBe(0);
        expect(registry()).toEqual(['other-plugin', target]);
        expect(fs.readFileSync(path.join(target, 'index.ts'), 'utf8')).toContain('0.8.1');
        expect(calls()).toContainEqual(['pm2', 'restart', 'hydro-contest']);
        expect(fs.existsSync(path.join(profile, '.xcpcio-install.lock'))).toBe(false);
    });

    it('升级归档旧目录并替换旧文件，只部署发布清单中的文件', () => {
        makePackage(target, '0.7.8');
        write(path.join(target, 'obsolete.js'), 'old');
        registry(['other-plugin', target]);
        write(path.join(source, '.env'), 'private');
        write(path.join(source, 'node_modules/private/index.js'), 'private');
        const result = invoke('upgrade');
        expect(result.status, result.stderr).toBe(0);
        expect(fs.existsSync(path.join(target, 'obsolete.js'))).toBe(false);
        expect(fs.existsSync(path.join(target, '.env'))).toBe(false);
        expect(fs.existsSync(path.join(target, 'node_modules'))).toBe(false);
        expect(fs.readFileSync(path.join(backups()[0], 'plugin/index.ts'), 'utf8')).toContain('0.7.8');
        expect(registry()).toEqual(['other-plugin', target]);
    });

    it('将旧 Yarn 包名和旧路径注册迁移到唯一的目录注册', () => {
        const previousPath = path.join(directory, 'previous-addon');
        makePackage(previousPath, '0.7.8');
        registry(['other-plugin', packageName, previousPath]);
        const result = invoke('upgrade');
        expect(result.status, result.stderr).toBe(0);
        expect(registry()).toEqual(['other-plugin', target]);
        expect(fs.existsSync(path.join(previousPath, 'index.ts'))).toBe(true);
    });

    it('在手动安装目录内重复安装可以补齐注册且不重复添加', () => {
        makePackage(target);
        registry(['other-plugin', packageName, target]);
        const result = invoke('install', [], {}, target);
        expect(result.status, result.stderr).toBe(0);
        expect(registry()).toEqual(['other-plugin', target]);
        expect(fs.existsSync(path.join(target, 'index.ts'))).toBe(true);
    });

    it('卸载归档文件及静态资源并保留其他插件和数据，可重复执行', () => {
        makePackage(target);
        registry(['other-plugin', target]);
        write(path.join(profile, 'database-data'), 'persistent');
        write(path.join(profile, 'static/other-plugin/logo.png'), 'other');
        for (const name of ['hydro-xcpcio', 'hydro-resolver', 'hydro-live']) write(path.join(profile, 'static', name, 'asset.js'), name);
        const result = invoke('uninstall', [], {}, target);
        expect(result.status, result.stderr).toBe(0);
        expect(registry()).toEqual(['other-plugin']);
        expect(fs.existsSync(target)).toBe(false);
        for (const name of ['hydro-xcpcio', 'hydro-resolver', 'hydro-live']) {
            expect(fs.existsSync(path.join(profile, 'static', name))).toBe(false);
            expect(fs.existsSync(path.join(backups()[0], name, 'asset.js'))).toBe(true);
        }
        expect(fs.readFileSync(path.join(profile, 'database-data'), 'utf8')).toBe('persistent');
        expect(fs.existsSync(path.join(profile, 'static/other-plugin/logo.png'))).toBe(true);
        expect(invoke('uninstall').status).toBe(0);
    });

    it('安装包缺少校徽时在修改已安装版本之前退出', () => {
        makePackage(target, '0.7.8');
        registry(['other-plugin', target]);
        fs.rmSync(path.join(source, 'public/hydro-resolver/logos'), { recursive: true });
        expect(invoke('upgrade').status).toBe(1);
        expect(fs.readFileSync(path.join(target, 'index.ts'), 'utf8')).toContain('0.7.8');
        expect(registry()).toEqual(['other-plugin', target]);
        expect(calls().some(([command, operation]) => command === 'pm2' && operation === 'restart')).toBe(false);
    });

    it('识别 Hydro 静默注册失败并恢复旧目录及包名注册', () => {
        makePackage(target, '0.7.8');
        registry(['other-plugin', packageName]);
        expect(invoke('upgrade', [], { TEST_SILENT_ADD_FAILURE: '1' }).status).toBe(1);
        expect(fs.readFileSync(path.join(target, 'index.ts'), 'utf8')).toContain('0.7.8');
        expect(registry()).toEqual(['other-plugin', packageName]);
    });

    it('重启失败时回滚升级并重新启动原版本', () => {
        makePackage(target, '0.7.8');
        registry(['other-plugin', target]);
        expect(invoke('upgrade', [], { TEST_RESTART_FAILURE: '1' }).status).toBe(1);
        expect(fs.readFileSync(path.join(target, 'index.ts'), 'utf8')).toContain('0.7.8');
        expect(registry()).toEqual(['other-plugin', target]);
        expect(calls().filter(([command, operation]) => command === 'pm2' && operation === 'restart')).toHaveLength(2);
        expect(fs.existsSync(path.join(profile, '.xcpcio-install.lock'))).toBe(false);
    });

    it('回滚保留原有加载顺序和期间新增的其他插件', () => {
        registry([packageName, 'other-plugin']);
        expect(invoke('install', [], { TEST_SILENT_ADD_FAILURE: '1', TEST_CONCURRENT_ADD: '1' }).status).toBe(1);
        expect(registry()).toEqual([packageName, 'other-plugin', 'new-plugin']);
        expect(fs.existsSync(target)).toBe(false);
    });

    it('卸载重启失败时恢复注册、插件和静态资源', () => {
        makePackage(target);
        registry(['other-plugin', target]);
        write(path.join(profile, 'static/hydro-live/asset.js'), 'asset');
        expect(invoke('uninstall', [], { TEST_RESTART_FAILURE: '1' }).status).toBe(1);
        expect(fs.existsSync(path.join(target, 'index.ts'))).toBe(true);
        expect(fs.readFileSync(path.join(profile, 'static/hydro-live/asset.js'), 'utf8')).toBe('asset');
        expect(registry()).toEqual(['other-plugin', target]);
    });

    it('解除注册静默失败时恢复安装目录', () => {
        makePackage(target);
        registry(['other-plugin', target]);
        expect(invoke('uninstall', [], { TEST_SILENT_REMOVE_FAILURE: '1' }).status).toBe(1);
        expect(registry()).toEqual(['other-plugin', target]);
        expect(fs.existsSync(path.join(target, 'index.ts'))).toBe(true);
        expect(calls().some(([command, operation]) => command === 'pm2' && operation === 'restart')).toBe(false);
    });

    it('拒绝占用其他应用的目录', () => {
        write(path.join(target, 'package.json'), JSON.stringify({ name: 'unrelated-app' }));
        expect(invoke('install').status).toBe(1);
        expect(JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).name).toBe('unrelated-app');
        expect(registry()).toEqual(['other-plugin']);
    });

    it('安装到已存在的空目录，非空且不是本插件的目录给出明确提示', () => {
        fs.mkdirSync(target, { recursive: true });
        const result = invoke('install', ['--no-restart']);
        expect(result.status, result.stderr).toBe(0);
        expect(registry()).toEqual(['other-plugin', target]);
        expect(fs.existsSync(path.join(target, 'index.ts'))).toBe(true);
        const other = path.join(directory, 'not-a-plugin');
        write(path.join(other, 'notes.txt'), 'keep');
        const refused = invoke('install', ['--dir', other, '--no-restart']);
        expect(refused.status).not.toBe(0);
        expect(refused.stderr).toContain('安装目录已被其他文件占用');
        expect(fs.readFileSync(path.join(other, 'notes.txt'), 'utf8')).toBe('keep');
    });

    it('并发调用保留现有锁和注册', () => {
        const lock = path.join(profile, '.xcpcio-install.lock');
        write(path.join(lock, 'pid'), 'another-process');
        expect(invoke('install').status).toBe(1);
        expect(fs.readFileSync(path.join(lock, 'pid'), 'utf8')).toBe('another-process');
        expect(registry()).toEqual(['other-plugin']);
    });

    it('支持带空格的自定义目录与容器延后重启', () => {
        target = path.join(directory, 'custom target');
        const result = invoke('install', ['--dir', target, '--no-restart']);
        expect(result.status, result.stderr).toBe(0);
        expect(registry()).toEqual(['other-plugin', target]);
        expect(calls().some(([command]) => command === 'pm2')).toBe(false);
        expect(invoke('uninstall', ['--dir', target, '--no-restart']).status).toBe(0);
        expect(registry()).toEqual(['other-plugin']);
    });
});
