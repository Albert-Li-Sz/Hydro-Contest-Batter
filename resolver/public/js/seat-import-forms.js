// Read credentials only in this page. CSV escaping is decoded without trimming the password.
export function readPasswordSlips(input, teams) {
    const text = input.replace(/^\uFEFF/, '');
    const delimiter = text.split(/[\r\n]/, 1)[0].includes('\t') ? '\t' : ',';
    const rows = [];
    let row = [], cell = '', quoted = false, closed = false;
    const finish = () => { row.push(cell); cell = ''; closed = false; };
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quoted) {
            if (ch !== '"') cell += ch;
            else if (text[i + 1] === '"') { cell += '"'; i++; }
            else { quoted = false; closed = true; }
        } else if (ch === delimiter) finish();
        else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && text[i + 1] === '\n') i++;
            finish(); if (row.some(value => value !== '')) rows.push(row); row = [];
        } else if (!cell && !closed && ch === '"') quoted = true;
        else if (ch === '"' || closed) throw new Error('表格引号格式无效');
        else cell += ch;
    }
    if (quoted) throw new Error('表格中有未闭合的引号');
    finish(); if (row.some(value => value !== '')) rows.push(row);
    const header = (rows.shift() || []).map(value => value.trim().toLowerCase());
    const login = header.findIndex(value => ['账号', '帐号', 'account', 'username', 'uname', 'login'].includes(value));
    const pass = header.findIndex(value => ['口令', '密码', 'password', 'passwd'].includes(value));
    if (login < 0 || pass < 0) throw new Error('表头须包含「账号、口令」或「Account,Password」');
    const roster = new Map();
    for (const team of teams) for (const name of team.accounts) roster.set(name.toLowerCase(), { team, account: name });
    const seen = new Set();
    const slips = rows.map((cells, index) => {
        const account = (cells[login] || '').trim().toLowerCase();
        const entry = roster.get(account);
        if (cells.length !== header.length || !entry || !cells[pass] || seen.has(account)) throw new Error(`第 ${index + 2} 行的账号不属于本场、重复或口令列无效`);
        seen.add(account);
        return { ...entry, password: cells[pass] };
    });
    if (!slips.length) throw new Error('表格没有可打印的账号');
    return slips;
}

/** Suggest a /24 prefix from the same room first, otherwise the most frequent one in the contest. */
export function prefixFor(teams, missing) {
    const room = missing.seat.match(/^\D+/)?.[0];
    const count = new Map();
    for (const team of teams) for (const ip of team.ips) {
        const match = /^(\d+\.\d+\.\d+\.)\d+$/.exec(ip);
        if (!match) continue;
        const value = count.get(match[1]) || { all: 0, local: 0 };
        value.all++;
        if (room && team.seat.match(/^\D+/)?.[0] === room) value.local++;
        count.set(match[1], value);
    }
    return [...count].sort((a, b) => b[1].local - a[1].local || b[1].all - a[1].all)[0]?.[0] || '';
}

export function printSlips(title, slips) {
    const frame = document.createElement('iframe');
    frame.title = '密码条打印页';
    frame.style.cssText = 'position:fixed;width:1px;height:1px;border:0;left:-10px;top:0';
    document.body.append(frame);
    const doc = frame.contentDocument;
    doc.title = title + ' 密码条';
    const css = doc.createElement('style');
    css.textContent = '@page{size:A4;margin:10mm}*{box-sizing:border-box}body{margin:0;font:11pt/1.4 system-ui,sans-serif;color:#111;background:white}main{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}article{padding:4mm 5mm;border:0.2mm dashed #666;break-inside:avoid;overflow-wrap:anywhere}h2,p{margin:0 0 1mm}h2{font-size:14pt}code{font:600 14pt/1.3 monospace;white-space:pre-wrap}';
    doc.head.append(css);
    const main = doc.createElement('main');
    for (const { account, password, team } of slips) {
        const card = doc.createElement('article');
        const line = (tag, value) => { const element = doc.createElement(tag); element.textContent = value; card.append(element); };
        line('p', title); line('h2', team.name);
        line('p', [team.school, team.seat].filter(Boolean).join(' · '));
        line('p', `账号　${account}`);
        const pass = doc.createElement('p'), code = doc.createElement('code');
        code.textContent = password; pass.append('口令　', code); card.append(pass);
        main.append(card);
    }
    doc.body.append(main);
    const win = frame.contentWindow;
    win.addEventListener('afterprint', () => frame.remove(), { once: true });
    // Printing a child document avoids printing the account management page or persisting the CSV.
    try { win.focus(); win.print(); } catch (error) { frame.remove(); throw error; }
}
