import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { writeZip, type ZipEntry } from './ccs/zip';
import type { CeremonyConfig, ceremonySlides, CeremonyTier } from './ceremony-slides';

type Deck = ReturnType<typeof ceremonySlides>;
type Box = [number, number, number, number, number]; // x, y, width, height, font size in reference pixels
interface Fit { cols: number; size: number; wrap: boolean; slots: Record<string, Box> }
interface ExportLayout { key: string; layouts: Fit[]; ink: string; timeZone: string; backgroundAt: number; backgroundAspect: number }
interface Image { mime: string; data: Buffer }

export const pptxType = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
export function ceremonyKey(deck: Deck) {
    return createHash('sha256').update(JSON.stringify(deck)).digest('hex');
}

export function parseCeremonyLayout(raw: string, deck: Deck, backgroundAt: number) {
    const value: ExportLayout = JSON.parse(raw);
    if (!value || value.key !== ceremonyKey(deck) || value.backgroundAt !== backgroundAt) throw new Error('成绩或背景已更新，请重新预览后导出');
    if (!deck.slides.length) throw new Error('所选榜单暂无可导出的幻灯片');
    if (!Array.isArray(value.layouts) || value.layouts.length !== deck.slides.length
        || !Number.isFinite(value.backgroundAspect) || value.backgroundAspect <= 0 || typeof value.timeZone !== 'string') throw new Error('幻灯片排版数据无效');
    new Intl.DateTimeFormat('zh-CN', { timeZone: value.timeZone });
    for (const [index, fit] of value.layouts.entries()) {
        if (!fit || !Number.isInteger(fit.cols) || fit.cols < 1 || fit.cols > 4 || !Number.isFinite(fit.size) || fit.size < 0.69 || fit.size > 4.21
            || typeof fit.wrap !== 'boolean' || !fit.slots || Array.isArray(fit.slots) || typeof fit.slots !== 'object'
            || !Object.values(fit.slots).every(b => Array.isArray(b) && b.length === 5 && b.every(v => Number.isFinite(v) && Math.abs(v) <= 10000)
                && b[2] >= 0 && b[3] >= 0 && b[4] > 0 && b[4] <= 512)) throw new Error('幻灯片排版数据无效');
        const page = deck.slides[index];
        const required = page.kind === 'cover' ? ['cover', 'ceremony'] : ['award', ...page.teams.flatMap((_, i) => ['rank' + i, 'name' + i])];
        if (required.some(key => !Object.hasOwn(fit.slots, key))) throw new Error('幻灯片排版数据不完整');
    }
    return value;
}

const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const drawing = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const presentation = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const ns = `xmlns:p="${presentation}" xmlns:a="${drawing}" xmlns:r="${office}"`;
const escape = (s: string) => s.replace(/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const emu = (px: number) => Math.round(px * 9525);
const transform = ([x, y, w, h]: Box) => `<a:xfrm><a:off x="${emu(x)}" y="${emu(y)}"/><a:ext cx="${emu(w)}" cy="${emu(h)}"/></a:xfrm>`;
const shapeGeometry = (shape: string) => `<a:prstGeom prst="${shape}"><a:avLst/></a:prstGeom>`;
const fill = (color: string, alpha = 100000) => `<a:solidFill><a:srgbClr val="${color}">${alpha === 100000 ? '' : `<a:alpha val="${alpha}"/>`}</a:srgbClr></a:solidFill>`;
const group = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
const colors = ['dk1','lt1','dk2','lt2','accent1','accent2','accent3','accent4','accent5','accent6','hlink','folHlink'];
const values = ['111111','FFFFFF','152A5E','FBF6EA','E7C47C','8FDCF0','BFE9D3','D3CBFF','F4CF7C','5CC5AF','0563C1','954F72'];
const colorMap = '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" ' + colors.slice(4).map(c => `${c}="${c}"`).join(' ') + '/>';
const mapOverride = '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>';
const phFill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
const font = '<a:latin typeface="Arial"/><a:ea typeface="Microsoft YaHei"/><a:cs typeface="Arial"/>';
const theme = `<a:theme xmlns:a="${drawing}" name="颁奖典礼"><a:themeElements><a:clrScheme name="颁奖">${colors.map((c, i) => `<a:${c}><a:srgbClr val="${values[i]}"/></a:${c}>`).join('')}</a:clrScheme><a:fontScheme name="颁奖字体"><a:majorFont>${font}</a:majorFont><a:minorFont>${font}</a:minorFont></a:fontScheme><a:fmtScheme name="颁奖"><a:fillStyleLst>${phFill.repeat(3)}</a:fillStyleLst><a:lnStyleLst>${[9525,19050,28575].map(w => `<a:ln w="${w}">${phFill}<a:prstDash val="solid"/></a:ln>`).join('')}</a:lnStyleLst><a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst><a:bgFillStyleLst>${phFill.repeat(3)}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;
const common = `<p:cSld><p:spTree>${group}</p:spTree></p:cSld>`;
const master = `<p:sldMaster ${ns}>${common}${colorMap}<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`;
const layoutPart = `<p:sldLayout ${ns} type="blank" preserve="1">${common}${mapOverride}</p:sldLayout>`;
const rels = (links: [string, string][]) => '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    links.map(([type, target], i) => `<Relationship Id="rId${i + 1}" Type="${office}/${type}" Target="${target}"/>`).join('') + '</Relationships>';

// Flatten the slide CSS theme gradients to their base and use the same heading, plaque and panel colours.
const palettes: Record<CeremonyConfig['theme'], [string, string, string, string, string]> = {
    gala: ['0E1A3D','FBF6EA','E7C47C','2B1C03','070D22'], red: ['6B141E','FFF5DF','F4CF7C','3A1D00','30060C'],
    blue: ['0C3557','EEFAFF','8FDCF0','032434','031628'], celadon: ['0F3F39','F1FBF6','BFE9D3','0B2D24','06221E'],
    night: ['1A1240','F4F1FF','D3CBFF','1B1240','0A0620'], ink: ['111111','F7F2E6','D4AF37','1A1300','242424'],
    light: ['F6F0E2','2A241C','9B742F','FFF8EA','FFFFFF'], mist: ['E8EEF5','1B2A3C','3A6EA8','FFFFFF','FFFFFF'],
};
const plaques: Partial<Record<CeremonyTier, [string, string]>> = { gold: ['DCAE48','3B2603'], silver: ['C3CCD7','1D2632'],
    bronze: ['C98B5A','2E1607'], trophy: ['E3A62C','2C1800'], first: ['5CC5AF','052A23'] };
const whole: Box = [0, 0, 1280, 720, 16];

class Slide {
    shapes: string[] = [];
    links: [string, string][] = [['slideLayout', '../slideLayouts/slideLayout1.xml']];
    private refs = new Map<string, number>();
    private nextId = 2;

    shape(name: string, box: Box | undefined, geometry: string, paint: string, line = '<a:ln><a:noFill/></a:ln>') {
        if (!box) return;
        this.shapes.push(`<p:sp><p:nvSpPr><p:cNvPr id="${this.nextId++}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${transform(box)}${shapeGeometry(geometry)}${paint}${line}</p:spPr></p:sp>`);
    }
    text(name: string, value: string, box: Box | undefined, color: string, align = 'l', bold = false, wrap = false) {
        if (!box || !value) return;
        const size = Math.round(box[4] * 75);
        const paragraphs = value.split(/\r\n|\r|\n/).map(line => `<a:p><a:pPr algn="${align}"/><a:r><a:rPr lang="zh-CN" sz="${size}" b="${bold ? 1 : 0}">${fill(color)}${font}</a:rPr><a:t xml:space="preserve">${escape(line)}</a:t></a:r><a:endParaRPr lang="zh-CN" sz="${size}"/></a:p>`).join('');
        this.shapes.push(`<p:sp><p:nvSpPr><p:cNvPr id="${this.nextId++}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${transform(box)}${shapeGeometry('rect')}<a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="${wrap ? 'square' : 'none'}" lIns="0" rIns="0" tIns="0" bIns="0" anchor="ctr"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`);
    }
    image(name: string, file: string, box: Box, crop = '') {
        if (!this.refs.has(file)) { this.links.push(['image', '../media/' + file]); this.refs.set(file, this.links.length); }
        this.shapes.push(`<p:pic><p:nvPicPr><p:cNvPr id="${this.nextId++}" name="${name}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId${this.refs.get(file)}"/><a:srcRect ${crop}/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${transform(box)}${shapeGeometry('rect')}</p:spPr></p:pic>`);
    }
    xml(base: string) {
        return `<p:sld ${ns}><p:cSld><p:bg><p:bgPr>${fill(base)}<a:effectLst/></p:bgPr></p:bg><p:spTree>${group}${this.shapes.join('')}</p:spTree></p:cSld>${mapOverride}</p:sld>`;
    }
}

function coverCrop(aspect: number) {
    const screen = 16 / 9;
    const cut = Math.round(50000 * (1 - Math.min(aspect / screen, screen / aspect)));
    return aspect > screen ? `l="${cut}" r="${cut}"` : `t="${cut}" b="${cut}"`;
}
function contain(box: Box, aspect: number): Box {
    const [x,y,w,h,size] = box;
    const width = Math.min(w, h * aspect), height = width / aspect;
    return [x + (w - width) / 2, y + (h - height) / 2, width, height, size];
}

export async function ceremonyPptx(deck: Deck, config: CeremonyConfig, layout: ExportLayout, background?: Image,
    loadLogo = (id: string) => readFile(path.join(__dirname, '../logos/png', id + '.png'))) {
    const entries: ZipEntry[] = [];
    const xml = (name: string, body: string) => entries.push({ name, data: Buffer.from(declaration + body) });
    const overrides: [string, string][] = [['presentation.xml','presentation.main'], ['slideMasters/slideMaster1.xml','slideMaster'],
        ['slideLayouts/slideLayout1.xml','slideLayout']];
    xml('_rels/.rels', rels([['officeDocument', 'ppt/presentation.xml']]));
    xml('ppt/theme/theme1.xml', theme);
    xml('ppt/slideMasters/slideMaster1.xml', master);
    xml('ppt/slideMasters/_rels/slideMaster1.xml.rels', rels([['slideLayout','../slideLayouts/slideLayout1.xml'], ['theme','../theme/theme1.xml']]));
    xml('ppt/slideLayouts/slideLayout1.xml', layoutPart);
    xml('ppt/slideLayouts/_rels/slideLayout1.xml.rels', rels([['slideMaster','../slideMasters/slideMaster1.xml']]));

    const backgroundFile = background ? 'background.' + (background.mime === 'image/png' ? 'png' : 'jpeg') : '';
    if (background) {
        if (!['image/png','image/jpeg'].includes(background.mime)) throw new Error('背景图片需要转换为 JPEG 后导出');
        entries.push({ name: 'ppt/media/' + backgroundFile, data: background.data });
    }
    const logoAspects = new Map<string, number>();
    const [base, themeInk, accent, accentInk, themePanel] = palettes[config.theme];
    const lightInk = layout.ink === '#ffffff';
    const ink = background ? lightInk ? 'FFFFFF' : '1B1C1F' : themeInk;
    const panel = background ? lightInk ? '000000' : 'FFFFFF' : themePanel;
    const date = new Intl.DateTimeFormat('zh-CN', { timeZone: layout.timeZone, year: 'numeric', month: 'long', day: 'numeric' }).format(deck.date);
    const slides: [string, string][] = [];
    for (const [i, page] of deck.slides.entries()) {
        const file = `slides/slide${i + 1}.xml`;
        overrides.push([file, 'slide']); slides.push(['slide', file]);
        const s = new Slide();
        const { slots, wrap } = layout.layouts[i];
        if (background) s.image('颁奖背景', backgroundFile, whole, coverCrop(layout.backgroundAspect));
        else for (const d of [21, 27]) s.shape('典礼边框', [d, d, 1280 - d * 2, 720 - d * 2, 1], 'rect', '<a:noFill/>', `<a:ln w="9525">${fill(accent, 55000)}</a:ln>`);
        if (page.kind === 'cover') {
            s.text('英文标题', 'AWARDS CEREMONY', slots.kicker, accent, 'ctr', true);
            s.text('比赛名称', deck.title, slots.cover, ink, 'ctr', true, true);
            if (slots.rule) { const [x,y,w,h] = slots.rule; s.shape('分隔线', [x,y+h/2,w,1,1], 'rect', fill(accent)); }
            s.text('颁奖典礼', '颁奖典礼', slots.ceremony, ink, 'ctr', true);
            s.text('比赛日期', date, slots.date, ink, 'ctr');
        } else {
            const [tier, tierInk] = plaques[page.tier] || [accent, accentInk];
            s.shape('名单底板', slots.panel, 'roundRect', fill(panel, background && lightInk ? 50000 : 74000));
            s.shape('奖项铭牌', slots.plaque, 'hexagon', fill(tier));
            s.text('赛事名称', deck.title, slots.title, ink);
            s.text('榜单', page.board, slots.board, ink, 'ctr');
            s.text('页码', `${page.part} / ${page.parts}`, slots.part, ink, 'ctr');
            s.text('奖项', page.award, slots.award, tierInk, 'ctr', true, true);
            s.text('副标题', page.subtitle, slots.subtitle, tierInk, 'ctr');
            for (const [j, team] of page.teams.entries()) {
                const rank = slots['rank' + j];
                s.shape('名次底纹', rank, 'roundRect', fill(tier));
                s.text('名次', String(team.rank || '*'), rank, tierInk, 'ctr', true);
                const logo = team.logo.match(/^\/hydro-resolver\/logos\/([0-9a-f]{12})\.webp$/)?.[1];
                const icon = slots['logo' + j];
                if (logo && icon) {
                    if (!logoAspects.has(logo)) {
                        const data = await loadLogo(logo);
                        if (data.length < 24 || !data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new Error('颁奖校徽 PNG 无效');
                        logoAspects.set(logo, data.readUInt32BE(16) / data.readUInt32BE(20));
                        entries.push({ name: `ppt/media/${logo}.png`, data });
                    }
                    s.shape('校徽底纹', icon, 'ellipse', fill('FFFFFF'));
                    s.image('校徽', logo + '.png', contain(icon, logoAspects.get(logo)!));
                }
                s.text('队伍', team.name, slots['name' + j], ink, 'l', true, wrap);
                s.text('学校', team.school, slots['school' + j], ink, 'l', false, wrap);
                s.text('队员', team.members.join('、'), slots['members' + j], ink, 'l', false, wrap);
            }
        }
        xml('ppt/' + file, s.xml(base));
        xml(`ppt/slides/_rels/slide${i + 1}.xml.rels`, rels(s.links));
    }
    xml('ppt/presentation.xml', `<p:presentation ${ns}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('')}</p:sldIdLst><p:sldSz cx="${emu(1280)}" cy="${emu(720)}" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`);
    xml('ppt/_rels/presentation.xml.rels', rels([['slideMaster','slideMasters/slideMaster1.xml'], ...slides]));
    xml('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>' +
        '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
        overrides.map(([file, type]) => `<Override PartName="/ppt/${file}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.${type}+xml"/>`).join('') + '</Types>');
    if (entries.length >= 0xffff) throw new Error('幻灯片超出 ZIP 文件数量上限，请分榜单导出');
    return writeZip(entries);
}
