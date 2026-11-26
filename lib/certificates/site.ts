/** Where certificate verification links point. Pure: lib/certificates/routes.ts passes Hydro's settings. */
const loopbackHost = (host: string) => /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i.test(host);

/**
 * The configured site address, or the address the request came to. Hosts are read as Hydro reads them
 * (the `server.xhost` header when set), then a proxy's X-Forwarded-Host, then Host; a loopback address
 * (a proxy that does not pass the original host) is used only when nothing else is known, since it is
 * printed on certificates as their verification link.
 */
export function siteFrom(headers: Record<string, string | string[] | undefined>, system: { url?: unknown; xhost?: unknown }) {
    const configured = system.url;
    if (typeof configured === 'string' && /^https?:\/\//.test(configured) && !/\/\/(localhost|127\.0\.0\.1)[:/]/.test(configured)) return configured.replace(/\/?$/, '/');
    const first = (value: string | string[] | undefined) => String(Array.isArray(value) ? value[0] : value || '').split(',')[0].trim();
    const { xhost } = system;
    const candidates = [typeof xhost === 'string' && xhost ? headers[xhost.toLowerCase()] : undefined, headers['x-forwarded-host'], headers.host]
        .map(first).filter((host) => /^(?:[a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\])(?::\d{1,5})?$/.test(host));
    const host = candidates.find((item) => !loopbackHost(item)) || candidates[0] || '';
    const rawProto = first(headers['x-forwarded-proto']).toLowerCase();
    const proto = rawProto === 'https' || rawProto === 'http' ? rawProto : 'http';
    return host ? `${proto}://${host}/` : '/';
}
