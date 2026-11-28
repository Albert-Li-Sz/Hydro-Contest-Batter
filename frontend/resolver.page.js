import { addPage, AutoloadPage } from '@hydrooj/ui-default';
import { installResolverEntry } from './resolver-entry';

let cleanup;
addPage(new AutoloadPage('xcpcioResolver', () => {
    cleanup?.();
    cleanup = undefined;
    const url = window.UiContext?.xcpcioResolverUrl;
    if (typeof url === 'string') cleanup = installResolverEntry(url, { live: window.UiContext?.xcpcioLiveEnabled === true, capture: window.UiContext?.xcpcioCaptureEnabled === true });
}));
