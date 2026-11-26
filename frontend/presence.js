// A participant's contest tabs share a heartbeat. Capture has its own connection.
export function installPresence({ url, interval }) {
    const every = Math.max(5000, Number(interval) || 20000);
    const shared = `xcpcio-presence:${url}`;
    const sendBeat = () => {
        const now = Date.now();
        try {
            if (now - Number(localStorage.getItem(shared) || 0) < every * 0.75) return;
            localStorage.setItem(shared, String(now));
        } catch { /* storage is optional */ }
        fetch(url, {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: '{}',
        }).catch(() => null);
    };
    const initial = setTimeout(sendBeat, 2000);
    const timer = setInterval(sendBeat, every);
    return () => { clearTimeout(initial); clearInterval(timer); };
}
