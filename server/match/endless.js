// Endless-mode rules and durable server leaderboard. Pure calculations are kept here so the growing curve can be
// simulated independently from Match and the persistent store never accepts a client-authored score.
import fs from 'node:fs';
import path from 'node:path';

export const ENDLESS_RULES_VERSION = 1;
export const ENDLESS_CYCLE = 7;
export const ENDLESS_AFFIXES = Object.freeze([
  Object.freeze({ id: 'cold', name: '耐寒', controlResist: 0.12 }),
  Object.freeze({ id: 'arcane', name: '抗术', resAdd: 10 }),
  Object.freeze({ id: 'armor', name: '物理装甲', defMul: 1.15 }),
  Object.freeze({ id: 'mobility', name: '机动', speedMul: 1.08 }),
  Object.freeze({ id: 'assault', name: '攻势强化', atkMul: 1.10 }),
]);
export const ENDLESS_PROTOCOLS = Object.freeze([
  Object.freeze({ id: 'assault', name: '强攻', desc: '攻击力 +15%；干员最大生命 −10%', generic: true }),
  Object.freeze({ id: 'repair', name: '战地修复', desc: '干员最大生命 +20%，受治疗 +15%；攻击力 −8%' }),
  Object.freeze({ id: 'supply', name: '急速补给', desc: '每回合额外资金 +3；攻速 −8' }),
  Object.freeze({ id: 'arts', name: '专注术式', desc: '术伤 +18%；物伤 −10%' }),
  Object.freeze({ id: 'physical', name: '动能压制', desc: '物伤 +18%；术伤 −10%' }),
  Object.freeze({ id: 'control', name: '稳定回路', desc: '控制时长 +25%；输出伤害 −8%' }),
]);

const finite = (n, d = 0) => Number.isFinite(Number(n)) ? Number(n) : d;

export function endlessProgress(round) {
  return Math.max(0, Number.isInteger(round) ? round : 0);
}

export function endlessCycle(round) {
  const n = Math.max(1, Number.isInteger(round) ? round : 1);
  return Math.floor((n - 1) / ENDLESS_CYCLE);
}

export function isEndlessBoss(round) {
  return Number.isInteger(round) && round > 0 && round % ENDLESS_CYCLE === 0;
}

export function isEndlessDoubleBoss(round) {
  return Number.isInteger(round) && round >= 28 && round % 14 === 0;
}

export function endlessGrowth(round, { boss = false, players = 1 } = {}) {
  const n = Math.max(1, Number.isInteger(round) ? round : 1);
  const x = n - 1;
  const k = Math.floor(x / ENDLESS_CYCLE);
  const plannedEnemies = Math.min(120, 40 + 2 * x);
  const requestedEnemies = 40 + 2 * x;
  const overflowMul = Math.max(1, requestedEnemies / 120);
  const controlResist = Math.min(boss ? 0.75 : 0.60, 0.10 + 0.05 * k + (boss ? 0.15 : 0));
  return {
    round: n, x, cycle: k,
    hpMul: (1 + 0.12 * x + 0.004 * x * x) * (1 + 0.06 * k) ** 2 * overflowMul,
    atkMul: 1 + 0.045 * x + 0.0006 * x * x,
    defMul: 1 + 0.02 * x,
    speedMul: Math.min(1.30, 1 + 0.003 * x),
    plannedEnemies,
    requestedEnemies,
    overflowMul,
    controlResist,
    magicResAdd: Math.min(35, 3 * k),
    liveEnemyCap: 60,
    income: 12 + Math.min(8, k),
    bossBonus: isEndlessDoubleBoss(n) ? 12 : 8,
  };
}

export function endlessAffix(round) {
  const cycle = endlessCycle(round);
  const idx = cycle % ENDLESS_AFFIXES.length;
  // Move by two positions each cycle so the five-item rotation does not repeat consecutively.
  return ENDLESS_AFFIXES[(idx * 2) % ENDLESS_AFFIXES.length];
}

export function endlessAffixFor(round) {
  return endlessAffix(round);
}

export function pickEndlessProtocols(rng = Math.random) {
  const available = [...ENDLESS_PROTOCOLS];
  const out = [];
  // loop-cap: choose at most three entries, removing one from this six-entry list each pass.
  while (out.length < 3 && available.length) {
    const idx = Math.min(available.length - 1, Math.floor(Math.max(0, Math.min(0.999999999, finite(rng(), 0))) * available.length));
    out.push(available.splice(idx, 1)[0]);
  }
  if (!out.some((x) => x.generic)) out[0] = ENDLESS_PROTOCOLS[0];
  return out;
}

export function compareEndlessScores(a, b) {
  return finite(b.completedRounds) - finite(a.completedRounds)
    || finite(b.progress) - finite(a.progress)
    || finite(a.durationMs, Number.MAX_SAFE_INTEGER) - finite(b.durationMs, Number.MAX_SAFE_INTEGER)
    || String(a.runId).localeCompare(String(b.runId));
}

function cleanRecord(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.runId !== 'string' || !raw.runId) return null;
  const seats = Math.max(1, Math.min(4, Math.trunc(finite(raw.seats, 0))));
  const completedRounds = Math.max(0, Math.trunc(finite(raw.completedRounds)));
  if (!seats || completedRounds < 1 || !Number.isFinite(Number(raw.progress))) return null;
  return {
    runId: raw.runId.slice(0, 80), rulesVersion: Math.max(1, Math.trunc(finite(raw.rulesVersion, ENDLESS_RULES_VERSION))),
    seats, usedAI: raw.usedAI === true, completedRounds,
    progress: Math.max(0, Math.min(1, finite(raw.progress))),
    durationMs: Math.max(0, Math.trunc(finite(raw.durationMs))),
    endedAt: Math.max(0, Math.trunc(finite(raw.endedAt))),
    reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 32) : 'ended',
    lineup: Array.isArray(raw.lineup) ? raw.lineup.slice(0, 4).map((x) => String(x).slice(0, 24)) : [],
    finalized: raw.finalized === true,
  };
}

/**
 * Append-only journal with atomic snapshots. Every update originates in the Match callback; no client score message
 * exists. A damaged final JSONL record is ignored while every earlier valid record remains available.
 */
export class EndlessLeaderboardStore {
  constructor(filePath, { compactEvery = 128, now = Date.now } = {}) {
    this.filePath = path.resolve(filePath);
    this.snapshotPath = `${this.filePath}.snapshot.json`;
    this.logPath = `${this.filePath}.jsonl`;
    this.compactEvery = Math.max(8, Math.trunc(compactEvery));
    this.now = now;
    this.records = new Map();
    this.pendingWrites = new Map();
    this.retryTimers = new Map();
    this.events = 0;
    this._load();
    this._recoverInterrupted();
  }

  _load() {
    try {
      const snap = JSON.parse(fs.readFileSync(this.snapshotPath, 'utf8'));
      if (snap && snap.version === 1 && Array.isArray(snap.records)) {
        for (const row of snap.records) { const rec = cleanRecord(row); if (rec) this.records.set(rec.runId, rec); }
      }
    } catch { /* first start or an invalid snapshot: the log remains the source of truth */ }
    let text = '';
    try { text = fs.readFileSync(this.logPath, 'utf8'); } catch { return; }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        const rec = e && e.type === 'upsert' ? cleanRecord(e.record) : null;
        if (rec) this.records.set(rec.runId, rec);
      } catch {
        // Ignore only the malformed row and keep reading later append-only records.
        if (i === lines.length - 1 || (i === lines.length - 2 && lines.at(-1) === '')) break;
      }
    }
  }

  _recoverInterrupted() {
    for (const record of this.records.values()) {
      if (record.finalized) continue;
      this.finalize({ ...record, finalized: true, reason: 'interrupted', endedAt: this.nowMs() });
    }
  }

  _scheduleRetry(runId, delayMs = 1000) {
    if (this.retryTimers.has(runId)) return;
    const timer = setTimeout(() => {
      this.retryTimers.delete(runId);
      const pending = this.pendingWrites.get(runId);
      if (pending) this.upsert(pending);
    }, delayMs);
    timer.unref?.();
    this.retryTimers.set(runId, timer);
  }

  upsert(record) {
    const rec = cleanRecord(record);
    if (!rec) return { ok: false, error: 'invalid record' };
    const old = this.records.get(rec.runId);
    if (old?.finalized) return { ok: true, record: old, duplicate: true };
    const next = old ? { ...old, ...rec, finalized: old.finalized || rec.finalized } : rec;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.appendFileSync(this.logPath, `${JSON.stringify({ type: 'upsert', record: next })}\n`, { encoding: 'utf8', mode: 0o600 });
      this.records.set(next.runId, next);
      this.pendingWrites.delete(next.runId);
      this.events++;
      if (this.events >= this.compactEvery) this.compact();
      return { ok: true, record: next };
    } catch (error) {
      const prior = this.pendingWrites.get(rec.runId);
      const nextRetry = prior?._retryDelay ? Math.min(60_000, prior._retryDelay * 2) : 1000;
      const pending = { ...rec, _retryDelay: nextRetry };
      this.pendingWrites.set(rec.runId, pending);
      this._scheduleRetry(rec.runId, nextRetry);
      return { ok: false, error: error?.message || 'write failed' };
    }
  }

  checkpoint(record) { return this.upsert({ ...record, finalized: false }); }

  finalize(record) { return this.upsert({ ...record, finalized: true }); }

  compact() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.snapshotPath}.${process.pid}.tmp`;
      const payload = JSON.stringify({ version: 1, records: [...this.records.values()] });
      fs.writeFileSync(tmp, `${payload}\n`, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, this.snapshotPath);
      fs.writeFileSync(this.logPath, '', { encoding: 'utf8', mode: 0o600 });
      this.events = 0;
      return true;
    } catch { return false; }
  }

  leaderboard({ seats = 1, ai = 'all', limit = 100, rulesVersion = ENDLESS_RULES_VERSION } = {}) {
    const n = Math.max(1, Math.min(4, Math.trunc(finite(seats, 1))));
    const rows = [...this.records.values()].filter((r) => r.finalized && r.seats === n && r.rulesVersion === rulesVersion
      && (ai === 'all' || (ai === 'human' ? !r.usedAI : r.usedAI)));
    rows.sort(compareEndlessScores);
    return { t: 'endless.leaderboard', seats: n, ai, rulesVersion, records: rows.slice(0, Math.max(1, Math.min(100, Math.trunc(finite(limit, 100))))) };
  }

  nowMs() { return Math.max(0, Math.trunc(finite(this.now(), Date.now()))); }
}
