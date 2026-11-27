// Run the actual downloadable client against the production API handlers on the isolated preview.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { once } from 'node:events';

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(path.join(os.tmpdir(), 'hydro-submit-test-'));
const platform = `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch === 'x64' ? 'amd64' : process.arch}${process.platform === 'win32' ? '.exe' : ''}`;
const binary = process.platform === 'win32' ? 'submit.exe' : 'submit';
const domain = '/d/system', problemPage = '/contest/demo/problems', downloadPage = '/contest/demo/submit-client';
const host = '127.0.0.1';
async function start(ip) {
    const pool = net.createServer();
    pool.listen(0, host);
    await once(pool, 'listening');
    const port = pool.address().port;
    await new Promise((res) => pool.close(res));
    const proc = spawn(process.execPath, ['--import', 'tsx', 'scripts/preview.ts'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, XCPCIO_PREVIEW_PORT: String(port), XCPCIO_PREVIEW_STATE: path.join(temp, 'state.json'), XCPCIO_PREVIEW_SUBMIT_IP: ip } });
    let log = '';
    proc.stdout.on('data', s => { log += s; });
    proc.stderr.on('data', s => { log += s; });
    const base = `http://${host}:${port}`;
    for (let i = 0; i < 200; i++) {
        if (proc.exitCode != null) throw new Error(log);
        if (await fetch(base + downloadPage).then(r => r.ok).catch(() => false)) return { base, proc };
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    proc.kill(); throw new Error('预览服务没有就绪\n' + log);
}

const servers = [];
try {
    const { base, proc } = await start(host); servers.push(proc);
    const res = await fetch(base + problemPage);
    assert.match(await res.text(), /href="\/contest\/demo\/submit-client"/);
    const page = await (await fetch(base + downloadPage)).text();
    assert.equal((page.match(/href="[^"]+\/submit-client\/(?:windows|darwin|linux)-/g) || []).length, 6);
    const zipResponse = await fetch(base + downloadPage + '/' + platform);
    assert.equal(zipResponse.status, 200, '请先运行 pnpm build:submit-client 和 pnpm build');
    const archive = path.join(temp, 'client.zip'), bin = path.join(temp, 'bin');
    await writeFile(archive, new Uint8Array(await zipResponse.arrayBuffer()));
    await mkdir(bin);
    // Standard-library Go helper exercises Unix executable bits and also works on Windows.
    await writeFile(path.join(temp, 'extract.go'), `package main
import ("archive/zip"; "os"; "io"; "path/filepath")
func main(){z,e:=zip.OpenReader(os.Args[1]);if e!=nil{panic(e)};defer z.Close();for _,f:=range z.File{r,e:=f.Open();if e!=nil{panic(e)};w,e:=os.OpenFile(filepath.Join(os.Args[2],f.Name),os.O_CREATE|os.O_WRONLY,f.Mode().Perm());if e!=nil{panic(e)};if _,e:=io.Copy(w,r);e!=nil{panic(e)};r.Close();w.Close()}}`);
    await execute('go', ['run', path.join(temp, 'extract.go'), archive, temp], { cwd: temp });
    // A private bin on PATH verifies the plain install command without touching the developer's shell.
    const env = { ...process.env, PATH: bin };
    delete env.HYDRO_SUBMIT_SERVER;
    assert.equal(JSON.parse(await readFile(path.join(temp, 'submit-server.json'), 'utf8')).server, base + domain);
    const options = { cwd: temp, env };
    await execute(path.join(temp, binary), ['install'], options);
    const cli = async (...args) => (await execute(path.join(bin, binary), args, options)).stdout;
    assert.match(await cli('info'), /team01.*101/);
    await writeFile(path.join(temp, 'B.cpp'), 'int main() { return 0; }');
    const submit = await cli('B.cpp', '-l', 'cpp');
    const rid = submit.match(/已提交 B ([a-f0-9]{24})/)?.[1]; assert.ok(rid, submit);
    assert.match(await cli('status'), new RegExp(rid + '  B  cc.cc17o2  WAIT'));
    assert.match(await cli('print', 'B.cpp'), /已加入打印队列：B.cpp/);
    const cookie = await fetch(base + domain + '/xcpcio-submit/info', { headers: { Cookie: 'sid=browser' } }); assert.equal(cookie.status, 403);
    const wrongContest = await fetch(base + domain + '/xcpcio-submit/status?tid=aaaaaaaaaaaaaaaaaaaaaaaa'); assert.equal(wrongContest.status, 403);
    const other = await start('192.0.2.5'); servers.push(other.proc);
    await assert.rejects(cli('info', '--server', other.base + domain), /HTTP 403/);
    console.log('submit E2E passed: download and preconfigured install, IP-only identity, submission receipt, team status, printing, unbound host and cookie refusal.');
} finally {
    for (const server of servers) {
        if (server.exitCode === null) { const stopped = once(server, 'exit'); server.kill(); await stopped; }
    }
    await rm(temp, { recursive: true, force: true });
}
