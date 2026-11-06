// Endless progression, protocol offers, life pool handling and server-owned score checkpoints.
import { BOND_LAYER_CAP, PHASE, layerGainRoom } from '../../../shared/constants.js';
import { createRng, deriveSeed } from '../../sim/rng.js';
import { ENDLESS_RULES_VERSION, ENDLESS_PROTOCOLS, endlessGrowth, endlessAffix, pickEndlessProtocols, isEndlessBoss, isEndlessDoubleBoss } from '../endless.js';
import { DELAYS, FLOW_TICKER_PRIORITY } from './common.js';

export class MatchEndless {
  endlessActive() { return this.runKind === 'endless' && !!this.endless?.active; }

  endlessGrowthForCurrent({ boss = false } = {}) {
    return endlessGrowth(Math.max(1, this.endless?.round || 1), { boss, players: this.endless?.seats || this.order.length });
  }

  endlessPublic() {
    if (!this.endless) return null;
    const round = this.endless.round || 0;
    const nextBoss = round < 1 ? 7 : (Math.floor(round / 7) + 1) * 7;
    return {
      active: this.endless.active, round, cycle: round > 0 ? Math.floor((round - 1) / 7) + 1 : 0,
      nextBoss: this.endless.active ? (isEndlessBoss(round) ? round : nextBoss) : 7,
      affix: this.endless.affix, protocols: { ...this.endless.protocols },
      offers: { ...this.endless.offers }, protocolUntil: this.endless.protocolUntil,
      completedRounds: this.endless.completedRounds, saving: this.endless.saving,
      boss: this.endless.boss ? { ...this.endless.boss } : null,
    };
  }

  beginEndless(hiddenCleared = false) {
    if (!this.endless || this.ended) return;
    this.endless.active = true;
    this.endless.round = 0;
    this.endless.completedRounds = 0;
    this.endless.progress = 0;
    this.endless.baseRounds = this.gd.bossRound + (hiddenCleared ? 1 : 0);
    this.endless.hiddenCleared = hiddenCleared === true;
    this.endless.startedAt = this.sched.now();
    this.endless.usedAI ||= this.order.some((p) => p.isBot || p.aiTakeoverRound != null || p.autoplay);
    this.teamLp = null;
    this.bossPool = null;
    this.endlessBossPools = null;
    this._finalEnding = null;
    for (const ps of [...this.alivePlayers()]) {
      if (ps.lp <= 0) { ps.eliminate(this.round); continue; }
      for (const [bondId, value] of Object.entries(ps.layers || {})) {
        if (Number.isFinite(value) && value > BOND_LAYER_CAP) ps.layers[bondId] = BOND_LAYER_CAP;
      }
      const base = Math.max(1, this.gd.startLp(ps.bandId));
      ps.endlessMaxLp = Math.max(base, ps.lp);
      ps.dirty();
      this.endless.entryLp[ps.playerId] = ps.lp;
    }
    this.phase = PHASE.ENDLESS_TRANSITION;
    this.setDeadline(3, () => this.offerEndlessProtocols('entry'));
    this.markPublic();
    this.tickerText('无尽协议已启动', FLOW_TICKER_PRIORITY);
  }

  offerEndlessProtocols(reason = 'boss') {
    if (!this.endless || !this.alivePlayers().length) return;
    this.phase = PHASE.ENDLESS_OFFER;
    this.endless.reason = reason;
    const seed = deriveSeed(this.seed, `endless:protocol:${this.endless.completedRounds}:${reason}`);
    this.rngEndlessOffer = createRng(seed);
    this.endless.offers = {};
    for (const ps of this.alivePlayers()) {
      const options = pickEndlessProtocols(this.rngEndlessOffer);
      this.endless.offers[ps.playerId] = options.map(({ id, name, desc }) => ({ id, name, desc }));
    }
    this.setDeadline(30, () => this.resolveEndlessOffers(true));
    this.markPublic();
  }

  pickEndlessProtocol(ps, id) {
    if (!this.endless || this.phase !== PHASE.ENDLESS_OFFER || !ps.alive) return { error: 'WRONG_PHASE' };
    const choices = this.endless.offers[ps.playerId] || [];
    const selected = choices.find((x) => x.id === id);
    if (!selected) return { error: 'BAD_TARGET' };
    this.endless.protocols[ps.playerId] = selected.id;
    this.endless.offers[ps.playerId] = [];
    if (this.alivePlayers().every((p) => this.endless.protocols[p.playerId] && !(this.endless.offers[p.playerId] || []).length)) {
      this.resolveEndlessOffers(false);
    } else this.markPublic();
    return { ok: true };
  }

  resolveEndlessOffers(timeout = false) {
    if (!this.endless || this.phase !== PHASE.ENDLESS_OFFER) return;
    this.setDeadline(0);
    for (const ps of this.alivePlayers()) {
      if (!this.endless.protocols[ps.playerId] || (this.endless.offers[ps.playerId] || []).length) {
        const options = this.endless.offers[ps.playerId] || [];
        let selected = options.find((x) => x.id === 'assault') || options[0];
        if (ps.botControlled && options.length) {
          const wanted = ps.board.size >= 6 ? 'assault' : ps.bandId ? 'repair' : 'supply';
          selected = options.find((x) => x.id === wanted) || selected;
        }
        if (selected) this.endless.protocols[ps.playerId] = selected.id;
        this.endless.offers[ps.playerId] = [];
      }
    }
    this.endless.protocolUntil = (this.endless.round || 0) + 7;
    this.bossPool = null;
    this.endlessBossPools = null;
    this.teamLp = null;
    this.phase = PHASE.ROUND_START;
    this.markPublic();
    const next = this.gd.lastRound + (this.endless.round || 0) + 1;
    this.later(timeout ? 0 : this.scaled(DELAYS.SETTLE), () => this.startRound(next));
  }

  noteEndlessRoundComplete(progress = 1) {
    if (!this.endlessActive()) return;
    const round = this.endless.round;
    this.endless.completedRounds = Math.max(this.endless.completedRounds, round);
    this.endless.progress = Math.max(0, Math.min(1, Number(progress) || 0));
    this._persistEndless(false);
  }

  updateEndlessWaveProgress() {
    if (!this.endlessActive() || !Array.isArray(this.fields) || !this.fields.length) return this.endless?.progress || 0;
    let resolved = 0;
    let total = 0;
    for (const field of this.fields) {
      const battle = field?.battle;
      if (battle && Number.isFinite(battle.total) && battle.total > 0) {
        total += battle.total;
        resolved += Math.min(battle.total, Math.max(0, Number(battle.resolved) || 0));
      }
    }
    if (total > 0) this.endless.progress = Math.max(0, Math.min(1, resolved / total));
    return this.endless.progress;
  }

  _endlessRecord(finalized = false, reason = 'checkpoint') {
    if (!this.endless || this.endless.completedRounds < 1) return null;
    return {
      runId: this.endlessRunId, rulesVersion: ENDLESS_RULES_VERSION, seats: this.endless.seats,
      usedAI: this.endless.usedAI || this.order.some((p) => p.isBot || p.aiTakeoverRound != null || p.autoplay),
      completedRounds: this.endless.completedRounds, progress: this.endless.progress,
      durationMs: Math.max(0, Math.trunc(this.sched.now() - this.endless.startedAt)),
      endedAt: Date.now(), reason, finalized,
      lineup: this.order.map((p) => `${p.bandId || 'unpicked'}:${Object.values(p.layers || {}).reduce((a, b) => a + (Number(b) || 0), 0)}`),
    };
  }

  _persistEndless(finalized = false, reason = 'checkpoint') {
    const record = this._endlessRecord(finalized, reason);
    if (!record) return;
    const callback = finalized ? this.onEndlessFinalizeFn : this.onEndlessCheckpointFn;
    if (!callback) { this.endless.saving = 'pending'; return; }
    let result;
    try { result = callback(record); } catch { result = { ok: false }; }
    this.endless.saving = result?.ok === true ? 'saved' : 'pending';
    if (result?.ok !== true && !this.endless.retryTimer && !this.ended) {
      this.endless.retryTimer = this.later(5000, () => { this.endless.retryTimer = null; this._persistEndless(finalized, reason); });
    }
  }

  _finalizeEndless(reason) {
    if (!this.endless || this.endless.finalized) return;
    if (reason === 'abandoned') this.endless.progress = 0;
    else if (this.phase === PHASE.COMBAT) this.updateEndlessWaveProgress();
    else if (this.bossPool && (this.phase === PHASE.FINAL_ASSAULT || this.phase === PHASE.HIDDEN_CORE)) {
      this.endless.progress = this.bossPool.maxHp > 0 ? Math.max(0, Math.min(1, 1 - this.bossPool.hp / this.bossPool.maxHp)) : 0;
    }
    this.endless.finalized = true;
    const record = this._endlessRecord(true, reason);
    this.endless.finalRecord = record;
    if (record) this._persistEndless(true, reason);
  }

  endlessBossIds() {
    const all = ['boss_1', 'boss_2', 'boss_3', 'boss_4', 'boss_5', 'boss_6', 'boss_7'];
    const r = this.endless?.round || 1;
    let ids;
    if (isEndlessDoubleBoss(r)) {
      const combos = [['boss_2', 'boss_5'], ['boss_2', 'boss_7'], ['boss_5', 'boss_7']];
      ids = combos[Math.floor(r / 14 - 1) % combos.length];
    } else {
      const recent = Array.isArray(this.endless.lastBossIds) ? this.endless.lastBossIds : [this.endless.lastBossId];
      const choices = all.filter((id) => !recent.includes(id));
      ids = [choices[(Math.floor(r / 7) - 1) % choices.length] || all[0]];
    }
    this.endless.lastBossId = ids[0];
    this.endless.lastBossIds = ids.slice();
    return ids;
  }

  _endlessBossReward() {
    if (!this.endlessActive()) return;
    const alive = this.alivePlayers();
    if (!alive.length) return;
    const supply = 6 * alive.length;
    for (const ps of alive) ps.lp = Math.min(ps.endlessMaxLp || ps.lp, ps.lp + 4);
    let left = Math.max(0, supply - 4 * alive.length);
    let guard = left + 1;
    // loop-cap: `left` decreases every pass and starts at at most two LP per (max four) alive players.
    while (left > 0 && guard-- > 0) {
      const eligible = alive.filter((p) => p.lp < (p.endlessMaxLp || p.lp));
      if (!eligible.length) break;
      eligible.sort((a, b) => a.lp / Math.max(1, a.endlessMaxLp || a.lp) - b.lp / Math.max(1, b.endlessMaxLp || b.lp) || a.seat - b.seat);
      eligible[0].lp++; left--;
    }
    const reward = isEndlessDoubleBoss(this.endless.round) ? 12 : 8;
    for (const ps of alive) { ps.pendingFunds += reward; ps.stats.fundsGained += reward; ps.dirty(); }
    this.endless.boss = { defeated: true, bosses: this.endless.boss?.bosses || [], reward, supply };
    this.noteEndlessRoundComplete(0);
  }

  endlessProtocolMods(ps) {
    const id = this.endless?.protocols?.[ps.playerId];
    const valid = this.endless?.protocolUntil >= (this.endless?.round || 0);
    if (!valid || !id) return null;
    const effects = {
      assault: { atkMul: 1.15, hpMul: 0.90 }, repair: { hpMul: 1.20, healingTakenMul: 1.15, atkMul: 0.92 },
      supply: { aspd: -8 }, arts: { artsDealtMul: 1.18, physDealtMul: 0.90 },
      physical: { physDealtMul: 1.18, artsDealtMul: 0.90 }, control: { dmgDealtMul: 0.92 },
    };
    return { id, mods: effects[id] || {} };
  }

  _attachEndlessProtocol(battle) {
    if (!this.endlessActive() || !battle?.on) return;
    battle.on('deploy', ({ unit }) => {
      if (!unit || unit.side !== 'ally') return;
      const ps = this.players.get(unit.ownerId);
      const protocol = ps && this.endlessProtocolMods(ps);
      if (protocol && Object.keys(protocol.mods).length) battle.addBuff(unit, { key: `endless:${protocol.id}`, duration: Infinity, persist: true, mods: protocol.mods });
    }, { priority: -1000, owner: 'endless' });
    battle.on('beforeStatus', (ctx) => {
      if (!ctx || ctx.target?.side !== 'enemy' || ctx.source?.side !== 'ally') return;
      const ps = this.players.get(ctx.source.ownerId);
      if (ps && this.endlessProtocolMods(ps)?.id === 'control') ctx.duration *= 1.25;
    }, { priority: -1000, owner: 'endless' });
  }
}
