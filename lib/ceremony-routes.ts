import fs from 'node:fs';
import path from 'node:path';
import { ContestModel, Context, Handler, NotFoundError, ObjectId, param, PERM, PRIV, Tdoc, Types, ValidationError } from 'hydrooj';
import { ceremonyConfig, ceremonyDefaults, ceremonySlides, ceremonyThemes, type CeremonyConfig } from './ceremony-slides';
import { ceremonyKey, ceremonyPptx, parseCeremonyLayout, pptxType } from './ceremony-pptx';
import type { ResultsData } from './results';
import type { ResultOption } from './results-page';
import { decodePoster, imageBytes } from './screens-data';
import { resolverCodeBase } from './resolver-data';
import { toScriptJson } from './settings';
import pkg from '../package.json';

interface CeremonyDoc { _id: string; config?: CeremonyConfig; background?: { data: Buffer; mime: string }; backgroundAt?: number }
declare module 'hydrooj' { interface Collections { 'xcpcio.ceremony': CeremonyDoc } }

export function applyCeremony(ctx: Context, results: { readSource(tdoc: Tdoc, id: string): Promise<ResultsData>; sources(tdoc: Tdoc): Promise<ResultOption[]> }) {
    const collection = ctx.db.collection('xcpcio.ceremony');
    const logos = JSON.parse(fs.readFileSync(path.join(__dirname, '../logos/index.json'), 'utf8')).names;
    ctx.on('contest/del', (domain, tid) => { void collection.deleteOne({ _id: `${domain}/${tid}` }).catch(() => null); });
    ctx.on('domain/delete', domain => { void collection.deleteMany({ _id: new RegExp('^' + domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/') }).catch(() => null); });
    function readConfig(raw: string) {
        try { return ceremonyConfig(JSON.parse(raw)); } catch { throw new ValidationError('config', '幻灯片设置无效'); }
    }
    class CeremonyAccess extends Handler {
        tdoc!: Tdoc;
        key!: string;
        @param('tid', Types.ObjectId)
        async prepare(_domain: string, tid: ObjectId) {
            this.response.addHeader('Cache-Control', 'no-store');
            this.checkPriv(PRIV.PRIV_USER_PROFILE);
            const contest = await ContestModel.get(this.domain._id, tid);
            if (!contest || contest.rule !== 'acm') throw new NotFoundError('比赛不存在');
            if (!this.user.own(contest)) this.checkPerm(PERM.PERM_EDIT_CONTEST);
            this.tdoc = contest;
            this.key = `${contest.domainId}/${tid}`;
        }
    }
    class CeremonyHandler extends CeremonyAccess {
        @param('source', Types.String, true)
        async get(_domain: string, source?: string) {
            const saved = await collection.findOne({ _id: this.key }, { projection: { background: 0 } });
            const config = ceremonyConfig(saved?.config ?? ceremonyDefaults);
            if (source) config.source = source;
            const base = `/d/${encodeURIComponent(this.tdoc.domainId)}/contest/${this.tdoc.docId}/ceremony`;
            const sources = await results.sources(this.tdoc);
            this.response.template = 'xcpcio_ceremony.html';
            this.response.body = { tdoc: this.tdoc, codeBase: resolverCodeBase(pkg.version), runtimeJson: toScriptJson({
                base, config, sources, themes: ceremonyThemes, background: saved?.backgroundAt ? `${base}/background?v=${saved.backgroundAt}` : '',
            }) };
        }
        @param('config', Types.String)
        @param('save', (v: unknown) => Types.Boolean[0](v), true)
        async post(_domain: string, raw: string, save = false) {
            const config = readConfig(raw);
            const deck = ceremonySlides(await results.readSource(this.tdoc, config.source), config, logos);
            if (save) await collection.updateOne({ _id: this.key }, { $set: { config } }, { upsert: true });
            this.response.body = { ...deck, key: ceremonyKey(deck) };
        }
    }
    class PptxHandler extends CeremonyAccess {
        @param('config', Types.String)
        @param('layout', Types.String)
        @param('fallback', Types.String, true)
        async post(_domain: string, raw: string, layout: string, fallback?: string) {
            const config = readConfig(raw);
            const [source, doc] = await Promise.all([results.readSource(this.tdoc, config.source), collection.findOne({ _id: this.key })]);
            const deck = ceremonySlides(source, config, logos);
            let measured;
            try { measured = parseCeremonyLayout(layout, deck, doc?.backgroundAt || 0); }
            catch (error) { throw new ValidationError('layout', (error as Error).message); }
            let bg = doc?.background && { data: imageBytes(doc.background.data), mime: doc.background.mime };
            if (bg?.mime === 'image/webp' && fallback) {
                try { bg = decodePoster(fallback, 6 * 1024 ** 2); } catch { throw new ValidationError('fallback', '背景图片无效'); }
            }
            this.binary(await ceremonyPptx(deck, config, measured, bg));
            this.response.type = pptxType;
            this.response.disposition = 'attachment; filename="awards.pptx"';
        }
    }
    class BackgroundHandler extends CeremonyAccess {
        async get() {
            const doc = await collection.findOne({ _id: this.key });
            if (!doc?.background) throw new NotFoundError('未设置背景');
            this.response.type = doc.background.mime;
            this.response.body = imageBytes(doc.background.data);
        }
        @param('image', Types.String, true)
        async post(_domain: string, image = '') {
            const at = Date.now();
            if (image) {
                let background;
                try { background = decodePoster(image, 6 * 1024 ** 2); } catch (error) { throw new ValidationError('image', (error as Error).message); }
                await collection.updateOne({ _id: this.key }, { $set: { background, backgroundAt: at } }, { upsert: true });
            } else await collection.updateOne({ _id: this.key }, { $unset: { background: '', backgroundAt: '' } });
            this.response.body = { at: image ? at : null };
        }
    }
    ctx.Route('contest_xcpcio_ceremony', '/contest/:tid/ceremony', CeremonyHandler);
    ctx.Route('contest_xcpcio_ceremony_pptx', '/contest/:tid/ceremony/pptx', PptxHandler);
    ctx.Route('contest_xcpcio_ceremony_background', '/contest/:tid/ceremony/background', BackgroundHandler);
}
