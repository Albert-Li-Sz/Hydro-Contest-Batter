/**
 * The venue's time zone (plugin config `timeZone`, an IANA name): wall-clock times the server
 * writes for people — clarification notices, balloon tickets, printouts, result snapshots — are
 * in this zone, with a "UTC+8"-style label where the reader may sit elsewhere.
 */
export const DEFAULT_TIME_ZONE = 'Asia/Shanghai';

let current = DEFAULT_TIME_ZONE;

export function validTimeZone(name: unknown): name is string {
    if (typeof name !== 'string' || !/^[a-z]/i.test(name.trim()) || name.length > 64) return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: name.trim() });
        return true;
    } catch {
        return false;
    }
}

/** Sets the zone from the config; an unknown name keeps the default and is reported to the caller. */
export function setTimeZone(name: unknown) {
    if (name === undefined || name === null || name === '') { current = DEFAULT_TIME_ZONE; return true; }
    if (!validTimeZone(name)) { current = DEFAULT_TIME_ZONE; return false; }
    current = new Intl.DateTimeFormat('en-US', { timeZone: name.trim() }).resolvedOptions().timeZone;
    return true;
}

export const timeZone = () => current;

const formats = new Map<string, Intl.DateTimeFormat>();
function format(options: Intl.DateTimeFormatOptions, zone: string) {
    const key = `${zone}\n${JSON.stringify(options)}`;
    let value = formats.get(key);
    if (!value) {
        if (formats.size > 64) formats.clear();
        value = new Intl.DateTimeFormat('zh-CN', { ...options, timeZone: zone });
        formats.set(key, value);
    }
    return value;
}

const valid = (value: Date | string | number) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
};

/** `2026/11/28 14:05:09` */
export function formatDateTime(value: Date | string | number, zone = current) {
    const date = valid(value);
    return date ? format({ year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }, zone).format(date) : '';
}

/** `14:05:09` */
export function formatTimeOfDay(value: Date | string | number, zone = current) {
    const date = valid(value);
    return date ? format({ hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }, zone).format(date) : '';
}

/** `14:05` */
export function formatClock(value: Date | string | number, zone = current) {
    const date = valid(value);
    return date ? format({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }, zone).format(date) : '';
}

/** `2026/11/28 14:05:09`, shorter: `26/11/28 14:05:09` as Intl's dateStyle short and timeStyle medium. */
export function formatShortDateTime(value: Date | string | number, zone = current) {
    const date = valid(value);
    return date ? format({ dateStyle: 'short', timeStyle: 'medium' }, zone).format(date) : '';
}

/** The zone's offset at that moment: `UTC+8`, `UTC-3:30`, `UTC`. */
export function zoneLabel(value: Date | string | number = Date.now(), zone = current) {
    const date = valid(value) || new Date();
    const name = format({ timeZoneName: 'longOffset' }, zone).formatToParts(date).find((part) => part.type === 'timeZoneName')?.value || '';
    const match = /([+-])(\d{1,2})(?::?(\d{2}))?/.exec(name);
    if (!match) return 'UTC';
    const hours = Number(match[2]);
    const minutes = Number(match[3] || 0);
    if (!hours && !minutes) return 'UTC';
    return `UTC${match[1]}${hours}${minutes ? `:${String(minutes).padStart(2, '0')}` : ''}`;
}
