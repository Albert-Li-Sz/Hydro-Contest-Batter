import { BLACK, WHITE, isInkColor } from './certificate-colors.js';
import { el } from './hydro-manage-common.js';

const swatches = [
    ['纯黑', BLACK], ['纯白', WHITE], ['纯红', '#ff0000'], ['纯绿', '#00ff00'], ['纯蓝', '#0000ff'],
    ['纯黄', '#ffff00'], ['青色', '#00ffff'], ['品红', '#ff00ff'],
];

export function inkPicker(label, initial, onChange) {
    let current = isInkColor(initial) ? initial.toLowerCase() : BLACK;
    const message = el('small', { class: 'manage-error', role: 'status', hidden: true });
    const picker = el('input', { type: 'color', value: current, 'aria-label': label,
        oninput: () => select(picker.value) });
    const hex = el('input', { type: 'text', class: 'textbox', value: current.toUpperCase(), 'aria-label': label + '色值',
        maxlength: 7, spellcheck: 'false', autocomplete: 'off', placeholder: '#RRGGBB',
        oninput: () => {
            const raw = hex.value.trim();
            const value = raw.startsWith('#') ? raw : '#' + raw;
            if (isInkColor(value)) select(value);
        },
        onblur: () => {
            if (hex.value !== current.toUpperCase()) {
                message.textContent = '请输入六位色值，当前使用 ' + current.toUpperCase();
                message.hidden = false;
                hex.value = current.toUpperCase();
            }
        } });
    const buttons = swatches.map(([name, value]) => el('button', { type: 'button', class: 'certificate-swatch',
        title: name + ' ' + value.toUpperCase(), 'aria-label': name, 'aria-pressed': String(value === current),
        style: 'background-color:' + value, onclick: () => select(value) }));
    function select(value) {
        current = value.toLowerCase();
        message.hidden = true;
        picker.value = current;
        hex.value = current.toUpperCase();
        buttons.forEach((button, i) => button.setAttribute('aria-pressed', String(swatches[i][1] === current)));
        onChange(current);
    }
    return el('fieldset', { class: 'certificate-color-picker' }, el('legend', { text: label }),
        el('div', { class: 'certificate-color-values' }, picker, hex), el('div', { class: 'certificate-swatches' }, ...buttons), message);
}
