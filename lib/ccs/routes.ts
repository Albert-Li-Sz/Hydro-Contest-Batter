/** Production entry point: bind the CCS implementation to the installed Hydro host. */
import * as Hydro from 'hydrooj';
import type { Context } from 'hydrooj';
import type { SourceDependencies } from './source';
import type { HostLookup, WebhookPost } from './ssrf';
import { applyCcsApi } from './service';
export function applyCcs(ctx: Context, dependencies: SourceDependencies & { webhookLookup?: HostLookup; webhookPost?: WebhookPost }) {
    return applyCcsApi(Hydro, ctx, dependencies);
}
