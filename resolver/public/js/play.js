import { actionIndicesFor, startIndexFor, nextAutomaticAction, awardStops, nextAwardStop, teamJump, hasRows, confirmPrevious } from './playback-model.js';
import { AutomaticAdvance } from './automatic-advance.js';
import { ResolverView } from './render/resolver-view.js';
import { readJSONResponse } from './http.js';

// HydroXCPCIO: authenticated per-user sessions and domain-aware API paths.
const runtime = JSON.parse(document.getElementById('resolver-runtime').textContent);
const gameId = runtime.id;
const isPreview = false;
const controlToken = runtime.controlToken;
const cast = document.getElementById('btn-cast');
cast.addEventListener('click', async () => {
  cast.disabled = true;
  try {
    const response = await fetch(runtime.screensUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ operation: 'bind_resolver', sessionId: gameId }) });
    const data = await readJSONResponse(response, '投屏失败，请检查登录状态');
    if (!data.audienceUrl) throw new Error('投屏失败，请检查登录状态');
    const link = document.getElementById('audience-link');
    link.href = data.audienceUrl;
    link.hidden = false;
    toast('当前会话已投到观众屏');
  } catch (error) { toast(error.message); }
  finally { cast.disabled = false; }
});
let revision = 0;
let transitioning = false;
let connected = true;
let syncing = false;
let mutationEpoch = 0;
let ended = false;
let pollTimer;
const playerRoot = document.getElementById('hydro-resolver-player');
const canvas = document.getElementById('screen');
const loadingEl = document.getElementById('loading');
const errorEl = document.getElementById('error');
const errorMessageEl = document.getElementById('error-message');
const hudEl = document.getElementById('hud');
const controlsWrap = document.getElementById('controls-wrap');
const controlsEl = document.getElementById('controls');
const helpEl = document.getElementById('help');
const toastEl = document.getElementById('toast');
const progressBar = document.getElementById('progress-bar');
const hudContest = document.getElementById('hud-contest');
const hudStep = document.getElementById('hud-step');
const hudStepCount = document.getElementById('hud-step-count');
const hudSpeed = document.getElementById('hud-speed');
const hudPreview = document.getElementById('hud-preview');
const btnNext = document.getElementById('btn-next');
const btnPrev = document.getElementById('btn-prev');
const btnRestart = document.getElementById('btn-restart');
const btnHelp = document.getElementById('btn-help');
const btnFull = document.getElementById('btn-full');
const btnFast = document.getElementById('btn-fast');

let game = null;
let view = null;
let steps = [];
let actionIndices = [];
let actionPos = -1;
let index = -1;
let mode = 'idle'; // idle | paused | end
let lastFrame = performance.now();
let hideTimer = 0;
let toastTimer = 0;
let lastAppliedStep = null;
let fsBarTimer = 0;
let lastPointerY = null;

const FS_HOT_ZONE_PX = 150; // distance from the bottom edge that reveals the bar
const FS_HIDE_DELAY_MS = 450;

const teamById = new Map();
let awardTarget = null;
let skipToTarget = false;
let stops = [];
// Keyboard and right-click jumps backward or by ten teams need a second press within 1.5 s.
let armed = null;
function confirmed(key) {
  const now = performance.now();
  if (armed?.key === key && confirmPrevious(armed.at, now)) { armed = null; return true; }
  armed = { key, at: now };
  return false;
}
function stopAdvance() {
  awardTarget = null;
  skipToTarget = false;
  fastForward.stop();
}
function nextAdvance() {
  if (!game) return null;
  if (awardTarget === null) return nextAutomaticAction(game, actionIndices, actionPos);
  if (index >= awardTarget) { awardTarget = null; return null; }
  return { index: skipToTarget ? awardTarget : actionIndices[actionPos + 1], delay: skipToTarget ? 0 : 65 };
}
function goToAward() {
  if (!game || !connected) return;
  armed = null;
  if (awardTarget !== null) {
    skipToTarget = true;
    fastForward.schedule();
    return;
  }
  stopAdvance();
  awardTarget = nextAwardStop(game, actionIndices, actionPos, stops);
  if (awardTarget === null) { toast('已到最后一个奖区'); return; }
  fastForward.start();
}
const fastForward = new AutomaticAdvance({
  next: nextAdvance,
  advance: (target) => moveTo(target, { automatic: true }),
  changed: () => { if (game) updateHud(); },
});

function connectionStatus(online) {
  connected = online;
  playerRoot.classList.toggle('disconnected', !online);
  const badge = document.getElementById('hud-connection');
  if (badge) badge.textContent = online ? '进度已保存' : '连接中断 · 已暂停，等待同步';
  if (!online) stopAdvance();
  updateHud();
}

function showError(message) {
  stopAdvance();
  ended = true;
  clearTimeout(pollTimer);
  loadingEl.hidden = true;
  errorEl.hidden = false;
  errorMessageEl.textContent = message || '未知错误';
  playerRoot.classList.remove('is-loading');
}

function toast(message) {
  if (!toastEl) return;
  toastEl.textContent = message;
  toastEl.classList.add('is-showing');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('is-showing'), 1900);
}

function formatStep(step) {
  if (!step) return '准备中';
  const team = step.teamId ? teamById.get(step.teamId) : null;
  const problem = Number.isInteger(step.problemIndex) ? game?.contest?.problems?.[step.problemIndex] : null;
  switch (step.type) {
    case 'presentation':
      if (step.screen === 'splash') return '开场';
      if (step.screen === 'scoreboard') return '冻结榜单';
      if (step.screen === 'teamAward') return '奖项展示';
      if (step.screen === 'teamList') return '获奖名单';
      return '切换画面';
    case 'delay':
      return '…';
    case 'pause':
      return '等待继续';
    case 'selectTeam':
      if (!step.teamIds || step.teamIds.length === 0) return '取消聚焦';
      if (step.teamIds.length > 1) return `聚焦 ${step.teamIds.length} 支队伍`;
      return `聚焦 ${teamById.get(step.teamIds[0])?.displayName || step.teamIds[0]}`;
    case 'selectSubmission':
      return `待解析 ${team?.displayName || ''}${problem ? ` · ${problem.label}` : ''}`;
    case 'scroll':
      return `滚动至第 ${Math.max(1, step.row + 1)} 行`;
    case 'resolve': {
      const result = step.status === 'solved' ? '通过' : '失败';
      return `解析 ${team?.displayName || ''}${problem ? ` · ${problem.label}` : ''} → ${result}`;
    }
    case 'award':
      return `奖项：${team?.displayName || ''}`;
    case 'message':
      return step.text || '提示';
    default:
      return step.type;
  }
}

function updateHud() {
  if (!game || isPreview) return;
  const total = actionIndices.length;
  const current = actionPos + 1;
  progressBar.style.width = `${total ? Math.min(100, (Math.max(0, current) / total) * 100) : 0}%`;
  hudStepCount.textContent = `${Math.max(0, current)} / ${total}`;
  hudStep.textContent = mode === 'end' ? '滚榜结束（可回看）' : formatStep(lastAppliedStep);
  const canFastForward = Boolean(nextAutomaticAction(game, actionIndices, actionPos));
  const rate = `${game.options.autoplaySpeed ?? game.meta?.fastForwardSpeed ?? 4} 倍速`;
  if (hudSpeed) hudSpeed.textContent = fastForward.active ? `${rate}自动滚榜` : transitioning ? '同步中…' :
    canFastForward ? '自动滚榜已暂停' : '手动主持';
  if (btnFast) {
    btnFast.hidden = !canFastForward;
    btnFast.textContent = fastForward.active ? `暂停自动 · ${rate}` : `继续自动 · ${rate}`;
  }
  btnPrev.disabled = !connected || transitioning || actionPos <= 0;
  btnNext.disabled = !connected || transitioning || actionPos >= total - 1;
  btnRestart.disabled = !connected || transitioning;
  if (btnFast) btnFast.disabled = !connected || transitioning;
  playerRoot.classList.toggle('is-paused', mode === 'paused' || mode === 'end');
}

function applyStep(step, { instant = false } = {}) {
  if (!step) return;
  lastAppliedStep = step;
  view.applyStep(step, { instant });
  updateHud();
}

function lastActionAtOrBefore(rawIndex) {
  let pos = -1;
  for (let i = 0; i < actionIndices.length && actionIndices[i] <= rawIndex; i += 1) pos = i;
  return pos;
}

function rebuildTo(targetIndex, { instant = true } = {}) {
  if (!view) view = new ResolverView(canvas, game);
  index = -1;
  actionPos = -1;
  lastAppliedStep = null;
  for (let i = 0; i <= targetIndex && i < steps.length; i += 1) {
    const step = steps[i];
    index = i;
    if (step.type === 'delay' || step.type === 'pause') continue;
    lastAppliedStep = step;
  }
  view.seek(steps, targetIndex);
  actionPos = lastActionAtOrBefore(index);
  mode = actionPos === actionIndices.length - 1 ? 'end' : 'paused';
  updateHud();
}

function startTarget() {
  return game ? startIndexFor(game) : -1;
}

function goToStart() {
  return moveTo(startTarget(), { instant: true });
}

async function moveTo(targetIndex, { instant = false } = {}) {
  if (instant) stopAdvance();
  if (!game || ended || !connected || transitioning || !actionIndices.includes(targetIndex)) return false;
  mutationEpoch++;
  transitioning = true;
  updateHud();
  try {
    const response = await fetch(`${runtime.base}/playback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Resolver-Control': controlToken },
      body: JSON.stringify({ index: targetIndex, revision }),
      signal: AbortSignal.timeout(8000),
    });
    const data = await response.json().catch(() => ({}));
    if ([401, 403, 404].includes(response.status)) {
      showError(typeof data.error === 'string' ? data.error : '会话已结束或权限失效，请返回配置页');
      return false;
    }
    if (response.status === 409) {
      stopAdvance();
      revision = data.playback.revision;
      rebuildTo(data.playback.index);
      toast('进度已在另一个页面更新，已暂停并同步');
      return false;
    }
    if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : '保存进度失败');
    revision = data.playback.revision;
    if (instant || actionIndices.indexOf(targetIndex) !== actionPos + 1) rebuildTo(targetIndex);
    else applyActionAt(actionIndices.indexOf(targetIndex));
    return true;
  } catch (error) {
    connectionStatus(false);
    toast(`${error.name === 'TimeoutError' ? '连接超时' : error.message}，等待同步后继续`);
    return false;
  } finally {
    transitioning = false;
    updateHud();
  }
}

async function syncPlayback() {
  if (ended || isPreview || !game || syncing) return;
  clearTimeout(pollTimer);
  syncing = true;
  if (!transitioning) {
    const before = revision;
    const epoch = mutationEpoch;
    try {
      const response = await fetch(`${runtime.base}/playback`, {
        cache: 'no-store', headers: { 'X-Resolver-Control': controlToken || '' }, signal: AbortSignal.timeout(8000),
      });
      if ([401, 403, 404].includes(response.status)) { syncing = false; showError('滚榜会话已删除或权限失效，请返回配置页'); return; }
      const data = await readJSONResponse(response);
      if (!transitioning && epoch === mutationEpoch && revision === before && data.playback.revision !== revision) {
        stopAdvance();
        revision = data.playback.revision;
        rebuildTo(data.playback.index);
      }
      if (!transitioning && epoch === mutationEpoch) connectionStatus(true);
    } catch { if (!transitioning && epoch === mutationEpoch) connectionStatus(false); }
  }
  syncing = false;
  if (!ended) pollTimer = setTimeout(syncPlayback, 2000);
}

function applyActionAt(pos) {
  if (!game || pos < 0 || pos >= actionIndices.length) return;
  const target = actionIndices[pos];
  index = target;
  applyStep(steps[target], { instant: false });
  actionPos = pos;
  mode = pos >= actionIndices.length - 1 ? 'end' : 'paused';
  updateHud();
}

async function goNext() {
  if (!game) return;
  armed = null;
  stopAdvance();
  if (actionPos + 1 >= actionIndices.length) {
    mode = 'end';
    updateHud();
    return;
  }
  const moved = await moveTo(actionIndices[actionPos + 1], { relative: 1 });
  if (moved && !isPreview) fastForward.start();
  return moved;
}

function goPrevious(guarded = false) {
  stopAdvance();
  if (!game || actionPos <= 0) return;
  if (guarded === true && !isPreview && !confirmed('previous')) {
    toast('再按一次撤回上一步');
    return;
  }
  armed = null;
  return moveTo(actionIndices[actionPos - 1], { instant: true, relative: -1 });
}

// G / I: ten teams on (revealed quickly, J arrives at once, Esc stops) or back (at once).
function jumpTeams(delta) {
  if (!game || !connected || ended) return;
  stopAdvance();
  if (!hasRows(game)) { toast('重新创建会话后可按队跳转'); return; }
  const key = delta > 0 ? 'forward' : 'back';
  if (!isPreview && !confirmed(key)) {
    toast(delta > 0 ? '再按一次前进 10 队' : '再按一次回退 10 队');
    return;
  }
  armed = null;
  const target = teamJump(game, actionIndices, actionPos, delta);
  if (target === null) { toast(delta > 0 ? '已到榜首' : '已在开头'); return; }
  if (delta < 0) { moveTo(target, { instant: true }); return; }
  awardTarget = target;
  fastForward.start();
}

const confirmEl = document.getElementById('confirm');
let confirmResolve = null;

/** Viewer-visible jumps need an explicit click; the default focus is “取消” so clickers cannot confirm. */
function confirmAction({ title, message, ok }) {
  if (isPreview || !confirmEl) return Promise.resolve(true);
  confirmResolve?.(false);
  stopAdvance();
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-message').textContent = message;
  document.getElementById('confirm-ok').textContent = ok;
  confirmEl.hidden = false;
  playerRoot.classList.add('help-open');
  document.getElementById('confirm-cancel').focus();
  return new Promise((resolve) => { confirmResolve = resolve; });
}

function closeConfirm(result) {
  if (confirmEl.hidden) return;
  confirmEl.hidden = true;
  playerRoot.classList.toggle('help-open', !helpEl.hidden);
  const resolve = confirmResolve;
  confirmResolve = null;
  resolve?.(result);
  scheduleIdle();
}

async function restart() {
  if (!game || actionPos <= actionIndices.indexOf(startTarget())) return;
  const confirmed = await confirmAction({
    title: '回到开头？',
    message: '当前会话将回到滚榜开头，已揭晓的结果需要重新推进。',
    ok: '回到开头',
  });
  if (confirmed) return goToStart();
}

async function jumpToEnd() {
  if (!game || actionPos >= actionIndices.length - 1) return;
  const confirmed = await confirmAction({
    title: '跳到结尾？',
    message: '所有剩余提交和奖项会立即揭晓，并显示最终榜单。',
    ok: '立即揭晓全部',
  });
  if (confirmed) return jumpTo(actionIndices[actionIndices.length - 1]);
}

function jumpTo(targetIndex) {
  if (!game) return;
  return moveTo(targetIndex, { instant: true });
}

function toggleHelp(force) {
  const open = typeof force === 'boolean' ? force : helpEl.hidden;
  helpEl.hidden = !open;
  playerRoot.classList.toggle('help-open', open);
  if (open) {
    playerRoot.classList.remove('idle');
    clearTimeout(hideTimer);
  } else {
    scheduleIdle();
  }
}

function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen?.();
  } else {
    playerRoot.requestFullscreen?.().catch(() => toast('浏览器阻止了全屏'));
  }
}

function scheduleIdle() {
  if (isPreview) return;
  clearTimeout(hideTimer);
  playerRoot.classList.remove('idle');
  hideTimer = setTimeout(() => {
    if (!playerRoot.classList.contains('help-open')) {
      playerRoot.classList.add('idle');
    }
  }, 2800);
}

function fullscreenBarVisible() {
  return playerRoot.classList.contains('fs-bar-visible');
}

function setFullscreenBarVisible(visible) {
  clearTimeout(fsBarTimer);
  fsBarTimer = 0;
  playerRoot.classList.toggle(
    'fs-bar-visible',
    Boolean(visible) && Boolean(document.fullscreenElement),
  );
}

function scheduleFullscreenBarHide() {
  if (!document.fullscreenElement) return;
  clearTimeout(fsBarTimer);
  fsBarTimer = setTimeout(() => {
    fsBarTimer = 0;
    if (!document.fullscreenElement) return;
    if (controlsEl?.matches(':hover') || controlsEl?.querySelector(':focus-visible')) return;
    setFullscreenBarVisible(false);
  }, FS_HIDE_DELAY_MS);
}

/*
 * Fullscreen chrome: the control bar stays out of the way and only slides back
 * in when the pointer reaches the bottom edge (or is over the bar itself).
 */
function handleFullscreenPointer() {
  if (!document.fullscreenElement) return;
  const nearBottom = lastPointerY != null && lastPointerY >= window.innerHeight - FS_HOT_ZONE_PX;
  if (nearBottom || controlsEl?.matches(':hover')) {
    setFullscreenBarVisible(true);
  } else if (fullscreenBarVisible()) {
    scheduleFullscreenBarHide();
  }
}

function onPointerActivity(event) {
  if (event && Number.isFinite(event.clientY)) lastPointerY = event.clientY;
  scheduleIdle();
  handleFullscreenPointer();
}

function boot() {
  if (!gameId) {
    showError('地址缺少滚榜会话 ID，请从配置中心重新点击「开始滚榜」。');
    return;
  }
  fetch(`${runtime.base}/data`, {
    cache: 'no-store', headers: { 'X-Resolver-Control': controlToken || '' },
  })
    .then(async (res) => {
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || `服务器返回 ${res.status}`);
      }
      return res.json();
    })
    .then(async (data) => {
      game = data;
      stops = awardStops(game);
      steps = Array.isArray(data.steps) ? data.steps : [];
      actionIndices = actionIndicesFor(steps);
      revision = data.playback?.revision ?? 0;
      actionPos = -1;
      for (const team of data.contest?.teams || []) teamById.set(team.id, team);
      if (isPreview) playerRoot.classList.add('preview');
      hudContest.textContent = data.contest?.formalName || data.contest?.name || 'ICPC Resolver';
      hudPreview.hidden = !isPreview;

      try {
        await document.fonts.load('700 40px "Helvetica Plain"');
        await document.fonts.ready;
      } catch {
        /* fall back to system fonts */
      }

      window.ICPCResolver = {
        get game() {
          return game;
        },
        get steps() {
          return steps;
        },
        get index() {
          return index;
        },
        get view() {
          return view;
        },
        next: goNext,
        prev: goPrevious,
        reset: restart,
        jumpTo(i) {
          return jumpTo(i);
        },
      };
      playerRoot.classList.remove('is-loading');
      loadingEl.hidden = true;
      hudEl.hidden = isPreview;
      controlsWrap.hidden = isPreview;
      if (!isPreview) {
        controlsEl.hidden = false;
        scheduleIdle();
      }

      if (isPreview) {
        // Frozen scoreboard, no auto-advance: the host page drives next/prev.
        const target = steps.findIndex((s) => s.type === 'presentation' && s.screen === 'scoreboard');
        rebuildTo(target >= 0 ? target : 0);
      } else {
        rebuildTo(data.playback?.index ?? startTarget());
        toast(data.playback?.revision > 0 ? '已恢复保存进度，等待手动继续' : game.options.autoplay
          ? `点击 / → 开始推进，自动阶段使用 ${game.options.autoplaySpeed ?? 4} 倍速；Esc 暂停`
          : '手动模式：点击 / → 下一步，右键 / ← 上一步');
        const media = document.getElementById('hud-media');
        if (media && data.mediaReport) {
          media.hidden = false;
          media.textContent = data.mediaReport.failed ? `素材 ${data.mediaReport.failed} 项回退` : '素材已就绪';
          media.title = `已缓存 ${data.mediaReport.cached} / ${data.mediaReport.total} 张；下载失败的校徽使用 ICPC Logo，照片使用赛事 Logo。可回配置中心检查后重新开始。`;
        }
        syncPlayback();
      }
      view?.resize?.();
    })
    .catch((err) => {
      console.error(err);
      showError(err.message || '加载滚榜会话失败');
    });
}

function frame(now) {
  const dt = Math.min(64, Math.max(0, now - lastFrame));
  lastFrame = now;
  if (view) {
    view.update(dt);
    view.render(now);
  }
  requestAnimationFrame(frame);
}

// Wiring ---------------------------------------------------------------

btnRestart?.addEventListener('click', restart);
btnPrev?.addEventListener('click', () => goPrevious());
document.getElementById('btn-award')?.addEventListener('click', goToAward);
btnNext?.addEventListener('click', goNext);
btnHelp?.addEventListener('click', () => toggleHelp());
document.getElementById('help-close')?.addEventListener('click', () => toggleHelp(false));
btnFull?.addEventListener('click', toggleFullscreen);
btnFast?.addEventListener('click', () => fastForward.active ? stopAdvance() : fastForward.start());

// Stage clicks follow ICPC Tools: click/tap advances, right click goes back one step.
const stageEl = document.getElementById('stage');
stageEl?.addEventListener('pointerdown', (event) => {
  if (playerRoot.classList.contains('display-open') || event.button !== 0 || event.ctrlKey || event.metaKey) return;
  goNext();
});
window.addEventListener('resolver-calibrating', () => stopAdvance());
window.addEventListener('offline', () => connectionStatus(false));
window.addEventListener('online', () => syncPlayback());
window.addEventListener('pagehide', () => { stopAdvance(); clearTimeout(pollTimer); });
window.addEventListener('pageshow', (event) => { if (event.persisted && game && !ended) syncPlayback(); });
stageEl?.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  if (!playerRoot.classList.contains('display-open')) goPrevious(true);
});
document.getElementById('confirm-ok')?.addEventListener('click', () => closeConfirm(true));
document.getElementById('confirm-cancel')?.addEventListener('click', () => closeConfirm(false));
confirmEl?.addEventListener('click', (event) => { if (event.target === confirmEl) closeConfirm(false); });

// Keep the fullscreen control bar up while it is hovered or focused.
controlsEl?.addEventListener('pointerenter', () => {
  if (document.fullscreenElement) setFullscreenBarVisible(true);
});
controlsEl?.addEventListener('pointerleave', () => {
  if (document.fullscreenElement) scheduleFullscreenBarHide();
});
controlsEl?.addEventListener('focusin', () => {
  if (document.fullscreenElement) setFullscreenBarVisible(true);
});
controlsEl?.addEventListener('focusout', () => {
  if (document.fullscreenElement) scheduleFullscreenBarHide();
});

helpEl?.addEventListener('click', (event) => {
  if (event.target === helpEl) toggleHelp(false);
});

function isTypingTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable
  );
}

window.addEventListener('pointermove', onPointerActivity, { passive: true });
window.addEventListener('pointerdown', onPointerActivity, { passive: true });
window.addEventListener('keydown', (event) => {
  if (event.defaultPrevented) return;
  const key = event.key;
  if (confirmEl && !confirmEl.hidden) {
    // Only Escape/Tab work here; remote clickers must not confirm a reveal.
    if (key === 'Escape') { event.preventDefault(); closeConfirm(false); }
    else if (key !== 'Tab' && !(event.target instanceof Element && event.target.closest('#confirm button'))) event.preventDefault();
    return;
  }
  if (isTypingTarget(event.target)) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (key === 'Escape') {
    if (fastForward.active) { stopAdvance(); toast('自动滚榜已暂停'); return; }
    if (!helpEl.hidden) {
      toggleHelp(false);
      return;
    }
    if (document.fullscreenElement) {
      document.exitFullscreen?.();
      return;
    }
    return;
  }
  if (!helpEl.hidden) {
    if (key === '?' || key === '/' || key === 'h' || key === 'H') toggleHelp(false);
    return;
  }
  if ([' ', 'Enter'].includes(key) && event.target instanceof Element && event.target.closest('button, a')) return;
  if (key === ' ' || key === 'Spacebar') {
    event.preventDefault();
    if (event.shiftKey) { if (!event.repeat) goPrevious(true); }
    else goNext();
    return;
  }
  // ICPC Tools: space/f forward, r/b back. F keeps the browser fullscreen toggle here.
  if (['ArrowRight', 'ArrowDown', 'PageDown', 'Enter', 'n', 'N'].includes(key)) {
    event.preventDefault();
    goNext();
    return;
  }
  if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'r', 'R', 'b', 'B'].includes(key)) {
    event.preventDefault();
    if (!event.repeat) goPrevious(true);
    return;
  }
  if (key.toLowerCase() === 'j') { event.preventDefault(); if (!event.repeat) goToAward(); return; }
  if (key.toLowerCase() === 'g' || key.toLowerCase() === 'i') { event.preventDefault(); if (!event.repeat) jumpTeams(key.toLowerCase() === 'g' ? 10 : -10); return; }
  if (key === 'Home' || key === '0') {
    event.preventDefault();
    restart();
    return;
  }
  if (key === 'End') {
    event.preventDefault();
    jumpToEnd();
    return;
  }
  if (key === 'f' || key === 'F') {
    toggleFullscreen();
    return;
  }
  if (key === '?' || key === '/' || key === 'h' || key === 'H') {
    toggleHelp();
  }
});

document.addEventListener('fullscreenchange', () => {
  const fullscreen = Boolean(document.fullscreenElement);
  playerRoot.classList.toggle('is-fullscreen', fullscreen);
  clearTimeout(fsBarTimer);
  fsBarTimer = 0;
  playerRoot.classList.remove('fs-bar-visible');
  if (fullscreen && lastPointerY != null && lastPointerY >= window.innerHeight - FS_HOT_ZONE_PX) {
    // The pointer is usually still on the fullscreen button: keep the bar up
    // until the pointer leaves the bottom edge.
    setFullscreenBarVisible(true);
  }
  view?.resize?.();
});

document.addEventListener('visibilitychange', () => {
  lastFrame = performance.now();
});

boot();
requestAnimationFrame(frame);
