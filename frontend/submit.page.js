import { addPage, NamedPage } from '@hydrooj/ui-default';

addPage(new NamedPage('contest_problemlist', () => {
    const url = window.UiContext?.xcpcioSubmitClient;
    if (!url || document.getElementById('xcpcio-submit-entry')) return;
    const menu = document.querySelector('.section.side a[href$="/problems"]')?.closest('ul');
    const target = menu || document.querySelector('.section__body');
    if (!target) return;
    const entry = document.createElement(menu ? 'li' : 'p');
    entry.id = 'xcpcio-submit-entry';
    if (menu) entry.className = 'menu__item';
    const link = document.createElement('a');
    if (menu) link.className = 'menu__link';
    link.href = url;
    link.textContent = '选手命令行 submit';
    entry.append(link);
    target.append(entry);
}));
