/**
 * A printout of contest code as data the print client draws: a header naming the team (seat,
 * school, members, file, ...) repeated on every page, then the code as lines of styled runs for
 * black-and-white printing (keywords bold, comments italic grey, strings dark grey). The client
 * needs no fonts or layout library of its own.
 */
import { tokenize, type TokenType } from './print-highlight';
import type { PrintSettings } from './print';
import { formatDateTime } from './time-zone';

export interface PrintSheet {
    id: string;
    team: string;
    school?: string;
    members?: string[];
    account?: string;
    seat?: string;
    unofficial?: boolean;
    /** The file name participants gave, or the problem. */
    problem?: string;
    language: string;
    languageName?: string;
    time: string | Date;
    lines: number;
    /** null when the code cannot be printed (too large). */
    code: string | null;
}

export const languageLabel: Record<string, string> = {
    cpp: 'C++', c: 'C', python: 'Python', java: 'Java', kotlin: 'Kotlin', go: 'Go', rust: 'Rust', javascript: 'JavaScript', csharp: 'C#', pascal: 'Pascal',
};

/** Run styles the client knows: '' plain, 'k' bold, 'c' italic grey, 's' dark grey, 'n' plain, 'p' bold. */
const styleOf: Record<TokenType, string> = { '': '', keyword: 'k', comment: 'c', string: 's', number: 'n', preprocessor: 'p' };

export interface PrintJob {
    id: string;
    /** Name of the job in the printer queue. */
    title: string;
    contest: string;
    header: { team: string; seat: string; rows: [string, string][] };
    /** Lines of [style, text] runs; null when the code cannot be printed. */
    lines: [string, string][][] | null;
    message: string;
    fontSize: number;
    lineNumbers: boolean;
    /** Test pages name the printer they are for; '' lets the PC choose. */
    printer?: string;
}

// Contest time as the venue reads it (plugin config timeZone).
const formatTime = (value: string | Date) => formatDateTime(value);

export function printJob(sheet: PrintSheet, settings: PrintSettings, contestTitle: string): PrintJob {
    const show = new Set<string>(settings.header);
    const rows: [string, string][] = [];
    if (show.has('school') && sheet.school) rows.push(['学校', sheet.school]);
    if (show.has('members') && sheet.members?.length) rows.push(['队员', sheet.members.join('、')]);
    if (show.has('account') && sheet.account) rows.push(['账号', sheet.account]);
    if (show.has('problem') && sheet.problem) rows.push(['文件', sheet.problem]);
    const language = sheet.languageName || languageLabel[sheet.language];
    if (show.has('language') && language) rows.push(['语言', language]);
    if (show.has('time')) rows.push(['请求时间', formatTime(sheet.time)]);
    if (show.has('id')) rows.push(['编号', sheet.id]);
    rows.push(['行数', String(sheet.lines)]);
    const team = show.has('team') ? `${sheet.team}${sheet.unofficial ? '（打星）' : ''}` : '';
    let lines: [string, string][][] | null = null;
    if (sheet.code !== null) {
        lines = settings.highlight
            ? tokenize(sheet.code, sheet.language).map((tokens) => tokens.map((token): [string, string] => [styleOf[token.type], token.text]))
            : sheet.code.replace(/\n$/, '').split('\n').map((text): [string, string][] => [['', text]]);
        // Tabs as four spaces: the client lays out by character.
        lines = lines.map((runs) => runs.map(([style, text]): [string, string] => [style, text.replace(/\t/g, '    ').replace(/[\r\f\v]/g, '')]));
    }
    return {
        id: sheet.id,
        title: [team || sheet.account || '打印', show.has('seat') && sheet.seat ? `座位 ${sheet.seat}` : '', sheet.problem || ''].filter(Boolean).join(' · ').slice(0, 120),
        contest: contestTitle,
        header: { team, seat: show.has('seat') ? sheet.seat || '' : '', rows },
        lines,
        message: sheet.code === null ? '代码超过 256 KB，无法打印，请在 Hydro 中查看。' : '',
        fontSize: settings.fontSize,
        lineNumbers: settings.lineNumbers,
    };
}
