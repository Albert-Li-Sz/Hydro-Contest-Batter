import fs from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { describe, it, expect } from 'vitest';
import { ccsFixture } from './ccs-fixture';
import { buildObjects, buildScoreboard, teamObjects } from '../lib/ccs/model';
import { endpointProperties, project, accessObject } from '../lib/ccs/access';
import { abstime, parseAbstime, parseReltime, reltime, isId, languageId } from '../lib/ccs/types';
import { readZip, writeZip } from '../lib/ccs/zip';

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const directory = path.join(__dirname, 'ccs-schema');
for (const file of fs.readdirSync(directory).filter(name => name.endsWith('.json'))) {
    const schema = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
    // 2026-01 explicitly makes data properties optional according to access/visibility. The
    // upstream run schema still unconditionally requires wall-clock timestamps Hydro lacks.
    if (file === 'run.json') schema.required = schema.required.filter((p: string) => !['time', 'contest_time'].includes(p));
    if (file === 'submission.json') schema.required = schema.required.filter((p: string) => p !== 'files');
    ajv.addSchema(schema);
}
function validate(name: string, value: unknown) {
    const schema = ajv.getSchema(`https://github.com/icpc/ccs-specs/raw/master/json-schema/${name}.json`)!;
    expect(schema(value), `${name}: ${JSON.stringify(schema.errors)}`).toBe(true);
}

describe('CCS 2026-01 objects', () => {
    for (const role of ['admin', 'judge', 'team', 'public'] as const) it(`${role}: official JSON schemas and references`, () => {
        const source = ccsFixture();
        const access = { role, identity: true, teamContest: false };
        const props = endpointProperties(access);
        const objects = role === 'team' ? teamObjects(buildObjects(source, 'full'), buildObjects(source, 'public'), '1') : buildObjects(source, role === 'public' ? 'public' : 'full');
        validate('access', accessObject(access));
        for (const [type, value] of Object.entries(objects)) {
            const p = props[type === 'contest' ? 'contests' : type as keyof typeof props];
            if (!p) continue;
            const name = type === 'commentary' ? 'commentaries' : type;
            validate(name, Array.isArray(value) ? value.map(item => project(item, p)) : project(value, p));
        }
        validate('scoreboard', buildScoreboard(source, role === 'public' || role === 'team' ? 'public' : 'full', null));
    });
    it('keeps frozen results private but gives the team its own result', () => {
        const s = ccsFixture(); s.contest.lockAt = s.contest.beginAt + 1000; s.now = s.contest.beginAt + 700_000;
        const pub = buildObjects(s, 'public');
        expect(pub.judgements).toEqual([]);
        const own = teamObjects(buildObjects(s, 'full'), pub, '1');
        expect(own.judgements.every(j => own.submissions.find(r => r.id === j.submission_id)?.team_id === '1')).toBe(true);
    });
    it('lists the team itself to its members while the public cannot see teams yet', () => {
        const s = ccsFixture(); s.publicVisible = false;
        const pub = buildObjects(s, 'public');
        expect(pub.teams).toEqual([]);
        const own = buildObjects(s, 'team-1');
        expect(own.teams.map(team => team.id)).toEqual(['1']);
        const ids = new Set(own.teams.map(team => team.id));
        expect(own.submissions.every(item => ids.has(item.team_id!))).toBe(true);
        expect(buildObjects(s, 'team-1')).toBe(own);
    });
    it('does not announce a first-to-solve award while an earlier eligible submission is pending', () => {
        const source = ccsFixture(); source.settings.firstSolve = true;
        const award = buildObjects(source, 'full').awards.find(award => award.id.startsWith('first-to-solve-') && award.team_ids?.length)!;
        expect(award).toBeTruthy();
        const problem = Number(award.id.replace('first-to-solve-', '')) - 100;
        source.full.submissions.push({ submission_id: 'pending-earlier', team_id: award.team_ids![0], problem_id: problem, timestamp: 1, status: 'PENDING' });
        expect(buildObjects(structuredClone(source), 'full').awards.find(item => item.id === award.id)?.team_ids).toEqual([]);
    });
    it('publishes special awards only when the results are final and visible', () => {
        const source = ccsFixture();
        source.settings.specialAwards = [{ id: 'last', name: '顽强拼搏奖', kind: 'lastAccept', board: 'all', rank: 1, teamIds: [], unofficial: false, ties: true }];
        const special = (view: 'public' | 'full') => buildObjects(structuredClone(source), view).awards.find(item => item.id === 'special-last');
        expect(special('public')).toMatchObject({ citation: '顽强拼搏奖', team_ids: ['3'] });
        source.contest.lockAt = source.contest.beginAt + 3600_000;
        expect(special('public')).toBeUndefined();
        expect(special('full')?.team_ids).toEqual(['3']);
        source.contest.unlocked = true;
        source.public.submissions[0].status = 'PENDING';
        expect(special('public')).toBeUndefined();
        source.now = source.contest.endAt - 1;
        expect(special('full')).toBeUndefined();
    });
    it('validates calendar times, safe relative times and IDs', () => {
        expect(parseAbstime('2026-02-30T00:00:00.000Z')).toBeNull();
        expect(parseAbstime('2026-13-01T00:00:00.000Z')).toBeNull();
        expect(parseAbstime('2026-11-16T24:00:00.000Z')).toBeNull();
        expect(parseReltime('999999999999999999:00:00')).toBeNull();
        for (const ms of [-1234, 0, 123456789]) expect(parseReltime(reltime(ms))).toBe(ms);
        const t = Date.UTC(2026, 10, 16, 3, 2, 1, 123);
        expect(parseAbstime(abstime(t, 480))).toBe(t);
        for (const id of ['cc.cc17o2', '-.bad', `${'x'.repeat(35)}.q`, 'a b']) expect(isId(languageId(id))).toBe(true);
    });
    it('round trips ZIP and rejects traversal, corruption and expansion beyond the limit', () => {
        const input = [{ name: 'main.cpp', data: Buffer.from('int main() {}') }];
        expect(readZip(writeZip(input), { maxFiles: 1, maxBytes: 100 })).toEqual(input);
        expect(() => readZip(writeZip([{ name: '../a', data: Buffer.from('x') }]), { maxFiles: 1, maxBytes: 100 })).toThrow();
        expect(() => readZip(writeZip(input), { maxFiles: 1, maxBytes: 1 })).toThrow();
        expect(() => readZip(Buffer.from('bad'), { maxFiles: 1, maxBytes: 100 })).toThrow();
    });
});
