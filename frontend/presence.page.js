import { addPage, AutoloadPage } from '@hydrooj/ui-default';
import { installPresence } from './presence';

// 机位监控: contest pages of a participant (lib/presence-routes.ts sets UiContext.xcpcioPresence).
let cleanup;
addPage(new AutoloadPage('xcpcioPresence', () => {
    cleanup?.();
    cleanup = undefined;
    const info = window.UiContext?.xcpcioPresence;
    if (info && typeof info.url === 'string') cleanup = installPresence(info);
}));
