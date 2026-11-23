import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// TypeScript 7 is the native compiler and has no programmatic compiler API, so run its tsc.
// Hydro publishes TypeScript source with its own non-strict compiler settings: check our code
// strictly against its actual API types and leave out what tsc reports inside the host's source.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const tsc = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
const run = spawnSync(process.execPath, [tsc, '--noEmit', '-p', root, '--pretty', 'false'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
if (run.error) throw run.error;
if (run.signal) throw new Error(`tsc was interrupted by ${run.signal}`);

// One diagnostic per `file(line,col): error TSnnnn: …` line, with its indented continuation lines;
// configuration errors carry no file.
const diagnostics = [];
for (const line of `${run.stdout}${run.stderr}`.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (/^\s/.test(line) && diagnostics.length) diagnostics.at(-1).push(line);
    else diagnostics.push([line]);
}
const ours = diagnostics.filter(([first]) => {
    const file = /^(.+?)\(\d+,\d+\): /.exec(first)?.[1];
    return !file || !path.resolve(root, file).split(path.sep).includes('node_modules');
});
if (ours.length) {
    console.error(ours.map((lines) => lines.join('\n')).join('\n'));
    process.exitCode = 1;
} else if (run.status !== 0 && (run.status !== 1 || !diagnostics.length)) {
    console.error(`tsc exited unexpectedly with status ${run.status}`);
    process.exitCode = 1;
} else {
    const { version } = require('hydrooj/package.json');
    console.log(`Plugin typecheck passed against the installed Hydro API (hydrooj ${version}).`);
}
