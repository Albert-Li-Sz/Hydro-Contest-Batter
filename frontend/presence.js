// 机位监控: a participant's contest pages report that the computer is on (lib/presence-routes.ts).
// The page view itself was counted by the server; this keeps reporting while the page stays open,
// and says when it goes to the background.
export function installPresence({ url, interval }) {
    const every = Math.max(5000, Number(interval) || 20000);
    // Several tabs of the contest: the one in front reports, background tabs only when none does.
    const shared = `xcpcio-presence:${url}`;
    let timer = 0;
    let stopped = false;
    let mark = '';
    const send = (keepalive = false) => {
        const hidden = document.visibilityState !== 'visible';
        try {
            if (!hidden) localStorage.setItem(shared, mark = String(Date.now()));
            else if (Date.now() - Number(localStorage.getItem(shared) || 0) < every * 1.5) return;
        } catch { /* private mode: every tab reports */ }
        fetch(url, {
            method: 'POST', credentials: 'same-origin', keepalive,
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(hidden ? { hidden: true } : {}),
        }).catch(() => null);
    };
    const schedule = () => {
        clearTimeout(timer);
        if (!stopped) timer = setTimeout(() => { send(); schedule(); }, every);
    };
    const changed = () => {
        const hidden = document.visibilityState !== 'visible';
        // This tab was the one in front: its own mark must not hold back its report.
        if (hidden) try { if (localStorage.getItem(shared) === mark) localStorage.removeItem(shared); } catch { /* no storage */ }
        send(hidden);
        schedule();
    };
    document.addEventListener('visibilitychange', changed);
    schedule();
    return () => {
        stopped = true;
        clearTimeout(timer);
        document.removeEventListener('visibilitychange', changed);
    };
}
