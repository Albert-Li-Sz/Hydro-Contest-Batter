// Builds the contestant client (submit-client/, Go standard library only) for every platform into
// submit-client/dist: single files that need no installation. Requires Go 1.22 or later.
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'submit-client');
const dist = path.join(source, 'dist');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const targets = [['windows', 'amd64'], ['windows', 'arm64'], ['darwin', 'arm64'], ['darwin', 'amd64'], ['linux', 'amd64'], ['linux', 'arm64']];

await mkdir(dist, { recursive: true });
execFileSync('go', ['test', './...'], { cwd: source, stdio: 'inherit' });
for (const [os, arch] of targets) {
    const name = `hydro-submit-${os}-${arch}${os === 'windows' ? '.exe' : ''}`;
    execFileSync('go', ['build', '-trimpath', '-ldflags', `-s -w -X main.version=${version}`, '-o', path.join(dist, name), '.'], {
        cwd: source, stdio: 'inherit', env: { ...process.env, GOOS: os, GOARCH: arch, CGO_ENABLED: '0' },
    });
    console.log(`${name}  ${((await stat(path.join(dist, name))).size / 1048576).toFixed(1)} MB`);
}
