import { boardOptions, compareResults, resultBoard, settled, type ResultsData } from './results';
import type { SnapshotMeta } from './results-store';

export interface ResultOption {
    id: string;
    name: string;
}
const reasons = { manual: '手动快照', end: '比赛结束', unlock: '解除封榜', rejudge: '批量重测前' };
export const optionDate = (at: Date) => new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium',
}).format(at);

export const snapshotOption = (snapshot: SnapshotMeta): ResultOption => ({
    id: snapshot._id, name: [
        snapshot.reason === 'end' && new Date(snapshot.createdAt).getTime() - new Date(snapshot.eventAt).getTime() > 20_000
            ? '比赛结束（补拍）' : reasons[snapshot.reason], snapshot.label, snapshot.jobId?.slice(-6),
        optionDate(new Date(snapshot.createdAt)), snapshot.final ? '' : '暂定',
    ].filter(Boolean).join(' · '),
});

export const resultsExportQuery = (board: string, source: string) => new URLSearchParams({ board, source }).toString();

export function resultsPage(params: {
    tdoc: { title: string };
    codeBase: string;
    contestUrl: string;
    submissionsUrl: string;
    selectedBoard: string;
    options: ResultOption[];
    beforeId: string;
    afterId: string;
    before?: ResultsData;
    after: ResultsData;
    allRows: boolean;
    saved: boolean;
}) {
    const { before, after, options, selectedBoard: selected, beforeId, afterId, allRows, contestUrl } = params;
    const afterBoards = boardOptions(after);
    const boardMap = new Map(afterBoards.map((board) => [board.id, board]));
    if (before) for (const board of boardOptions(before)) if (!boardMap.has(board.id)) boardMap.set(board.id, board);
    const selectedBoard = boardMap.has(selected) ? selected : 'all';
    const result = resultBoard(after, selectedBoard);
    const comparison = before && compareResults(resultBoard(before, selectedBoard), result);
    const changes = comparison && (allRows ? comparison.rows : comparison.rows.filter((row) => row.changed));
    const afterApproximate = afterId.startsWith('history:');
    const approximate = beforeId.startsWith('history:') || afterApproximate;
    const exportQuery = resultsExportQuery(selectedBoard, afterId);
    return {
        ...params,
        selectedBoard, boards: [...boardMap.values()], result, comparison, changes, approximate,
        isFinal: !afterApproximate && settled(after), exportQuery, exportable: afterBoards.some((board) => board.id === selectedBoard),
        base: `${contestUrl}/results`, nativeCode: `${contestUrl}/code?all=true`,
    };
}
