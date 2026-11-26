// Type declaration for the plugin's tests; the module itself is Resolver-Web's port of ICPC Tools.
export function formatTime(ms: number, floor: boolean): string;
export class ContestView {
    constructor(data: unknown, words?: Record<string, string>);
    getAllSubmissions(): { teamId: string; problemIndex: number; status: string; firstToSolve: boolean }[];
    getProblemSummary(index: number): { numPending: number; numSolved: number };
}
