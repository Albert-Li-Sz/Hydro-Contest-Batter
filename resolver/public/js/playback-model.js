/** Visible manual actions; shared by presenter and server validation. */
export function actionIndicesFor(steps) {
  const firstBoard = steps.findIndex((step) => step.type === 'presentation' && step.screen === 'scoreboard');
  return steps.flatMap((step, i) => {
    if (step.type === 'delay' || step.type === 'pause') return [];
    if (step.role === 'setup') return [];
    if (firstBoard >= 0 && i < firstBoard && step.type !== 'presentation') return [];
    return [i];
  });
}

export function startIndexFor(game) {
  const screen = game.options?.startScreen === 'scoreboard' ? 'scoreboard' : 'splash';
  const index = game.steps.findIndex((step) => step.type === 'presentation' && step.screen === screen);
  return index >= 0 ? index : (actionIndicesFor(game.steps)[0] ?? -1);
}

/** Reuse the engine's pacing at the selected automatic playback rate. */
export function fastForwardDelayFor(game, index, nextIndex) {
  const current = game.steps[index];
  if (current?.role === 'intro-bottom') return current.durationMs || 650;
  if (current?.role === 'manual-entry') return 80;
  let delay = 0;
  for (let i = index + 1; i < nextIndex; i++) {
    if (game.steps[i].type === 'delay') delay += game.steps[i].ms;
  }
  if (!delay) delay = current?.type === 'scroll' ? 160 : 400;
  // Persisted older sessions have no autoplaySpeed; retain their duration factor.
  const factor = game.options?.autoplaySpeed == null ? Number(game.options?.speedFactor) || 1 : 1;
  return Math.max(16, Math.round(delay * factor / (current?.speedMultiplier || 1)));
}

export function nextAutomaticAction(game, actions, position) {
  if (game.options?.autoplay === false || position < 0) return null;
  const index = actions[position];
  const nextIndex = actions[position + 1];
  if (nextIndex == null) return null;
  const step = game.steps[index];
  const enteringManual = step?.role === 'manual-entry' && game.steps[nextIndex]?.type === 'selectTeam';
  if (step?.phase !== 'fast' && !enteringManual && !(step?.role === 'intro-bottom' && game.steps[nextIndex]?.phase === 'fast')) return null;
  return { index: nextIndex, delay: fastForwardDelayFor(game, index, nextIndex) };
}

/** Reveal order shared with the host's printable script. */
export function tierOrder(award) {
  const id = award.id;
  if (id === 'honors') return 1;
  if (id === 'high-honors') return 2;
  if (id === 'highest-honors') return 3;
  if (award.awardType === 'medal' || /^medal-|-medal$/.test(id)) return /bronze/.test(id) ? 4 : /silver/.test(id) ? 5 : 6;
  if (/^podium-|^rank-|^winner$/.test(id) || award.awardType === 'winner' || award.awardType === 'rank') return 7;
  return 0;
}

export function awardStops(game) {
  const tiers = new Map();
  for (const award of game.contest.awards || []) {
    const tier = tierOrder(award);
    if (!tier || award.displayMode === 'ignore') continue;
    for (const id of award.teamIds) {
      if (!tiers.has(id)) tiers.set(id, new Set());
      tiers.get(id).add(tier);
    }
  }
  const actions = actionIndicesFor(game.steps);
  const reached = new Set();
  const stops = new Set();
  for (let i = 1; i < actions.length; i++) {
    const step = game.steps[actions[i]];
    if (step.type !== 'selectTeam' || step.teamIds?.length !== 1) continue;
    for (const tier of tiers.get(step.teamIds[0]) || []) {
      if (!reached.has(tier)) stops.add(actions[i - 1]);
      reached.add(tier);
    }
  }
  return [...stops];
}

export function nextAwardStop(game, actions, position, stops = awardStops(game)) {
  return stops.find(index => index > (actions[position] ?? -1)) ?? null;
}

export function confirmPrevious(armedAt, now) {
  return armedAt !== null && now >= armedAt && now - armedAt <= 1500;
}
