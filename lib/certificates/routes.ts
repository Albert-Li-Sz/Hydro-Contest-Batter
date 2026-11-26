/**
 * 证书 pages in Hydro: the staff page (settings, 制证信息表, templates, issuing and downloads), the participants'
 * own certificates, and the public verification page behind each certificate's QR code (lib/certificates/service.ts).
 */
import {
    ContestModel, type Context, ForbiddenError, Handler, NotFoundError, ObjectId, param, PERM, PRIV, StorageService, SystemModel, type Tdoc, Types, ValidationError,
} from 'hydrooj';
import { resolverCodeBase } from '../resolver-data';
import type { SnapshotScope } from '../results-store';
import type { BoardSettings } from '../settings';
import { toScriptJson } from '../settings';
import { kindNames, placeholders } from './model';
import { CertificateError, certificateService, type CertificateFile, type CertificateRequest } from './service';
import pkg from '../../package.json';

const baseFor = (tdoc: Pick<Tdoc, 'domainId' | 'docId'>) => `/d/${encodeURIComponent(tdoc.domainId)}/contest/${tdoc.docId}`;
const scopeFor = (tdoc: Pick<Tdoc, 'domainId' | 'docId'>): SnapshotScope => ({ domainId: tdoc.domainId, contestId: String(tdoc.docId) });

/** The configured site address, or the address the request came to. */
export function siteUrl(headers: Record<string, string | string[] | undefined>) {
    const configured = SystemModel.get('server.url');
    if (typeof configured === 'string' && /^https?:\/\//.test(configured) && !/\/\/(localhost|127\.0\.0\.1)[:/]/.test(configured)) return configured.replace(/\/?$/, '/');
    const first = (value: string | string[] | undefined) => String(Array.isArray(value) ? value[0] : value || '').split(',')[0].trim();
    const host = first(headers['x-forwarded-host']) || first(headers.host);
    return host ? `${first(headers['x-forwarded-proto']) || 'http'}://${host}/` : '/';
}

export function applyCertificates(ctx: Context, dependencies: {
    loadSettings: (tdoc: Tdoc) => Promise<BoardSettings>;
    /** Saves the current results as a snapshot and returns its id (lib/results-routes.ts). */
    snapshot: (tdoc: Tdoc, label: string, operator: number) => Promise<string>;
}) {
    const contestOf = async (scope: SnapshotScope) => {
        const tdoc = await ContestModel.get(scope.domainId, new ObjectId(scope.contestId));
        if (!tdoc) throw new NotFoundError('比赛不存在');
        return tdoc;
    };
    const service = certificateService(ctx.db, {
        snapshot: async (scope, label, uid) => dependencies.snapshot(await contestOf(scope), label, uid),
        accounts: async (scope) => {
            const entries = await ContestModel.getMultiStatus(scope.domainId, { docId: new ObjectId(scope.contestId) })
                .project({ uid: 1, members: 1 }).toArray() as { uid: number; members?: number[] }[];
            return new Map(entries.map((entry) => [String(entry.uid), Array.isArray(entry.members) && entry.members.length ? entry.members : [entry.uid]]));
        },
        showIdentity: async (scope) => (await dependencies.loadSettings(await contestOf(scope))).showIdentity,
    });
    ctx.on('app/started', () => service.ensureIndexes().catch((error) => console.warn('[xcpcio] 证书索引创建失败', error)));

    const send = (handler: Handler, file: CertificateFile) => {
        handler.binary(file.data);
        handler.response.type = file.type;
        handler.response.addHeader('X-Content-Type-Options', 'nosniff');
        handler.response.disposition = `${file.inline ? 'inline' : 'attachment'}; filename="certificate"; filename*=UTF-8''${StorageService.encodeRFC5987ValueChars(file.name)}`;
    };
    const run = async <T>(work: () => Promise<T>) => {
        try { return await work(); } catch (error) {
            if (!(error instanceof CertificateError)) throw error;
            if (error.status === 404) throw new NotFoundError(error.message);
            if (error.status === 403) throw new ForbiddenError(error.message);
            throw new ValidationError(error.message);
        }
    };

    abstract class CertificateBase extends Handler {
        tdoc!: Tdoc;
        staff = true;

        @param('tid', Types.ObjectId)
        async prepare(_domainId: string, tid: ObjectId) {
            this.response.addHeader('Cache-Control', 'no-store');
            this.checkPriv(PRIV.PRIV_USER_PROFILE);
            const tdoc = await ContestModel.get(this.domain._id, tid);
            if (!tdoc || tdoc.rule !== 'acm') throw new NotFoundError('证书仅支持 ACM 比赛');
            this.tdoc = tdoc;
            if (this.staff && !this.user.own(tdoc)) this.checkPerm(PERM.PERM_EDIT_CONTEST);
        }

        get certificateRequest(): CertificateRequest {
            return { scope: scopeFor(this.tdoc), title: this.tdoc.title, uid: this.user._id, site: siteUrl(this.request.headers as Record<string, string>) };
        }
    }

    class CertificatesHandler extends CertificateBase {
        async get() {
            const base = `${baseFor(this.tdoc)}/certificates`;
            this.response.template = 'xcpcio_certificates.html';
            this.response.body = {
                tdoc: this.tdoc, codeBase: resolverCodeBase(pkg.version),
                runtimeJson: toScriptJson({ base, dataUrl: `${base}/data`, fileUrl: `${base}/file`, assetUrl: `${base}/asset`, resultsUrl: `${baseFor(this.tdoc)}/results`,
                    verifyBase: `/d/${encodeURIComponent(this.tdoc.domainId)}/certificate/`, mineUrl: `${base}/mine`, placeholders, kindNames }),
            };
        }

        async operate(operation: string, input = '{}') {
            await this.limitRate('xcpcio_certificates', 60, operation === 'issue' || operation === 'snapshot' ? 10 : 60);
            let payload: Record<string, unknown>;
            try { payload = JSON.parse(input) as Record<string, unknown>; } catch { throw new ValidationError('payload'); }
            this.response.body = await run(() => service.operate(this.certificateRequest, operation, payload));
        }

        @param('payload', Types.String, true)
        async postConfig(_domainId: string, input?: string) { await this.operate('config', input); }

        @param('payload', Types.String, true)
        async postTeam(_domainId: string, input?: string) { await this.operate('team', input); }

        @param('payload', Types.String, true)
        async postUpload(_domainId: string, input?: string) { await this.operate('upload', input); }

        @param('payload', Types.String, true)
        async postBackground(_domainId: string, input?: string) { await this.operate('background', input); }

        @param('payload', Types.String, true)
        async postLogo(_domainId: string, input?: string) { await this.operate('logo', input); }

        @param('payload', Types.String, true)
        async postDecoration(_domainId: string, input?: string) { await this.operate('decoration', input); }

        @param('payload', Types.String, true)
        async postSnapshot(_domainId: string, input?: string) { await this.operate('snapshot', input); }

        async postIssue() { await this.operate('issue'); }
    }

    class CertificatesDataHandler extends CertificateBase {
        async get() {
            this.response.type = 'application/json';
            this.response.body = await run(() => service.data(this.certificateRequest));
        }
    }

    class CertificatesFileHandler extends CertificateBase {
        @param('format', Types.String)
        @param('code', Types.String, true)
        @param('school', Types.String, true)
        @param('kind', Types.String, true)
        @param('template', Types.String, true)
        async get(_domainId: string, format: string, code = '', school = '', kind = '', template = '') {
            await this.limitRate('xcpcio_certificates_file', 60, 60);
            send(this, await run(() => service.file(this.certificateRequest, format, { code, school, kind, template })));
        }
    }

    class CertificateAssetHandler extends CertificateBase {
        @param('id', Types.String)
        async get(_domainId: string, id: string) {
            const image = await run(() => service.asset(scopeFor(this.tdoc), id));
            this.binary(image.data);
            this.response.type = image.type;
            this.response.addHeader('X-Content-Type-Options', 'nosniff');
        }
    }

    /** A participant's own certificates: the account must be the team or one of its members. */
    class CertificateMineHandler extends CertificateBase {
        staff = false;

        @param('code', Types.String, true)
        async get(_domainId: string, code = '') {
            const result = await run(() => service.mine(this.certificateRequest, code));
            if (result.file) { send(this, result.file); return; }
            this.response.template = 'xcpcio_certificate_mine.html';
            this.response.body = { tdoc: this.tdoc, codeBase: resolverCodeBase(pkg.version), base: `${baseFor(this.tdoc)}/certificates/mine`, certificates: result.list };
        }
    }

    /** Anyone holding a certificate may check it against the issuer's records. */
    class CertificateVerifyHandler extends Handler {
        noCheckPermView = true;

        @param('code', Types.String)
        async get(_domainId: string, code: string) {
            this.response.addHeader('Cache-Control', 'no-store');
            await this.limitRate('xcpcio_certificate_verify', 60, 60);
            this.response.template = 'xcpcio_certificate_verify.html';
            this.response.body = { codeBase: resolverCodeBase(pkg.version), ...await service.verify(this.domain._id, code) };
        }
    }

    ctx.on('handler/after', async (handler) => {
        if (handler.response.template !== 'contest_detail.html' || !handler.user._id) return;
        const tdoc = handler.response.body?.tdoc;
        if (tdoc?.rule !== 'acm') return;
        const own = await ctx.db.collection('xcpcio.certificates.issued').findOne({
            ...scopeFor(tdoc), uids: handler.user._id, status: 'valid',
        }, { projection: { _id: 1 } });
        if (own) handler.UiContext.xcpcioMyCertificates = `${baseFor(tdoc)}/certificates/mine`;
    });

    ctx.Route('contest_xcpcio_certificates', '/contest/:tid/certificates', CertificatesHandler);
    ctx.Route('contest_xcpcio_certificates_data', '/contest/:tid/certificates/data', CertificatesDataHandler);
    ctx.Route('contest_xcpcio_certificates_file', '/contest/:tid/certificates/file/:format', CertificatesFileHandler);
    ctx.Route('contest_xcpcio_certificates_asset', '/contest/:tid/certificates/asset/:id', CertificateAssetHandler);
    ctx.Route('contest_xcpcio_certificates_mine', '/contest/:tid/certificates/mine', CertificateMineHandler);
    ctx.Route('xcpcio_certificate_verify', '/certificate/:code', CertificateVerifyHandler);
    ctx.i18n.load('zh', { contest_xcpcio_certificates: '证书', contest_xcpcio_certificates_mine: '我的证书', xcpcio_certificate_verify: '证书核验' });
}
