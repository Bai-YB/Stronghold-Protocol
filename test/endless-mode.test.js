import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EndlessLeaderboardStore, endlessGrowth, endlessAffix, isEndlessBoss, isEndlessDoubleBoss } from '../server/match/endless.js';
import { SharedBossPool, SharedBossPoolGroup } from '../server/match/finalAssault.js';
import { getData } from '../server/data.js';
import { GameData } from '../server/match/gamedata.js';
import { Battle } from '../server/sim/Battle.js';
import { buildEndlessBossWave, buildEndlessWave } from '../server/match/waves.js';
import { createRng } from '../server/sim/rng.js';
import { layerGainRoom } from '../shared/constants.js';
import { Match } from '../server/match/Match.js';
import { collectViolations } from '../server/match/invariants.js';
import { helperStats } from '../server/match/unite.js';
import { prepCamera, deployFieldOf, teamFrameIds } from '../public/js/ui/gameLogic/camera.js';

test('endless schedule and the published growth curve stay deterministic and finite', () => {
  assert.deepEqual([7, 14, 21, 28, 35, 42].map(isEndlessBoss), [true, true, true, true, true, true]);
  assert.deepEqual([7, 14, 21, 28, 42].map(isEndlessDoubleBoss), [false, false, false, true, true]);
  const expected = new Map([[1, [1, 40]], [7, [1.864, 52]], [14, [3.6359696, 66]], [28, [9.9640144, 94]], [42, [21.724499333333334, 120]]]);
  for (const [round, [hp, count]] of expected) {
    const growth = endlessGrowth(round, { players: 4 });
    assert.ok(Math.abs(growth.hpMul - hp) < 1e-8, `round ${round} hp multiplier`);
    assert.equal(growth.plannedEnemies, count);
  }
  for (const n of [10_000, 1_000_000]) {
    const growth = endlessGrowth(n, { boss: true, players: 4 });
    for (const value of Object.values(growth)) if (typeof value === 'number') assert.ok(Number.isFinite(value));
  }
  for (let n = 1; n < 15; n++) assert.notEqual(endlessAffix(n), endlessAffix(n + 7));
});

test('ordinary layers stay capped at 999 while an endless battle can cross the cap', () => {
  assert.equal(layerGainRoom(999, 5), 0);
  assert.equal(layerGainRoom(999, 5, null), 5);
  assert.equal(layerGainRoom(1_000_000, 25, null), 25);
  const make = (flags) => new Battle({ kind: 'normal', stageId: Object.keys(getData().stages)[0], data: getData(),
    players: [{ playerId: 'p1', units: [], bonds: { egirShip: { active: true, tier: 1, layers: 999 } } }],
    flags: { layerGainsEnabled: true, ...flags }, spawns: [], routes: [], recordEvents: false });
  const ordinary = make({});
  const endless = make({ layerCap: null });
  assert.equal(ordinary.addLayers('p1', 'egirShip', 1), 0);
  assert.equal(endless.addLayers('p1', 'egirShip', 1), 1);
  assert.equal(endless.getPlayer('p1').bonds.egirShip.layers, 1000);
  assert.equal(endless.flags.layerCap, null);
  assert.equal(JSON.parse(JSON.stringify({ layerCap: endless.flags.layerCap })).layerCap, null);
});

test('endless layers above 999 pass match audits and stay uncapped in Unite helper scoring', (t) => {
  const match = new Match({ roomCode: 'TEST', mode: 'coop', difficulty: 'ABYSS', modeId: 'mode_multi_abyss',
    seats: [{ seat: 0, playerId: 'p1', name: 'p1', isBot: false, connected: true }], seed: 1, data: getData(),
    runKind: 'endless', clientCombat: false, send: () => {}, broadcast: () => {}, onEnd: () => {} });
  t.after(() => match.dispose());
  const player = match.players.get('p1');
  player.layers.egirShip = 1000;
  assert.ok(collectViolations(match).some((x) => x.includes('egirShip layers 1000')));
  match.endless.active = true;
  assert.ok(!collectViolations(match).some((x) => x.includes('egirShip layers')));
  player.layers.egirShip = 999;
  player.bonds = { egirShip: { active: true, tier: 1, count: 3, layers: 999 } };
  player.pendingLayerGains = { egirShip: 1 };
  assert.equal(helperStats(match, player, new Map()).layers, 1000);
  match.endless.active = false;
  assert.equal(helperStats(match, player, new Map()).layers, 999);
});

test('endless boss preparation uses the shared boss field and partner framing', () => {
  const pub = { round: 21, runKind: 'endless', phase: 'PREP', bossRound: 14, hiddenRound: null,
    endless: { active: true, round: 7 }, bossPairs: [['p1', 'p2'], ['p3', 'p4']],
    players: ['p1', 'p2', 'p3', 'p4'].map((playerId, seat) => ({ playerId, seat, alive: true })) };
  assert.deepEqual(prepCamera(pub, 'p2'), { kind: 'bossPrep', opts: { side: 'R' } });
  assert.equal(deployFieldOf(pub, 'p2'), 'bossR');
  assert.deepEqual(teamFrameIds(pub, 'p2'), new Set(['p1', 'p2']));
  pub.endless.round = 8;
  assert.equal(prepCamera(pub, 'p2').kind, 'prep');
});

test('boss pools in a double-boss field keep independent health while exposing the summed team pool', () => {
  const p2 = new SharedBossPool(650);
  const p5 = new SharedBossPool(520);
  const group = new SharedBossPoolGroup({ boss_2: p2, boss_5: p5 });
  const data = getData();
  const gd = new GameData(data, 'mode_multi_abyss');
  const battle = new Battle({ kind: 'boss', stageId: Object.keys(data.stages)[0], data, sharedBoss: group,
    bossPools: { boss_2: p2, boss_5: p5 }, spawns: [], players: [], recordEvents: false });
  const first = battle.spawnEnemy('enemy_9017_achunt', { tag: 'boss', bossPoolKey: 'boss_2', pos: [3, 8] });
  const second = battle.spawnEnemy('enemy_2016_csphtm', { tag: 'boss', bossPoolKey: 'boss_5', pos: [3, 12] });
  assert.ok(gd.boss('boss_2'));
  assert.equal(first.bossPool, p2);
  assert.equal(second.bossPool, p5);
  p2.damage('p1', 200);
  assert.equal(group.hp, 970);
  assert.equal(p5.hp, 520);
  assert.deepEqual(group.bossStatuses().map((x) => x.id), ['boss_2', 'boss_5']);
});

test('endless waves meet the 40 + 2x plan and round 28 schedules both leaders on distinct pools', () => {
  const data = getData();
  const gd = new GameData(data, 'mode_multi_abyss');
  const factions = Object.keys(gd.factions.types).slice(0, 3);
  for (const [round, expected] of [[1, 40], [7, 52], [14, 66], [28, 94], [42, 120]]) {
    const wave = buildEndlessWave(gd, createRng(77), factions, round, 4);
    const count = wave.spawns.filter((s) => s.countInTotal !== false).reduce((sum, s) => sum + s.count, 0);
    assert.equal(count, expected);
    assert.ok(wave.spawns.every((s) => s.count <= 15));
  }
  const boss = buildEndlessBossWave(gd, createRng(77), factions, 28,
    { bossIds: ['boss_2', 'boss_5'], solo: false, players: 4 });
  const leaders = boss.spawns.filter((s) => s.tag === 'boss');
  assert.equal(leaders.length, 2);
  assert.deepEqual(new Set(leaders.map((s) => s.bossPoolKey)), new Set(['boss_2', 'boss_5']));
  assert.notDeepEqual(leaders[0].pos, leaders[1].pos);
  assert.equal(boss.bossPoolByEnemy.enemy_9017_achunt, 'boss_2');
  assert.equal(boss.bossPoolByEnemy.enemy_2016_csphtm, 'boss_5');
});

test('leaderboard checkpoints are finalized idempotently, filtered by seat/AI, and interrupted runs recover', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stronghold-endless-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'scores');
  let now = 1000;
  let store = new EndlessLeaderboardStore(file, { now: () => now });
  const base = { runId: 'run-human', rulesVersion: 1, seats: 2, usedAI: false, completedRounds: 14, progress: 0.5,
    durationMs: 5000, endedAt: now, reason: 'checkpoint', lineup: [] };
  assert.equal(store.checkpoint(base).ok, true);
  assert.equal(store.leaderboard({ seats: 2 }).records.length, 0);
  now += 1000;
  assert.equal(store.finalize({ ...base, finalized: true, reason: 'eliminated' }).ok, true);
  assert.equal(store.finalize({ ...base, finalized: true, reason: 'duplicate' }).duplicate, true);
  assert.equal(store.leaderboard({ seats: 2, ai: 'human' }).records[0].reason, 'eliminated');
  assert.equal(store.leaderboard({ seats: 2, ai: 'ai' }).records.length, 0);
  store.checkpoint({ ...base, runId: 'run-ai', usedAI: true, completedRounds: 12, finalized: false });

  store = new EndlessLeaderboardStore(file, { now: () => now + 2000 });
  const recovered = store.leaderboard({ seats: 2, ai: 'ai' }).records;
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].reason, 'interrupted');
  fs.appendFileSync(`${file}.jsonl`, '{damaged tail');
  store = new EndlessLeaderboardStore(file, { now: () => now + 3000 });
  assert.equal(store.leaderboard({ seats: 2, ai: 'human' }).records[0].runId, 'run-human');
  assert.equal(store.leaderboard({ seats: 2, ai: 'ai' }).records[0].runId, 'run-ai');
});
