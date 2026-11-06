// server/match/match/unitePhase.js — Match methods: 联防 glue (the rules: server/match/unite.js) — the UNITE phase in
// both modes (the 联防 field from the helpers' carried state and the leakers' enemies), its end, and the leakers' live
// counts (_uniteLeft, user playtest #6 item 7; _uniteTick in the server-run mode).
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { PHASE, GEO } from '../../../shared/constants.js';
import { deriveSeed } from '../../sim/rng.js';
import { combineUniteResults, uniteBattleOpts, uniteSurvivors } from '../unite.js';
import { FieldRunner, timelineAt, uniteBillBounds } from '../fields.js';
import { uniteLeft } from '../../sim/spec.js';
import { FLOW_TICKER_PRIORITY, DELAYS } from './common.js';
import { msg } from '../../../shared/i18n.js';
import { onStartUnite } from '../botEmotes.js';

const fallbackGroups = (plan) => Array.isArray(plan.groups) ? plan.groups : [plan];

export class MatchUnite {
  startUnite(plan) {
    if (this.clientCombat) { this._startUniteClient(plan); return; }
    this.phase = PHASE.UNITE;
    this.unitePlan = plan;
    const limit = this.wave ? this.wave.timeLimit : 60;
    this.fields = fallbackGroups(plan).map((group) => ({
      fieldId: group.fieldId || 'u', groupId: group.id || null, kind: 'unite',
      players: group.helpers.map((p) => p.playerId), battle: this.newBattle(this._uniteOpts(group, limit)), live: true,
    }));
    this.deadline = this.sched.instant ? 0 : this.sched.now() + Math.round((limit / this.gameSpeed) * 1000);
    this._defaultWatch();
    this.markPublic();
    this.tickerText(msg('联防阶段：{names} 迎战突破防线的敌人', { names: plan.helpers.map((p) => p.name) }), FLOW_TICKER_PRIORITY);
    onStartUnite(this, plan); // an AI helper says "合作愉快" once on the open of a 联防 (enabled by default; SP_BOT_EMOTES=0 silences it)
    this._uniteLeftKey = null;
    this.runner = new FieldRunner(this, this.fields, {
      onTick: (runner) => this._uniteTick(runner),
      onDone: (runner) => {
        if (this.phase !== PHASE.UNITE) return;
        for (const f of this.fields) {
          const res = runner.resultOf(f);
          this._collectSimErrors(f, res);
          f.live = false;
        }
        this.deadline = 0;
        this.markPublic();
        const result = plan.groups ? combineUniteResults(plan, this.fields) : (runner.resultOf(this.fields[0]) || null);
        this.later(this.scaled(DELAYS.COMBAT_END), () => this.settle(plan, result));
      },
    });
    this.runner.start();
  }

  /**
   * Battle options of the 联防 field (helpers' carried end state, the leakers' enemies) on the round's battlefield, its
   * terrain, crates, water, devices and runes included (unite.js header; the owner's decision of 2026-10-07 — 0.2.0's
   * escaped-level map is withdrawn). The field meta and the client-run spec carry the match stageId, so every viewer
   * draws the battlefield the boards stand on.
   */
  _uniteOpts(plan, limit) {
    const { wave, players } = uniteBattleOpts(this, plan, limit);
    const fieldId = plan.fieldId || 'u';
    return {
      seed: deriveSeed(this.seed, plan.id ? `u:${this.round}:${plan.id}` : `u:${this.round}`),
      kind: 'unite',
      modeId: this.modeId,
      round: this.round,
      stageId: this.stageId,
      rect: { ...GEO.UNITE_RECT },
      timeLimit: limit,
      players,
      spawns: this._sanitizeSpawns(wave.spawns),
      routes: wave.routes,
      sharedBoss: null,
      flags: { layerGainsEnabled: false, ...this.gd.dp },
      fieldId,
      // leaked enemies re-enter with the stats they had: the round template's stat overrides apply again
      enemyOverrides: this.wave && this.wave.overrides ? this.wave.overrides : {},
      waveId: wave.templateId,
    };
  }

  _startUniteClient(plan) {
    this.phase = PHASE.UNITE;
    this.unitePlan = plan;
    const limit = this.wave ? this.wave.timeLimit : 60;
    const fields = fallbackGroups(plan).map((group) => this._ccField({
      fieldId: group.fieldId || 'u', kind: 'unite', players: group.helpers.map((p) => p.playerId), opts: this._uniteOpts(group, limit),
    }));
    fields.forEach((f, i) => { f.groupId = fallbackGroups(plan)[i].id || null; });
    this.deadline = this.sched.instant ? 0 : this.sched.now() + Math.round((limit / this.gameSpeed) * 1000);
    this.watchers.clear();
    this._launch(fields);
    // Each helper pair owns one fallback field; all other players observe the first field by default.
    for (const ps of this._viewers()) {
      const f = fields.find((field) => field.players.includes(ps.playerId)) || fields[0];
      if (!f) continue;
      this.watchers.set(ps.playerId, f.fieldId);
      this._sendStart(ps.playerId, f, { watch: !f.players.includes(ps.playerId) });
    }
    this.markPublic();
    this.tickerText(msg('联防阶段：{names} 迎战突破防线的敌人', { names: plan.helpers.map((p) => p.name) }), FLOW_TICKER_PRIORITY);
  }

  _finishUniteClient() {
    if (this.phase !== PHASE.UNITE) return;
    for (const f of this.fields) this._collectSimErrors(f, f.result);
    this._stopClientCombat();
    for (const f of this.fields) f.live = false;
    this.deadline = 0;
    this.markPublic();
    const plan = this.unitePlan;
    const result = plan.groups ? combineUniteResults(plan, this.fields) : (this.fields[0]?.result || null);
    this.later(this.scaled(DELAYS.COMBAT_END), () => this.settle(plan, result));
  }

  /**
   * 联防 (user playtest #6 item 7; PRTS 卫戍协议/帮助 "防卫失败的玩家可通过上方信息栏确认自身所属敌人的剩余数量"): how many of
   * a leaker's enemies are still standing on the 联防 field — not spawned yet, alive, or through the objective again —
   * plus its leaks that could not re-enter: what settle() charges it (before the per-round cap) if the 联防 ended now.
   * It falls as the helpers strike them down; a split or a summon raises nothing (a 联防 field tags its runtime spawns
   * `uniteRuntime`, spawns.js — they never crossed the leaker's own goal, so they are neither billed nor shown here).
   * Live from the field (client run: the authority's b.progress `left`; server run: the headless timeline on the field
   * clock, or the streamed battle itself), clamped to what the escaped wave sent that leaker (fields.js uniteBillBounds:
   * keySourceCounts only — the same set settlement bills); exact once the field has its result (unite.js
   * uniteSurvivors; a synthetic result charges the own leaks, as settle()). null for anyone but a leaker of the running
   * 联防.
   * @returns {number|null}
   */
  _uniteLeft(ps) {
    const plan = this.unitePlan;
    if (this.phase !== PHASE.UNITE || !plan || !ps || !plan.leakers.includes(ps)) return null;
    const pid = ps.playerId;
    if (Array.isArray(plan.groups)) {
      let total = plan.notReentered.get(pid) || 0;
      for (const group of plan.groups) {
        const sent = group.leaked.filter((l) => l.sourcePlayerId === pid).length;
        if (!sent) continue;
        const f = this.fields.find((x) => x && x.groupId === group.id) || null;
        if (!f) { total += sent; continue; }
        let res = null;
        if (f.cc) res = f.done ? f.result : null;
        else if (f.battle && f.battle.finished) { try { res = f.battle.result(); } catch { res = null; } }
        if (res) {
          if (res.synthetic) total += sent;
          else total += uniteSurvivors({ groups: [group], notReentered: new Map() }, { groups: [{ id: group.id, result: res }] }).get(pid) || 0;
          continue;
        }
        let live = null;
        if (f.cc) {
          if (f.mode === 'server' && f.timeline) {
            const sample = timelineAt(f.timeline, this._fieldElapsed(f));
            live = sample && sample[4] && typeof sample[4] === 'object' ? sample[4] : null;
          } else live = f.progress && f.progress.left && typeof f.progress.left === 'object' ? f.progress.left : null;
        } else if (f.battle) {
          try { live = uniteLeft(f.battle); } catch { live = null; }
        }
        const bounds = uniteBillBounds(group.leaked, this.gd);
        const bound = bounds.get(pid) ?? sent;
        total += live ? Math.min(bound, Math.max(0, Math.trunc(Number(live[pid]) || 0))) : sent;
      }
      return total;
    }
    const f = this.fields.find((x) => x && x.kind === 'unite') || null;
    let res = null;
    if (f && f.cc) res = f.done ? f.result : null;
    else if (f && f.battle && f.battle.finished) { try { res = f.battle.result(); } catch { res = null; } }
    if (res && res.synthetic) {
      const own = this.lastResults.get(pid);
      return own && Array.isArray(own.leaked) ? own.leaked.filter((l) => l && l.counted !== false).length : 0;
    }
    if (res) return uniteSurvivors(plan, res).get(pid) || 0;
    const sent = plan.leaked.filter((l) => l.sourcePlayerId === pid).length;
    let live = null;
    if (f && f.cc) {
      if (f.mode === 'server' && f.timeline) {
        // the sample is [gt, killed, total, resolved(, left)]: a 联防 sample's `left` is its 5th element
        const sample = timelineAt(f.timeline, this._fieldElapsed(f));
        live = sample && sample[4] && typeof sample[4] === 'object' ? sample[4] : null;
      } else live = f.progress && f.progress.left && typeof f.progress.left === 'object' ? f.progress.left : null;
    } else if (f && f.battle) {
      try { live = uniteLeft(f.battle); } catch { live = null; }
    }
    if (!this._uniteBounds || this._uniteBounds.plan !== plan) this._uniteBounds = { plan, bounds: uniteBillBounds(plan.leaked, this.gd) };
    const bound = this._uniteBounds.bounds.get(pid) ?? sent;
    const standing = live ? Math.min(bound, Math.max(0, Math.trunc(Number(live[pid]) || 0))) : sent;
    return standing + (plan.notReentered.get(pid) || 0);
  }

  /** Server-run 联防 (streaming mode): refresh m.public about once a game second when a leaker's count moved. */
  _uniteTick(runner) {
    const fields = runner && runner.fields ? runner.fields.filter((f) => f && f.battle) : [];
    if (!fields.length || runner.ticks % 30 !== 0) return;
    let key = '';
    try { key = JSON.stringify(fields.map((f) => [f.fieldId, uniteLeft(f.battle)])); } catch { key = ''; }
    if (key === this._uniteLeftKey) return;
    this._uniteLeftKey = key;
    this.markPublic();
  }
}
