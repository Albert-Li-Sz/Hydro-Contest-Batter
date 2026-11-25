import { addPage, AutoloadPage } from '@hydrooj/ui-default';
import { installResolverEntry } from './resolver-entry';

let cleanup;
addPage(new AutoloadPage('xcpcioResolver', () => {
    cleanup?.();
    cleanup = undefined;
    document.getElementById('xcpcio-certificate-entry')?.remove();
    const mine = window.UiContext?.xcpcioMyCertificates;
    if (typeof mine === 'string') {
        const anchor = document.querySelector('.section.side a[href$="/problems"]')?.closest('li');
        if (anchor) {
            const entry = document.createElement('li');
            entry.id = 'xcpcio-certificate-entry';
            entry.className = 'menu__item';
            const link = document.createElement('a');
            link.className = 'menu__link';
            link.href = mine;
            const icon = document.createElement('span');
            icon.className = 'icon icon-award';
            icon.setAttribute('aria-hidden', 'true');
            link.append(icon, ' 我的证书');
            entry.append(link);
            anchor.after(entry);
        }
    }
    const url = window.UiContext?.xcpcioResolverUrl;
    if (typeof url === 'string') cleanup = installResolverEntry(url, { live: window.UiContext?.xcpcioLiveEnabled === true, capture: window.UiContext?.xcpcioCaptureEnabled === true });
}));
