import { addPage, AutoloadPage } from '@hydrooj/ui-default';

// 选手视角 (lib/perspective.ts sets UiContext.xcpcioPerspective while a manager views a contest as a team).
addPage(new AutoloadPage('xcpcioPerspective', () => {
    const info = window.UiContext?.xcpcioPerspective;
    if (!info || document.getElementById('xcpcio-perspective')) return;
    const bar = document.createElement('div');
    bar.id = 'xcpcio-perspective';
    bar.setAttribute('role', 'status');
    bar.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:1000;display:flex;align-items:center;gap:10px;padding:8px 10px 8px 14px;'
        + 'border-radius:6px;background:#3b7fc4;color:#fff;font:14px/1.4 system-ui,sans-serif;box-shadow:0 4px 16px #0004';
    const label = document.createElement('span');
    label.textContent = `选手视角 · ${info.name}`;
    const back = document.createElement('button');
    back.type = 'button';
    back.textContent = '返回管理视角';
    back.style.cssText = 'border:1px solid #fff8;border-radius:4px;background:#fff2;color:#fff;padding:3px 10px;font:inherit;cursor:pointer';
    back.onclick = async () => {
        back.disabled = true;
        try { await fetch(info.exit, { method: 'POST', headers: { Accept: 'application/json' } }); } finally { location.href = info.back; }
    };
    bar.append(label, back);
    document.body.append(bar);
}));
