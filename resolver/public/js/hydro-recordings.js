import { $, el, field as labeled, formatTime, get, input, notify, openDialog, post, runtime } from './hydro-manage-common.js';

function field(label, control) {
    control.setAttribute('aria-label', label);
    return labeled(label, control);
}

const names = { clipScreen: '片段 · 屏幕', clipWebcam: '片段 · 摄像头', archiveScreen: '留档 · 屏幕', archiveWebcam: '留档 · 摄像头' };
const streams = { screen: '屏幕', webcam: '摄像头' };
const kinds = { clip: '提交片段', archive: '全程留档', reaction: '反应视频' };
const clipStates = { requested: '等待上传', uploading: '上传中', ready: '已就绪', partial: '部分缺失', missing: '缺失' };
const reasons = { offline: '设备离线', evicted: '超出缓存', failed: '上传失败', closed: '窗口已关闭' };
const grades = { pass: '达标', marginal: '勉强', unknown: '数据不足', fail: '未达标' };
const presets = { low: '低', standard: '标准', high: '高', archiveHd: '高清留档', custom: '自定义' };
const verdicts = ['等待', 'AC', 'WA', 'TLE', 'MLE', 'OLE', 'RE', 'CE', 'SE', '已取消'];
const recordings = runtime.base + '/recordings';
const tests = runtime.base + '/tests';
const bytes = (n) => !Number.isFinite(n) ? '—' : n < 1e6 ? (n / 1000).toFixed(1) + ' kB' : n < 1e9 ? (n / 1e6).toFixed(1) + ' MB' : (n / 1e9).toFixed(2) + ' GB';
const num = (n) => Number.isFinite(n) ? n.toFixed(2) : '—';
const percent = (n) => Number.isFinite(n) ? (n * 100).toFixed(1) + '%' : '—';
const button = (label, click, style = '') => el('button', { type: 'button', class: 'button ' + style, text: label, onclick: click });
const select = (rows, selected) => el('select', { class: 'select' }, ...rows.map(([v, label]) => new Option(label, v, false, String(selected) === String(v))));
const options = (obj) => Object.entries(obj);
const labelCheck = (label, checked) => { const c = el('input', { type: 'checkbox', checked }); return [el('label', { class: 'checkbox' }, c, label), c]; };
const status = () => el('p', { class: 'resolver-muted', role: 'status', hidden: true });
const group = (title, ...children) => el('section', { class: 'manage-group' }, el('h3', { text: title }), ...children);
const toolbar = (...children) => el('div', { class: 'record-toolbar' }, ...children);
const table = (labels, rows, empty) => el('div', { class: 'manage-scroll' }, el('table', { class: 'data-table' },
    el('thead', {}, el('tr', {}, ...labels.map((label) => el('th', { text: label })))),
    el('tbody', {}, ...(rows.length ? rows.map((row) => el('tr', {}, ...row.map((cell) => el('td', {}, cell))))
        : [el('tr', {}, el('td', { class: 'manage-empty', colspan: labels.length, text: empty }))]))));
async function operate(path, operation, payload) {
    const response = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation, payload: JSON.stringify(payload) }) });
    const body = await response.json();
    if (!response.ok || body.error) throw new Error(body.error?.message || body.error || '操作失败');
    return body;
}
const time = (s) => new Date(s).getTime();
const teamName = (state, uid) => state.teams.find((t) => t.uid === Number(uid))?.name || ('UID ' + uid);
const teamChoices = (state, extra = []) => [...new Set([...state.teams.map((t) => t.uid), ...extra])].map((uid) => [String(uid), teamName(state, uid)]);

const codecLabels = { hevc: 'H.265', av1: 'AV1', h264: 'H.264', vp9: 'VP9', vp8: 'VP8' };
function segmentDescription(segment) {
    const q = segment.quality;
    if (!q) return '';
    return [codecLabels[q.codec], q.width && q.height ? q.width + ' × ' + q.height : ''].filter(Boolean).join(' · ');
}

function player(rows, start, end) {
    const root = el('div', { class: 'record-player' });
    const tracks = rows.slice().sort((a, b) => time(a.startAt) - time(b.startAt));
    if (!tracks.length) return el('p', { text: '此路没有可播放的录像' });
    const screen = el('video', { controls: true, playsinline: true, preload: 'metadata' });
    const label = el('p', {}, '');
    const download = el('a', { class: 'button', text: '下载当前段', download: '' });
    let i = 0;
    function show(next, autoplay = false, continueAt = start) {
        if (next >= tracks.length) return;
        const seg = tracks[i = next];
        const url = new URL(seg.url, location.href);
        screen.src = url.href;
        url.searchParams.set('download', '1');
        download.href = url.href;
        const interval = formatTime(seg.startAt) + ' 至 ' + formatTime(seg.endAt) + '（' + (i + 1) + '/' + tracks.length + '）';
        label.textContent = [interval, segmentDescription(seg)].filter(Boolean).join(' · ');
        const offset = Math.max(0, (continueAt - time(seg.startAt)) / 1000);
        screen.onloadedmetadata = () => { if (offset > 0 && Number.isFinite(offset)) screen.currentTime = offset; if (autoplay) screen.play().catch(() => {}); };
    }
    screen.addEventListener('ended', () => {
        const until = time(tracks[i].endAt);
        if (end && until >= end) return;
        let next = i + 1;
        while (next < tracks.length && time(tracks[next].endAt) <= until) next++;
        show(next, true, until);
    });
    screen.addEventListener('timeupdate', () => {
        if (end && time(tracks[i].startAt) + screen.currentTime * 1000 >= end) screen.pause();
    });
    show(0);
    root.append(screen, label, toolbar(button('上一段', () => show(Math.max(0, i - 1))), button('下一段', () => show(i + 1)), download));
    return root;
}

function showRecordings(panel, state, data, query, reload) {
    const { clips = [], segments = [], gaps = [], usage = [] } = data;
    const byId = new Map(segments.map((s) => [s.id || s._id, s]));
    const team = select([['', '全部队伍'], ...teamChoices(state, clips.map((c) => c.teamUid))], query.teamUid || '');
    const pid = select([['', '全部题目'], ...[...new Set(clips.map((c) => c.pid))].map((p) => [p, p])]);
    const verdict = select([['', '全部结果'], ...[...new Set(clips.map((c) => c.status))].map((s) => [s, verdicts[s] || s])]);
    const phase = select([['', '全部状态'], ...options(clipStates)]);
    const list = el('div');
    const update = () => {
        const items = clips.filter((c) => (!team.value || c.teamUid === +team.value) && (!pid.value || c.pid === +pid.value)
            && (!verdict.value || c.status === +verdict.value) && (!phase.value || c.state === phase.value));
        list.replaceChildren(table(['提交时间', '队伍', '题目', '结果', '录像状态', '回看'], items.map((c) => [
            formatTime(c.submittedAt), teamName(state, c.teamUid), String(c.pid), (c.firstSolve ? '一血 · ' : '') + (verdicts[c.status] || c.status), clipStates[c.state] || c.state,
            button('查看', () => openDialog({ title: '提交片段 · ' + teamName(state, c.teamUid), confirm: '完成', body: [
                el('p', { text: formatTime(c.windowStart) + ' 至 ' + formatTime(c.windowEnd) + (c.reason ? ' · ' + (reasons[c.reason] || c.reason) : '') }),
                ...Object.entries(c.streams || {}).map(([stream, track]) => group(streams[stream], player(track.segments.map((id) => byId.get(id)).filter(Boolean), time(c.windowStart), time(c.windowEnd)),
                    ...(track.missing || []).map((g) => el('p', { class: 'resolver-muted', text: '缺段 ' + formatTime(g.from) + ' 至 ' + formatTime(g.to) })))),
            ] })),
        ]), '没有符合条件的提交片段'));
    };
    team.onchange = () => reload({ teamPage: 1, teamUid: team.value });
    for (const control of [pid, verdict, phase]) control.onchange = update;
    update();
    const archive = segments.filter((s) => s.kind === 'archive');
    const startAt = time(state.contest?.beginAt), endAt = time(state.contest?.endAt);
    const timeline = el('div', { class: 'record-timeline' });
    const archiveTeams = [...new Set([...archive, ...gaps].map((s) => s.teamUid))];
    for (const uid of archiveTeams) {
        for (const stream of Object.keys(streams)) {
            const rows = archive.filter((s) => s.teamUid === uid && s.stream === stream).sort((a, b) => time(a.startAt) - time(b.startAt));
            const holes = gaps.filter((s) => s.teamUid === uid && s.stream === stream);
            if (!rows.length && !holes.length) continue;
            const starts = [...rows.map((r) => time(r.startAt)), ...holes.map((g) => time(g.from))];
            const ends = [...rows.map((r) => time(r.endAt)), ...holes.map((g) => time(g.to))];
            const from = Math.min(...starts, Number.isFinite(startAt) ? startAt : Infinity);
            const to = Math.max(...ends, Number.isFinite(endAt) ? endAt : -Infinity);
            const strip = el('div', { class: 'record-lane' });
            const band = (a, b, title, isGap, click) => {
                const range = Math.max(1, to - from);
                strip.append(el(isGap ? 'span' : 'button', { type: isGap ? null : 'button', class: isGap ? 'record-gap' : 'record-segment', title, 'aria-label': title,
                    style: 'left:' + (a - from) * 100 / range + '%;width:' + (b - a) * 100 / range + '%', onclick: click }));
            };
            rows.forEach((r, index) => band(time(r.startAt), time(r.endAt), [formatTime(r.startAt), bytes(r.bytes), segmentDescription(r)].filter(Boolean).join(' · '), false, (e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const pos = e.detail && rect.width ? Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) : 0;
                const at = time(r.startAt) + (time(r.endAt) - time(r.startAt)) * pos;
                openDialog({ title: '留档 · ' + teamName(state, uid) + ' · ' + streams[stream], confirm: '完成', body: [player(rows.slice(index), at)] });
            }));
            holes.forEach((g) => band(time(g.from), time(g.to), formatTime(g.from) + ' 至 ' + formatTime(g.to) + ' · ' + (reasons[g.reason] || '缺段'), true));
            timeline.append(el('div', {}, el('strong', { text: teamName(state, uid) + ' · ' + streams[stream] }), strip));
        }
    }
    if (!archiveTeams.length) timeline.append(el('p', { class: 'manage-empty', text: '暂无留档' }));
    const cleanKind = select([['', '全部类型'], ...options(kinds)]), cleanTeam = select([['', '全部队伍'], ...teamChoices(state, usage.map((u) => u.teamUid))]);
    const from = input({ type: 'datetime-local' }), to = input({ type: 'datetime-local' }), message = status();
    async function clean(all) {
        const payload = all ? { all: true } : { ...(cleanKind.value ? { kind: cleanKind.value } : {}), ...(cleanTeam.value ? { teamUid: +cleanTeam.value } : {}),
            ...(from.value ? { from: time(from.value) } : {}), ...(to.value ? { to: time(to.value) } : {}) };
        if (!all && !Object.keys(payload).length) { notify(message, '请先选定清理范围，或使用删除本场全部录像。', true); return; }
        try {
            const review = await operate(recordings, 'preview_delete', payload);
            const title = input({ required: true, autocomplete: 'off' });
            openDialog({ title: all ? '删除本场全部录像' : '确认删除选定录像', confirm: '永久删除',
                body: [el('p', { text: '将永久删除 ' + review.count + ' 个文件（' + bytes(review.bytes) + '）。' }),
                    ...(all ? [field('输入比赛名称确认：' + runtime.title, title)] : [])],
                submit: async () => {
                    if (all && title.value !== runtime.title) throw new Error('比赛名称不匹配');
                    await operate(recordings, 'delete', { ...payload, confirmation: review.confirmation, ...(all ? { title: title.value } : {}) });
                    await reload();
                } });
        } catch (error) { notify(message, error.message, true); }
    }
    const currentPage = data.teamPage || 1, totalPages = data.teamPages || 1;
    const previous = button('上一页队伍', () => reload({ teamPage: currentPage - 1 }));
    const next = button('下一页队伍', () => reload({ teamPage: currentPage + 1 }));
    previous.disabled = currentPage <= 1; next.disabled = currentPage >= totalPages;
    const page = !query.teamUid && totalPages > 1 ? toolbar(previous, el('span', { text: currentPage + ' / ' + totalPages + ' 页' }), next) : null;
    panel.replaceChildren(group('提交片段', toolbar(field('队伍', team), field('题目', pid), field('结果', verdict), field('状态', phase), button('刷新', () => reload())), page, list),
        group('留档时间轴', el('p', { class: 'resolver-muted', text: '实色为录像，斜纹为缺段。点击录像可从相应时刻播放。' }), timeline),
        group('存储用量', el('p', { text: '已用 ' + bytes(usage.reduce((s, r) => s + r.bytes, 0)) + (Number.isFinite(data.freeBytes) ? ' · 磁盘可用 ' + bytes(data.freeBytes) : '') }),
            table(['队伍', '类型', '文件数', '用量'], usage.map((r) => [teamName(state, r.teamUid), kinds[r.kind] || r.kind, String(r.count), bytes(r.bytes)]), '尚无录像文件')),
        group('清理录像', toolbar(field('类型', cleanKind), field('队伍', cleanTeam), field('起始时间', from), field('结束时间', to)),
            toolbar(button('预览删除范围', () => clean(false)), button('删除本场全部录像', () => clean(true), 'manage-danger')), message));
}

function showSettings(panel, state, data) {
    const recording = structuredClone(state.settings.recording);
    const message = status(), estimate = el('div', { role: 'status' });
    let pending = 0, revision = 0;
    function displayPlan(info, measured = data.measured, measuredPeak = data.measuredPeak) {
        const total = Object.values(info.sources).reduce((sum, n) => sum + n, 0);
        const pct = info.utilization;
        const utilization = el('strong', { text: pct == null ? '未填写赛场上行带宽' : '峰值占上行 ' + percent(pct),
            class: pct == null ? '' : pct < .6 ? 'record-ok' : pct <= .8 ? 'record-warn' : 'manage-error' });
        estimate.replaceChildren(el('p', { text: data.stats.teams + ' 支队伍 · 比赛 ' + (data.stats.seconds / 3600).toFixed(1) + ' 小时 · ' + (info.real ? '按实际提交速度推算' : '按赛前提交数估计') }),
            toolbar(el('strong', { text: '平均 ' + num(info.averageMbps) + ' Mbps' }), el('strong', { text: '峰值 ' + num(info.peakMbps) + ' Mbps' + (measuredPeak ? ' · 实测峰值系数 ' + num(measuredPeak) : '') }), utilization,
                el('strong', { text: '预计存储 ' + bytes(info.storageBytes) })),
            Number.isFinite(data.freeBytes) ? el('p', { class: info.storageBytes > data.freeBytes ? 'manage-error' : '', text: '磁盘可用 ' + bytes(data.freeBytes) }) : document.createTextNode(''),
            table(['来源', '预计用量', '占比', '码率'], Object.entries(info.sources).map(([key, n]) => [names[key], bytes(n), total ? percent(n / total) : '0%',
                measured?.[key] ? num(measured[key]) + ' kbps · 按实测' : '按设置']), ''));
    }
    function changed() {
        const index = ++revision;
        clearTimeout(pending);
        pending = setTimeout(async () => {
            try { const result = await operate(recordings, 'estimate', { recording }); if (index === revision) displayPlan(result.estimate, result.measured, result.measuredPeak); }
            catch (error) { if (index === revision) estimate.replaceChildren(el('p', { class: 'manage-error', text: error.message })); }
        }, 180);
    }
    const numberField = (label, obj, key, min, max, step = '1', nullable = false) => {
        const node = input({ type: 'number', value: obj[key] ?? '', min, max, step, required: !nullable });
        node.oninput = () => { obj[key] = nullable && node.value === '' ? null : node.valueAsNumber; changed(); };
        return field(label, node);
    };
    const toggle = (label, obj, key) => {
        const [node, check] = labelCheck(label, obj[key]);
        check.onchange = () => { obj[key] = check.checked; changed(); };
        return node;
    };
    function qualityRow(kind, stream) {
        const obj = recording[kind], source = (kind === 'clips' ? 'clip' : kind) + (stream === 'screen' ? 'Screen' : 'Webcam');
        const choices = data.presets[source];
        const root = el('div', { class: 'record-quality' });
        const preset = select([...(stream === 'webcam' ? [['', '关闭']] : []), ...Object.keys(choices).map((key) => [key, presets[key] || key]), ['custom', presets.custom]], obj[stream]?.preset || '');
        const inputs = el('div', { class: 'record-toolbar' });
        const fields = () => {
            inputs.replaceChildren(); const q = obj[stream]; if (!q) return;
            if (q.preset === 'custom') inputs.append(numberField('高度 / px', q, 'height', 120, 2160), numberField('帧率 / fps', q, 'fps', 0.1, 60, '0.1'), numberField('码率 / kbps', q, 'kbps', 10, 20000));
            else inputs.append(el('span', { text: q.height + 'p · ' + q.fps + ' fps · ' + q.kbps + ' kbps' }));
            if (q.preset === 'archiveHd') inputs.append(el('small', { class: 'resolver-muted', text: '依次尝试 H.265、AV1、H.264。首段最多 2 秒，之后每 60 秒分段。' }));
        };
        preset.onchange = () => {
            const value = preset.value;
            if (!value) obj[stream] = null;
            else {
                const old = obj[stream];
                const [height, fps, kbps] = choices[value] || (old ? [old.height, old.fps, old.kbps] : choices.standard);
                obj[stream] = { preset: value, height, fps, kbps };
            }
            fields(); changed();
        };
        fields(); root.append(field(names[source], preset), inputs);
        return root;
    }
    const scope = select(options({ all: '所有判完的提交', accepted: '只录通过', first: '只录一血' }), recording.clips.scope);
    scope.onchange = () => { recording.clips.scope = scope.value; changed(); };
    const form = el('form');
    form.append(group('提交片段', toggle('录制提交片段', recording.clips, 'enabled'), toolbar(field('录制范围', scope),
        numberField('提交前 / 秒', recording.clips, 'beforeSeconds', 0, 120), numberField('通过后 / 秒', recording.clips, 'afterAcceptedSeconds', 0, 120),
        numberField('其他结果后 / 秒', recording.clips, 'afterOtherSeconds', 0, 120)), qualityRow('clips', 'screen'), qualityRow('clips', 'webcam')),
    group('全程留档', toggle('录制全程留档', recording.archive, 'enabled'), qualityRow('archive', 'screen'), qualityRow('archive', 'webcam'),
        toggle('上传积压时自动降低画质', recording, 'autoDowngrade')),
    group('带宽与存储', toolbar(numberField('上行 / Mbps', recording.planning, 'uplinkMbps', .01, 1e6, 'any', true),
        numberField('每队提交数', recording.planning, 'submissionsPerTeam', 0, 10000), numberField('每队通过数', recording.planning, 'acceptedPerTeam', 0, 10000),
        numberField('峰值系数', recording.planning, 'peakFactor', 1, 100, 'any')), estimate),
    el('button', { type: 'submit', class: 'button primary', text: '保存录制设置' }), message);
    displayPlan(data.estimate);
    form.onsubmit = async (event) => {
        event.preventDefault();
        try { const result = await post('settings', { settings: { recording } }); state.settings = result.settings; notify(message, '录制设置已保存'); }
        catch (error) { notify(message, error.message, true); }
    };
    panel.replaceChildren(form);
}

function reportView(state, test) {
    const deviceName = (id) => state.devices.find((d) => d.id === id)?.name || id;
    const summary = test.summary;
    const body = el('div');
    const recommended = summary?.recommended === 'archiveHd' ? '屏幕选高清留档，其他已启用通道选高档' : presets[summary?.recommended];
    if (summary) body.append(el('p', { text: '峰值 ' + num(summary.peakMbps) + ' Mbps · P95 ' + num(summary.p95Mbps) + ' Mbps · 最大积压 ' + bytes(summary.maxBacklog) + ' · 失败率 ' + percent(summary.failureRate) }),
        el('p', { text: (summary.passed ? '本次测试达标' : '本次测试未达标') + (summary.recommended ? ' · 建议画质 ' + recommended : '')
            + (summary.failedDevices?.length ? ' · 待检查设备 ' + summary.failedDevices.map(deviceName).join('、') : '') }));
    if (test.storage) body.append(el('p', { text: '存储实测 · 写入 ' + num(test.storage.writeMBps) + ' MB/s · 读回 ' + num(test.storage.readMBps) + ' MB/s' }));
    if (test.storageError) body.append(el('p', { class: 'manage-error', text: '存储测试失败：' + test.storageError }));
    const series = test.series || [];
    if (series.length) {
        const plot = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        plot.setAttribute('viewBox', '0 0 600 110'); plot.setAttribute('role', 'img'); plot.setAttribute('aria-label', '每秒接收带宽曲线');
        const max = Math.max(1, ...series.map((s) => s.mbps));
        const line = document.createElementNS(plot.namespaceURI, 'polyline');
        line.setAttribute('points', series.map((p, i) => (i * 600 / Math.max(1, series.length - 1)) + ',' + (106 - 102 * p.mbps / max)).join(' '));
        line.setAttribute('fill', 'none'); line.setAttribute('stroke', 'currentColor'); line.setAttribute('stroke-width', '2');
        plot.append(line); body.append(el('figure', { class: 'record-chart' }, plot,
            el('figcaption', { text: '每秒接收带宽 · 纵轴 0–' + num(max) + ' Mbps · 最近一秒写入 ' + num(series.at(-1).writeMBps) + ' MB/s' })));
    }
    body.append(table(['设备', '已上传', '积压', '失败', '掉帧', 'CPU 压力', '吞吐 / Mbps', '实际码率 / kbps', '判定与建议'],
        (test.targets || []).map((id) => {
            const d = test.devices[id] || {};
            const rates = Object.entries(d.bitrates || {}).map(([k, v]) => names[k] + ' ' + num(v)).join('、');
            return [deviceName(id), bytes(d.bytes), bytes(d.backlogBytes), String(d.failures ?? '—'), percent(d.dropRate), d.pressure || '—',
                num(d.throughputMbps), [rates, codecLabels[d.archiveScreenCodec] && '留档屏幕 ' + codecLabels[d.archiveScreenCodec]].filter(Boolean).join(' · ') || '—', d.recordingError || (grades[d.grade] || '等待上报') + (d.recommendation === 'low' ? ' · 建议低档' : '')];
        }), '没有设备报告'));
    return body;
}

function showTests(panel, state, data) {
    const online = state.devices.filter((d) => d.online);
    const selected = online.map((d) => [d.id, ...labelCheck(d.name, false)]);
    const minutes = input({ type: 'number', min: 3, max: 15, value: 3 });
    const interval = input({ type: 'number', min: 5, max: 3600, value: 180 });
    const mode = select([['normal', '按比赛设置'], ['peak', '模拟峰值']]);
    const message = status(), reports = el('div');
    async function run(operation, payload) {
        try {
            const result = await operate(tests, operation, payload);
            notify(message, result.storage ? '50 MB 写入 ' + num(result.storage.writeMBps) + ' MB/s · 读回 ' + num(result.storage.readMBps) + ' MB/s' : '测试已发起');
            await refresh();
        } catch (error) { notify(message, error.message, true); }
    }
    const renderReports = ({ tests: rows }) => {
        const open = new Set([...reports.querySelectorAll('details[open]')].map((n) => n.dataset.report));
        reports.replaceChildren(...rows.map((t, i) => el('details', { class: 'manage-group', 'data-report': t._id, open: open.has(t._id) || i === 0 },
            el('summary', { text: formatTime(t.startedAt) + ' · ' + (t.kind === 'venue' ? '全场压力测试' : t.kind === 'storage' ? '存储测试' : '设备自检') + ' · ' + (t.endedAt ? '已结束' : '进行中') }), reportView(state, t))));
        if (!rows.length) reports.append(el('p', { class: 'manage-empty', text: '尚无测试报告' }));
    };
    const refresh = async () => { try { renderReports(await get({}, tests)); } catch (error) { notify(message, error.message, true); } };
    renderReports(data);
    panel.replaceChildren(group('设备自检', el('p', { text: '试录并上传当前画质的各路视频，约 30 秒。留空将测试全部在线设备。' }),
        toolbar(...selected.map(([, label]) => label)), button('开始设备自检', () => run('start', { kind: 'device', deviceIds: selected.filter(([, , check]) => check.checked).map(([id]) => id) }))),
    group('全场压力测试', toolbar(field('测试时长 / 分钟', minutes), field('每队模拟提交间隔 / 秒', interval), field('方式', mode)),
        toolbar(button('开始全场压力测试', () => run('start', { kind: 'venue', durationSeconds: minutes.valueAsNumber * 60, intervalSeconds: interval.valueAsNumber, mode: mode.value }), 'primary'),
            button('测试存储写入与读回', () => run('storage', {})))), message, group('测试报告', button('刷新报告', refresh), reports));
    return refresh;
}

export function installRecordingTabs(state, loadCapture) {
    const root = $('manage-root');
    const extra = $('record-panel');
    const nav = $('record-tabs');
    let generation = 0, timer;
    const buttons = new Map();
    const query = { teamPage: 1, teamLimit: 12, teamUid: '' };
    async function open(key) {
        const current = ++generation;
        clearInterval(timer);
        for (const [id, item] of buttons) {
            item.classList.toggle('is-active', id === key);
            item.setAttribute('aria-selected', String(id === key));
        }
        root.hidden = key !== 'capture';
        extra.hidden = key === 'capture';
        if (extra.hidden) return;
        extra.replaceChildren(el('p', { class: 'resolver-muted', text: '加载中…' }));
        try {
            if (!state.settings) await loadCapture();
            const params = key === 'settings' ? { view: 'settings' } : key === 'recordings' ? query : {};
            const values = await get(params, key === 'tests' ? tests : recordings + '/data');
            if (generation !== current) return;
            if (key === 'recordings') showRecordings(extra, state, values, query, (filters) => { Object.assign(query, filters); return open(key); });
            else if (key === 'settings') showSettings(extra, state, values);
            else {
                const refresh = showTests(extra, state, values);
                timer = setInterval(() => { if (!document.hidden && !document.querySelector('dialog[open]')) refresh(); }, 5000);
            }
        } catch (error) {
            if (generation === current) extra.replaceChildren(el('p', { class: 'manage-error', role: 'alert', text: error.message }), button('重试', () => open(key)));
        }
    }
    for (const [key, name] of options({ capture: '采集设备', recordings: '录像', tests: '测试', settings: '录制设置' })) {
        const node = button(name, () => { if (location.hash !== '#' + key) location.hash = key; else open(key); });
        node.setAttribute('role', 'tab');
        buttons.set(key, node); nav.append(node);
    }
    const fromHash = () => { const key = location.hash.slice(1); open(buttons.has(key) ? key : 'capture'); };
    window.addEventListener('hashchange', fromHash);
    fromHash();
}
