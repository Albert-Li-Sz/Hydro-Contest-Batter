export function clarificationIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '1em');
    svg.setAttribute('height', '1em');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.verticalAlign = '-0.12em';
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('fill-rule', 'evenodd');
    path.setAttribute('d', 'M4 3h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H9l-5.3 3.5A1 1 0 0 1 2 21.7V5a2 2 0 0 1 2-2Zm0 2v14.8L8.4 17H20V5H4Zm3 3h10v2H7Zm0 4h7v2H7Z');
    svg.append(path);
    return svg;
}
