// Short explanations stay attached to the control that needs them, including inside modal dialogs.
let active;
let bubble;
let hideTimer;
function closeHelp() {
    clearTimeout(hideTimer);
    if (active) active.removeAttribute('aria-describedby');
    bubble?.remove();
    active = bubble = null;
}
function positionHelp() {
    if (!active?.isConnected) { closeHelp(); return; }
    const anchor = active.getBoundingClientRect();
    const rect = bubble.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchor.left + (anchor.width - rect.width) / 2, document.documentElement.clientWidth - rect.width - 8));
    const top = anchor.top >= rect.height + 10 ? anchor.top - rect.height - 6 : Math.min(anchor.bottom + 6, innerHeight - rect.height - 6);
    Object.assign(bubble.style, { left: left + 'px', top: Math.max(4, top) + 'px' });
}
function openHelp(trigger) {
    clearTimeout(hideTimer);
    if (active === trigger) return;
    closeHelp();
    active = trigger;
    bubble = document.createElement('div');
    bubble.id = 'xcpcio-help-text';
    bubble.className = 'xc-help-text';
    bubble.setAttribute('role', 'tooltip');
    bubble.textContent = trigger.dataset.help;
    trigger.setAttribute('aria-describedby', bubble.id);
    (trigger.closest('dialog[open]') || document.body).append(bubble);
    positionHelp();
}
function triggerOf(target) { return target instanceof Element && target.closest('button[data-help]'); }
document.addEventListener('pointerover', (event) => {
    const trigger = triggerOf(event.target);
    if (trigger && event.pointerType !== 'touch') openHelp(trigger);
    else if (bubble?.contains(event.target)) clearTimeout(hideTimer);
});
document.addEventListener('pointerout', (event) => {
    if (active && (active.contains(event.target) || bubble.contains(event.target)) && !active.contains(document.activeElement)) {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(closeHelp, 160);
    }
});
document.addEventListener('focusin', (event) => {
    const trigger = triggerOf(event.target);
    if (trigger) openHelp(trigger);
    else closeHelp();
});
document.addEventListener('focusout', (event) => {
    if (active?.contains(event.target) && !active.contains(event.relatedTarget)) closeHelp();
});
document.addEventListener('click', (event) => {
    const trigger = triggerOf(event.target);
    if (trigger) openHelp(trigger);
    else if (!bubble?.contains(event.target)) closeHelp();
});
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && active) { event.preventDefault(); event.stopPropagation(); closeHelp(); }
}, true);
addEventListener('resize', () => { if (active) positionHelp(); });
document.addEventListener('scroll', () => { if (active) positionHelp(); }, true);
export function helpTip(label, message) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'xc-help';
    button.dataset.help = message;
    button.setAttribute('aria-label', label + '帮助');
    button.textContent = '?';
    return button;
}

// pct is the reported percentage. Capacity can legitimately exceed 100 percent.
const percentFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });
export function ratioMeter(label, pct, { shape = 'bar', tone = '', caption } = {}) {
    const element = document.createElement('span');
    element.className = 'xc-meter xc-meter--' + shape;
    const known = Number.isFinite(pct);
    const number = known ? percentFormat.format(pct) + '%' : '—';
    const detail = label + '，' + (known ? number : '暂无数据');
    element.setAttribute('role', 'img');
    element.setAttribute('aria-label', detail);
    element.title = detail;
    if (!known) element.classList.add('xc-meter--unknown');
    if (tone) element.classList.add('xc-meter--' + tone);
    element.style.setProperty('--xc-fill', (known ? Math.max(0, Math.min(100, pct)) : 0) + '%');
    const mark = document.createElement('i');
    const value = document.createElement('span');
    value.textContent = caption ?? number;
    element.append(mark, value);
    return element;
}
