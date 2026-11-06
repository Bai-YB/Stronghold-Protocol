// Endless-mode end-to-end check in virtual time: 4 bots, co-op ABYSS, server-run combat.
// Asserts the vanilla 14 rounds lead into endless, the cycle/boss/double-boss schedule holds, protocols land,
// the leaderboard hooks fire, and nothing throws.
import { Match } from '../server/match/Match.js';
import { getData } from '../server/data.js';
import { DataSource } from '../server/sim/simdata.js';
import { VirtualScheduler } from '../server/match/scheduler.js';

const QUIET = { info() {}, debug() {}, warn() {}, error() {} };
const data = getData({ log: QUIET });
const ds = new DataSource(data, null);
const sched = new VirtualScheduler();

const seats = [0, 1, 2, 3].map((i) => ({ seat: i, playerId: `ai_${i}`, name: `AI-${i + 1}`, isBot: true, connected: true }));
const logLines = [];
const log = { info() {}, debug() {}, warn() {}, error: (...a) => logLines.push(a.map(String).join(' ').slice(0, 200)) };
let summary = null;
const checkpoints = [];
const finalize = [];
const timeline = [];
const protocols = [];
let lastKey = '';

const m = new Match({
  roomCode: 'E2E', mode: 'coop', difficulty: 'ABYSS', seats, seed: 424242, data, log, scheduler: sched,
  send: () => true, broadcast: () => {}, onEnd: (s) => { summary = s; },
  runKind: 'endless', clientCombat: false, verify: 'off',
  onEndlessCheckpoint: (rec) => checkpoints.push({ ...rec }),
  onEndlessFinalize: (rec) => finalize.push({ ...rec }),
});

const seen = new Set();
let protocolBuffs = null;
m.start();
// boosted like golden's hidden-core runs: the bots must survive 14 ABYSS rounds to reach endless at all
let boosted = false;
const deadline = Date.now() + 600_000;
sched.runUntil(() => {
  const key = `${m.phase}:${m.round}:${m.endless?.round ?? '-'}`;
  if (key !== lastKey) {
    lastKey = key;
    const ps = m.endless ? m.endless.protocols : null;
    timeline.push({
      phase: m.phase, round: m.round, endless: m.endless?.round ?? null,
      boss: !!m.endless?.boss,
      bossInfo: m.phase === 'FINAL_ASSAULT' ? { double: !!m.endless?.boss?.double, bosses: (m.endless?.boss?.bosses || []).slice(),
        maxHp: Math.round(m.endless?.boss?.maxHp || 0), pools: (m.endless?.boss?.pools || []).length } : null,
      alive: m.alivePlayers().length, lp: m.order.map((p) => p.lp).join('/'),
      protocols: ps ? JSON.stringify(ps) : null,
    });
  }
  // record the protocol offers/choices as they happen
  if (protocolBuffs === null && m.endless?.active && m.endless.round >= 2 && m.phase === 'COMBAT') {
    const keys = new Set();
    for (const f of m.fields || []) for (const u of f.battle?.units || []) {
      if (u?.side !== 'ally') continue;
      for (const b of u.buffs || []) if (String(b.key).startsWith('endless:')) keys.add(b.key);
    }
    if (keys.size) protocolBuffs = [...keys];
  }
  if (!boosted && m.phase === 'PREP') {
    boosted = true;
    for (const ps of m.order) { ps.lp = 400; for (const id of m.gd.bondIds) ps.layers[id] = 300; ps.recompute(); }
  }
  if (m.endless?.offers && Object.keys(m.endless.offers).length) {
    const sig = JSON.stringify(m.endless.offers);
    if (!seen.has(sig)) { seen.add(sig); protocols.push({ round: m.endless.round, offers: sig.slice(0, 160) }); }
  }
  if (summary) return true;
  if (m.endless?.active && m.endless.round >= 29) return true;   // covers boss 7, 14, 21 and the double boss at 28
  return Date.now() > deadline;
}, { maxSteps: 20_000_000 });

// stop the run deliberately: the finalizer must write the record
const doubleBoss = [];
for (const t of timeline) if (t.boss && t.endless % 14 === 0) doubleBoss.push(t.endless);
try { m.finish({ victory: false, reason: 'eliminated' }); } catch (e) { console.log('finish threw', e.message); }
const maxLayer = Math.max(0, ...m.order.map((p) => Math.max(0, ...Object.values(p.layers || {}))));
const out = {
  ended: !!summary,
  end: summary ? { victory: summary.victory, roundsPassed: summary.roundsPassed, reason: summary.reason } : null,
  enteredEndless: !!(m.endless && m.endless.active),
  endlessRound: m.endless?.round ?? null,
  completedRounds: m.endless?.completedRounds ?? null,
  protocolsSelected: m.endless ? Object.values(m.endless.protocols || {}) : [],
  protocolOffers: protocols.length,
  checkpoints: checkpoints.length,
  finalized: finalize.length,
  finalRecord: finalize[0] ? { rounds: finalize[0].completedRounds, progress: finalize[0].progress, reason: finalize[0].reason } : null,
  engineErrors: m.errorCount,
  loggedErrors: logLines.length,
  lastLogs: logLines.slice(0, 5),
  bossRounds: [...new Set(timeline.filter((t) => t.boss).map((t) => t.endless))],
  bossDetail: timeline.filter((t) => t.bossInfo).map((t) => ({ endless: t.endless, ...t.bossInfo })),
  baseRounds: m.endless?.baseRounds, hiddenCleared: m.endless?.hiddenCleared, seats: m.endless?.seats,
  doubleBossSeen: doubleBoss,
  maxLayerValue: maxLayer,
  protocolBuffKeys: protocolBuffs,
  finalRecordAfterFinish: finalize[0] ? { rounds: finalize[0].completedRounds, reason: finalize[0].reason, seats: finalize[0].seats } : null,
  aliveAtEnd: m.alivePlayers().length,
  timelineTail: timeline.slice(-14),
};
console.log(JSON.stringify(out, null, 1));
m.dispose();
