import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Environment } from 'nunjucks';
import type { BoardData } from '../lib/board';
import { resolverCodeBase } from '../lib/resolver-data';
import { resultsPage, snapshotOption } from '../lib/results-page';
import { ResultsStore, type SnapshotReason } from '../lib/results-store';
import { awardsCsv, boardOptions, resultBoard, standingsCsv, type ResultsData } from '../lib/results';
import type { BoardSettings } from '../lib/settings';
import { previewDatabase } from './resolver-memory-db';

export function createResultsPreview(env: Environment, version: string, db = previewDatabase().db) {
    const scope = { domainId: 'preview', contestId: 'demo' };
    const contestUrl = '/contest/demo';
    const base = `${contestUrl}/results`;
    const store = new ResultsStore(db);
    let id = 0;

    function current(data: BoardData, settings: BoardSettings): ResultsData {
        const beginAt = data.contest.start_time * 1000;
        const endAt = data.contest.end_time * 1000;
        return {
            data, settings, at: Math.max(Date.now(), endAt + 30_000), beginAt, endAt, lockAt: null, unlocked: true,
            problemIds: Array.from({ length: data.contest.problem_quantity }, (_, index) => 100 + index),
            coaches: { '1': ['示例教练'] },
        };
    }

    async function capture(data: ResultsData, reason: SnapshotReason, key: string, label?: string) {
        await store.save(scope, { _id: key, reason, label, eventAt: new Date(data.at) }, async () => data);
    }

    async function handle(request: IncomingMessage, response: ServerResponse, url: URL, data: BoardData, settings: BoardSettings) {
        if (url.pathname !== base && !url.pathname.startsWith(`${base}/export/`)) return false;
        const now = current(data, settings);
        const legacy = 'demo-rejudge-snapshot';
        await capture({
            ...now, at: now.endAt + 5000,
            data: { ...data, submissions: data.submissions.map((run, index) => index === 2 ? { ...run, status: 'WRONG_ANSWER' } : run) },
        }, 'rejudge', legacy, '示例重测');

        if (request.method === 'POST' && url.pathname === base) {
            let body = '';
            for await (const chunk of request) {
                body += chunk;
                if (body.length > 1000) throw new Error('快照名称过长');
            }
            const label = new URLSearchParams(body).get('snapshotName')?.trim().slice(0, 80);
            const key = `manual-${++id}`;
            await capture(now, 'manual', key, label);
            response.writeHead(303, { Location: `${base}?saved=1&before=${key}` }).end();
            return true;
        }

        async function read(source: string) {
            if (source === 'current') return now;
            const loaded = await store.read(scope, source);
            if (!loaded) throw new Error('快照不存在');
            return loaded;
        }

        const selectedBoard = url.searchParams.get('board') || 'all';
        if (url.pathname.startsWith(`${base}/export/`)) {
            const format = url.pathname.slice(`${base}/export/`.length);
            const source = await read(url.searchParams.get('source') || 'current');
            if (!boardOptions(source).some((option) => option.id === selectedBoard)) throw new Error('快照没有所选分榜');
            const projected = resultBoard(source, selectedBoard);
            const csv = format === 'awards' ? awardsCsv(projected) : standingsCsv(projected);
            response.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${format}.csv"`, 'Cache-Control': 'no-store' }).end(csv);
            return true;
        }

        const beforeId = url.searchParams.get('before') || '';
        const afterId = url.searchParams.get('after') || 'current';
        const model = resultsPage({
            tdoc: { title: data.contest.contest_name }, codeBase: resolverCodeBase(version), contestUrl, submissionsUrl: '/record/',
            selectedBoard, options: [{ id: 'current', name: '当前成绩' }, ...(await store.list(scope)).map(snapshotOption)],
            beforeId, afterId, before: beforeId ? await read(beforeId) : undefined, after: await read(afterId),
            allRows: url.searchParams.get('filter') === 'all', saved: url.searchParams.get('saved') === '1',
        });
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(env.render('xcpcio_results.html', model));
        return true;
    }

    return {
        handle, current, sources: async () => [{ id: 'current', name: '当前成绩' }, ...(await store.list(scope)).map(snapshotOption)],
        readSource: async (data: BoardData, settings: BoardSettings, id: string) => id === 'current' ? current(data, settings) : store.read(scope, id),
        unlock: (data: BoardData, settings: BoardSettings) => capture(current(data, settings), 'unlock', 'demo-unlock'),
    };
}
