import { BLACK } from './certificate-colors.js';

// Native coordinates of the supplied ICPC Shenyang regional team certificate.
const mm = 25.4 / 72;
export const eventPaper = { width: 841.9 * mm, height: 595.3 * mm };
const rect = (x, y, width, height) => ({ x: x * mm, y: y * mm, width: width * mm, height: height * mm });
const sourceRect = (x, y, w, h) => rect(-1.44 + x * 840.72 / 1754, y * 594.48 / 1240, w * 840.72 / 1754, h * 594.48 / 1240);
export const eventSourceImage = sourceRect(0, 0, 1754, 1240);
export const eventLetterhead = { file: 'letterhead.png', ...sourceRect(0, 0, 1754, 850) };
export const eventTrophy = { file: 'trophy.png', ...sourceRect(197, 56, 110, 189) };
export const eventEmblem = { file: 'icpc-mark.png', ...sourceRect(131, 374, 424, 435) };
export const isEventDesign = (design) => design === 'event' || design === 'event-zh';
export const eventSignatures = [
    { label: '左侧签名', name: 'William B. Poucher, Ph.D.', role: 'ICPC Global Executive Director', ...sourceRect(218, 1024, 356, 166) },
    { label: '中间签名', name: 'C. Jinshong Hwang, Ph.D.', role: 'ICPC Asia Governor', ...sourceRect(645, 1024, 465, 166) },
    { label: '右侧签名', name: 'WangQiang, Vice-President Northeastern', role: 'University', ...rect(565, 490, 218, 79) },
];
const chineseSigners = [
    ['William B. Poucher 博士', 'ICPC 全球执行主任'],
    ['C. Jinshong Hwang 博士', 'ICPC 亚洲区负责人'],
    ['WangQiang', '东北大学副校长'],
];
export const signatureSlots = (design) => design === 'event-zh'
    ? eventSignatures.map((box, i) => ({ ...box, name: chineseSigners[i][0], role: chineseSigners[i][1] })) : eventSignatures;
export const signatureFile = (design, slot) => `signature-${design === 'event-zh' ? 'zh-' : ''}${slot}.png`;
// Baselines in points above the bottom edge, as in the original PDF.
export function eventTemplate(kind, design = 'event') {
    const field = (id, text, baseline, size, kinds = []) => ({
        id, text, type: 'text', x: 549.4 * mm, y: (595.3 - baseline - .35 * size) * mm,
        size, width: 184, color: BLACK, align: 'center', kinds,
    });
    if (design === 'event-zh') {
        const award = kind === 'award';
        return { orientation: 'landscape', font: 'serif', frame: design, textColorVersion: 1, background: null, fields: [
            { ...field('title-zh', award ? '获奖证书' : '参赛证明', 503, 54), x: 420.95 * mm, width: 170 },
            field('recipient-label', award ? '兹授予' : '兹证明', 413.33, 12),
            field('school', '{school}', 387.05, 21),
            ...(award ? [field('roster', '{members}\n{coach}', 353.45, 17.05, ['team'])] : []),
            field('name', '{name}', 353.45, 17.05, award ? ['member', 'coach'] : []),
            award ? field('award', '{award}', 237.17, 30) : field('participation-label', '参加了', 237.17, 17),
            field('contest', '{contest}', 184.25, 21),
            field('venue-date', '{issuer}    {date}', 155.45, 15.5),
        ] };
    }
    return { orientation: 'landscape', font: 'sans', frame: 'event', textColorVersion: 1, background: null, fields: [
        field('recipient-label', 'awarded to', 413.33, 12),
        field('school-en', '{schoolEn}', 387.05, 20.05),
        ...(kind === 'award' ? [field('roster', '{membersEn}\n{coachEn}', 353.45, 17.05, ['team'])] : []),
        field('name-en', '{nameEn}', 353.45, 17.05, kind === 'award' ? ['member', 'coach'] : []),
        field('award', kind === 'award' ? '{awardEn}' : 'Participant', 237.17, 27.95),
        field('contest-en', '{contestEn}', 184.25, 21.95),
        field('venue-date', '{issuer}    {date}', 155.45, 15.5),
    ] };
}
const boldIds = {
    event: new Set(['school-en', 'roster', 'name-en', 'award', 'contest-en']),
    'event-zh': new Set(['title-zh', 'school', 'roster', 'name', 'award', 'contest']),
};
export const eventBold = (id, design = 'event') => boldIds[design].has(id);
const list = (value) => (value || '').split(/,\s+|、|\n/).map((s) => s.trim()).filter(Boolean);

function chineseDate(value = '') {
    const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(value);
    const written = /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/.exec(value);
    const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
    const [year, month, day] = iso ? iso.slice(1).map(Number) : written
        ? [Number(written[3]), months.indexOf(written[1].toLowerCase()) + 1, Number(written[2])] : [];
    return year && month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate()
        ? `${year}年${month}月${day}日` : value;
}
const chineseAwards = { 'gold medal': '金奖', 'silver medal': '银奖', 'bronze medal': '铜奖', 'honorable mention': '荣誉奖' };
export function eventText(template, values, kind, englishAward, design = 'event') {
    const replace = (display) => template.replace(/\{([a-zA-Z]+)\}/g, (match, key) => Object.hasOwn(display, key) ? display[key] || '' : match).trim();
    if (design === 'event-zh') {
        const name = values.name || values.nameEn || '';
        const award = values.award || values.awardEn || '';
        return replace({ ...values, school: values.school || values.schoolEn, contest: values.contest || values.contestEn,
            name: kind === 'coach' && name ? name + '（教练）' : name,
            members: list(values.members || values.membersEn).join('\n'), coach: list(values.coach || values.coachEn).map((s) => s + '（教练）').join('\n'),
            award: Object.hasOwn(chineseAwards, award.toLowerCase()) ? chineseAwards[award.toLowerCase()] : award,
            awardEn: englishAward || values.awardEn, date: chineseDate(values.date) });
    }
    const coaches = list(values.coachEn || values.coach);
    const name = values.nameEn || values.name || '';
    const display = { ...values, schoolEn: values.schoolEn || values.school, contestEn: values.contestEn || values.contest,
        membersEn: list(values.membersEn || values.members).join('\n'), coachEn: coaches.map((value) => value + ', Coach').join('\n'),
        nameEn: kind === 'coach' && name ? name + ', Coach' : name, awardEn: englishAward || values.award };
    return replace(display);
}

// A normal three-person roster reproduces the four original baselines. Larger rosters stay inside the same space.
export function eventLines(field, content, design = 'event') {
    let lines = content.split('\n').map((s) => s.trim()).filter(Boolean);
    if (lines.length > 8) {
        const perRow = Math.ceil(lines.length / 8);
        lines = lines.reduce((rows, name, i) => {
            if (i % perRow === 0) rows.push(name);
            else rows[rows.length - 1] += '  ·  ' + name;
            return rows;
        }, []);
    }
    const size = field.size * Math.min(1, 4 / Math.max(1, lines.length));
    const offsets = [0, 18.959, 38.04, 57];
    return (lines.length ? lines : ['']).map((text, i) => ({ text, size,
        y: field.y + (offsets[i] ?? i * 19) * mm * size / 17.05, bold: eventBold(field.id, design) }));
}
