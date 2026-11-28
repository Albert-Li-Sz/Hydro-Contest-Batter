// zh-CN can put the offset directly against the hour. Render the offset after the clock.
export function venueClock(timeZone, options = { second: '2-digit' }) {
    const formatter = new Intl.DateTimeFormat('zh-CN', {
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...options,
        timeZone, ...(timeZone ? { timeZoneName: 'shortOffset' } : {}),
    });
    return (value) => {
        const date = new Date(value);
        if (value == null || !Number.isFinite(date.getTime())) return '—';
        const parts = formatter.formatToParts(date);
        const offset = parts.find((part) => part.type === 'timeZoneName')?.value.replace(/^GMT/, 'UTC');
        const clock = parts.filter((part) => part.type !== 'timeZoneName').map((part) => part.value).join('').trim();
        return offset ? clock + ' ' + offset : clock;
    };
}
