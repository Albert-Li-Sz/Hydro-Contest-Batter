import { describe, expect, it } from 'vitest';
import { issueWorkerCode, workerApiPath, workerAuthorized, workerName, workerOrigin } from '../lib/reactions-connection';

const id = 'a'.repeat(24),
    tid = 'b'.repeat(24),
    base = '/d/contest-domain/contest/' + tid + '/reactions';
function decode(code: string) {
    expect(code.startsWith('hydro-reactions:')).toBe(true);
    return JSON.parse(Buffer.from(code.slice('hydro-reactions:'.length), 'base64url').toString('utf8'));
}
describe('contest-bound media machine connections', () => {
    it('uses a per-machine bearer and keeps the secret out of HTTP paths and stored hashes', () => {
        const first = issueWorkerCode('https://hydro.test', base, id),
            second = issueWorkerCode('https://hydro.test', base, id);
        const a = decode(first.code),
            b = decode(second.code);
        expect(a).toEqual({ v: 1, id, url: 'https://hydro.test' + workerApiPath(base, id), token: expect.stringMatching(/^[\w-]{32}$/) });
        expect(a.url).not.toContain(a.token);
        expect(first.tokenHash).toMatch(/^[a-f0-9]{64}$/);
        expect(first.tokenHash).not.toContain(a.token);
        expect(a.token).not.toEqual(b.token);
        expect(workerAuthorized('Bearer ' + a.token, first.tokenHash)).toBe(true);
        expect(workerAuthorized('Bearer ' + a.token, second.tokenHash)).toBe(false);
        expect(workerAuthorized('Bearer ' + first.tokenHash, first.tokenHash)).toBe(false);
        for (const h of [undefined, 'Basic ' + a.token, a.token, 'Bearer ' + a.token + ' extra'])
            expect(workerAuthorized(h, first.tokenHash)).toBe(false);
    });
    it('uses the browser public origin behind a reverse proxy and ignores unrelated destinations', () => {
        expect(workerOrigin('https://hydro.test', null, 'hydro.test', 'http')).toBe('https://hydro.test');
        expect(workerOrigin('https://outside.test', 'https://hydro.test/', 'hydro.test', 'https')).toBe('https://hydro.test');
        expect(workerOrigin('https://guest:secret@outside.test', null, 'localhost:8888', 'http')).toBe('http://localhost:8888');
        expect(() => workerOrigin(null, 'javascript:bad', '', 'file')).toThrow();
        expect(workerName('  场馆 A  ')).toBe('场馆 A');
        expect(() => workerName('  ')).toThrow();
        expect(() => workerName('x'.repeat(81))).toThrow();
    });
});
