import { type Context, type Handler, UserModel } from 'hydrooj';
import { IP_LOGIN, type IpLoginDoc, normalizeIp } from './onsite';

const loginFields = ['ipLoggedIn', 'uid', 'user'] as const;
type LoginSession = Partial<Record<typeof loginFields[number], unknown>>;

/** Reconcile onsite-toolkit's process-local cached login with the current Mongo mapping. */
export function applyIpLoginGuard(ctx: Context) {
    const ipLogins = ctx.db.collection(IP_LOGIN as never);
    const initialSessions = new WeakMap<object, LoginSession>();

    ctx.on('handler/create', (handler, transport) => {
        if (transport !== 'http') return;
        const initial: LoginSession = {};
        for (const field of loginFields) {
            if (Object.hasOwn(handler.session, field)) initial[field] = handler.session[field];
        }
        initialSessions.set(handler, initial);
    });

    ctx.on('handler/before-prepare', async (handler: Handler) => {
        if ((handler as { xcpcioPerspective?: unknown }).xcpcioPerspective) return;
        const initial = initialSessions.get(handler);
        const { session } = handler;
        if (!initial || !Object.hasOwn(session, 'ipLoggedIn') || typeof session.ipLoggedIn !== 'string') return;
        const ip = normalizeIp(handler.request.ip);
        if (normalizeIp(session.ipLoggedIn) !== ip) return;
        const mapping = await ipLogins.findOne<IpLoginDoc>({ _id: ip } as never, { projection: { uid: 1 } });
        if (mapping?.uid === handler.user._id) return;

        const originalUser = handler.context.HydroContext.user as Handler['user'];
        // A reassigned address switches to its new holder even while the old entry is cached.
        const user = mapping && await UserModel.getById(handler.domain._id, mapping.uid);
        if (user) {
            handler.user = user;
            session.uid = user._id;
            session.user = user;
            // Hydro has already checked route permissions for the incoming session. Let those
            // checks run again with the new identity before serving the route or accepting a POST.
            if (originalUser._id !== user._id) {
                if (handler.request.method === 'get' && !handler.request.json) {
                    const path = handler.context.originalPath || handler.request.path;
                    handler.response.redirect = `/${path.replace(/^[/\\]+/, '')}${handler.context.search || ''}`;
                } else {
                    handler.response.status = 409;
                    handler.response.body = { error: { message: handler.translate('IP login changed. Please try again.') } };
                }
                return 'cleanup';
            }
            return;
        }

        // Undo only the automatic login. A session that already existed remains valid unless
        // the administrator selected logout, which removes that session token from MongoDB.
        handler.user = originalUser;
        for (const field of loginFields) {
            if (Object.hasOwn(initial, field)) session[field] = initial[field];
            else delete session[field];
        }
    });
    ctx.i18n.load('zh', { 'IP login changed. Please try again.': 'IP 登录账号已变更，请重试。' });
}
