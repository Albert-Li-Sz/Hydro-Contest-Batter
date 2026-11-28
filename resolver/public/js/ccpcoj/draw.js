// Canvas 2D drawing primitives shared by the CCPCOJ-style resolver themes. Every function
// paints in logical pixels: the stage is 1080 high and L.width wide.
export const HEIGHT = 1080;
export const sans = '"Contest Noto Sans SC", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", system-ui, sans-serif';
/** Figures on a scoreboard: fixed-width digits so columns of minutes and ranks line up. */
export const mono = '"JetBrains Mono", "SF Mono", "SFMono-Regular", Menlo, Consolas, "Roboto Mono", "DejaVu Sans Mono", monospace';
export const unit = x => Math.max(0, Math.min(1, x));

export function teamName(team) {
    const name = team?.name || team?.displayName || '—';
    const school = team?.organizationName;
    if (school) {
        for (const suffix of ['（' + school + '）', ' (' + school + ')']) {
            if (name.endsWith(suffix) && name.length > suffix.length) return name.slice(0, -suffix.length).trim();
        }
    }
    return name;
}

/**
 * One line of text within `width`. A long line is narrowed horizontally (as a condensed face
 * would be) down to `squeeze` of its width, then cut with an ellipsis.
 */
export function text(ctx, value, x, y, width, size, {
    color = '#212529', align = 'left', weight = 700, squeeze = .62, family = sans,
} = {}) {
    if (value == null || value === '' || width <= 0) return;
    let label = String(value);
    ctx.font = weight + ' ' + size + 'px ' + family;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    const natural = ctx.measureText(label).width;
    const ratio = natural > width ? Math.max(squeeze, width / natural) : 1;
    if (natural * ratio > width) {
        const chars = Array.from(label);
        let lo = 0, hi = chars.length;
        while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            if (ctx.measureText(chars.slice(0, mid).join('') + '…').width * ratio <= width) lo = mid;
            else hi = mid - 1;
        }
        label = chars.slice(0, lo).join('') + '…';
    }
    if (ratio === 1) {
        ctx.textAlign = align;
        ctx.fillText(label, x, y);
        return;
    }
    const w = ctx.measureText(label).width * ratio;
    const left = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    ctx.save();
    ctx.translate(left, y);
    ctx.scale(ratio, 1);
    ctx.textAlign = 'left';
    ctx.fillText(label, 0, 0);
    ctx.restore();
}

export function path(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

export function box(ctx, fill, x, y, w, h, r = 0) {
    ctx.fillStyle = fill;
    if (!r) { ctx.fillRect(x, y, w, h); return; }
    path(ctx, x, y, w, h, r);
    ctx.fill();
}

export function stroke(ctx, color, x, y, w, h, r, width, dash = null) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    if (dash) ctx.setLineDash(dash);
    path(ctx, x + width / 2, y + width / 2, w - width, h - width, r);
    ctx.stroke();
    ctx.restore();
}

export function cropImage(ctx, img, x, y, w, h, cover, radius = 0) {
    if (!img?.naturalWidth || !img.naturalHeight) return false;
    const fit = cover ? Math.max : Math.min;
    const ratio = fit(w / img.naturalWidth, h / img.naturalHeight);
    const iw = img.naturalWidth * ratio, ih = img.naturalHeight * ratio;
    ctx.save();
    path(ctx, x, y, w, h, radius);
    ctx.clip();
    ctx.drawImage(img, x + (w - iw) / 2, y + (h - ih) / 2, iw, ih);
    ctx.restore();
    return true;
}

export function hash(value) {
    let h = 2166136261;
    for (const ch of String(value || '')) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
    return h >>> 0;
}

/** A symmetric 5×5 mark coloured from the school name, standing in for a missing logo. */
export function identicon(ctx, seed, x, y, size) {
    const h = hash(seed);
    ctx.fillStyle = 'hsl(' + (h % 360) + ', 52%, 46%)';
    const cell = size / 6, pad = (size - cell * 5) / 2;
    for (let row = 0; row < 5; row++) {
        for (let col = 0; col < 3; col++) {
            if (!((h >>> (row * 3 + col)) & 1)) continue;
            for (const c of col === 2 ? [2] : [col, 4 - col]) ctx.fillRect(x + pad + c * cell, y + pad + row * cell, cell + .5, cell + .5);
        }
    }
}

/** A rosette with two ribbon tails, the award mark behind ranks in a medal zone. */
export function rosette(ctx, cx, cy, size, fill, edge, alpha) {
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.fillStyle = fill;
    ctx.strokeStyle = edge;
    ctx.lineWidth = Math.max(1, size * .03);
    const r = size * .34, top = cy - size * .08;
    for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(cx + side * r * .25, top + r * .55);
        ctx.lineTo(cx + side * r * .95, top + r * 1.75);
        ctx.lineTo(cx + side * r * .55, top + r * 1.55);
        ctx.lineTo(cx + side * r * .35, top + r * 1.95);
        ctx.lineTo(cx, top + r * .8);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
    }
    ctx.beginPath();
    for (let i = 0; i <= 32; i++) {
        const a = i / 32 * Math.PI * 2, rr = r * (i % 2 ? .86 : 1);
        ctx.lineTo(cx + Math.cos(a) * rr, top + Math.sin(a) * rr);
    }
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.restore();
}

export function balloon(ctx, cx, cy, size, color) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.ellipse(cx, cy - size * .12, size * .3, size * .36, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = Math.max(1, size * .06);
    ctx.beginPath();
    ctx.moveTo(cx, cy + size * .24);
    ctx.quadraticCurveTo(cx + size * .1, cy + size * .36, cx - size * .02, cy + size * .48);
    ctx.stroke();
    ctx.restore();
}

export function star(ctx, cx, cy, size, color) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + i * Math.PI / 5, r = size * (i % 2 ? .2 : .46);
        ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
}

