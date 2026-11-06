// Public, aggregate-only server monitoring and the resource sampler used by the monitor page.
import { readFile, statfs } from 'node:fs/promises';
import { availableParallelism, cpus, freemem, totalmem } from 'node:os';
import { APP_VERSION, DIFFICULTIES } from '../../shared/constants.js';
import { DEFAULT_VERSION } from '../../shared/versions.js';

async function readSystemFile(path) {
  try { return (await readFile(path, 'utf8')).trim(); } catch { return null; }
}

function hostCpuTimes() {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    idle += cpu.times.idle;
    total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
  }
  return { idle, total };
}

async function containerCpuUsage() {
  const v2 = await readSystemFile('/sys/fs/cgroup/cpu.stat');
  const usage = v2?.match(/^usage_usec\s+(\d+)$/m);
  if (usage) return Number(usage[1]);
  for (const path of ['/sys/fs/cgroup/cpuacct/cpuacct.usage', '/sys/fs/cgroup/cpu,cpuacct/cpuacct.usage']) {
    const nanoseconds = Number(await readSystemFile(path));
    if (Number.isFinite(nanoseconds) && nanoseconds > 0) return nanoseconds / 1000;
  }
  return null;
}

async function containerCpuCapacity() {
  const available = availableParallelism();
  const v2 = await readSystemFile('/sys/fs/cgroup/cpu.max');
  if (v2) {
    const [quota, period] = v2.split(/\s+/).map(Number);
    if (Number.isFinite(quota) && quota > 0 && Number.isFinite(period) && period > 0) return Math.min(available, quota / period);
  }
  for (const directory of ['/sys/fs/cgroup/cpu', '/sys/fs/cgroup/cpu,cpuacct']) {
    const [quota, period] = await Promise.all([
      readSystemFile(`${directory}/cpu.cfs_quota_us`),
      readSystemFile(`${directory}/cpu.cfs_period_us`),
    ]);
    const q = Number(quota);
    const p = Number(period);
    if (Number.isFinite(q) && q > 0 && Number.isFinite(p) && p > 0) return Math.min(available, q / p);
  }
  return available;
}

async function memoryMetrics() {
  const hostTotal = totalmem();
  const [v2Current, v2Limit] = await Promise.all([
    readSystemFile('/sys/fs/cgroup/memory.current'),
    readSystemFile('/sys/fs/cgroup/memory.max'),
  ]);
  let used = Number(v2Current);
  let limit = Number(v2Limit);
  if (!v2Current || !v2Limit || !Number.isFinite(limit)) {
    const [v1Current, v1Limit] = await Promise.all([
      readSystemFile('/sys/fs/cgroup/memory/memory.usage_in_bytes'),
      readSystemFile('/sys/fs/cgroup/memory/memory.limit_in_bytes'),
    ]);
    used = Number(v1Current);
    limit = Number(v1Limit);
  }
  if (Number.isFinite(used) && used >= 0 && Number.isFinite(limit) && limit > 0 && limit <= hostTotal) {
    return { memoryUsedBytes: used, memoryTotalBytes: limit, memoryScope: 'container' };
  }
  return { memoryUsedBytes: Math.max(0, hostTotal - freemem()), memoryTotalBytes: hostTotal, memoryScope: 'host' };
}

async function storageMetrics() {
  let disk;
  try { disk = await statfs(new URL('../../public/assets/', import.meta.url), { bigint: true }); }
  catch {
    try { disk = await statfs(process.cwd(), { bigint: true }); }
    catch { return { storageUsedBytes: null, storageTotalBytes: null, storageScope: 'app-filesystem' }; }
  }
  const total = disk.blocks * disk.bsize;
  const used = (disk.blocks - disk.bfree) * disk.bsize;
  return { storageUsedBytes: Number(used), storageTotalBytes: Number(total), storageScope: 'app-filesystem' };
}

/** Sample host/container resources at most once per 5 seconds. */
export function createMetricsSampler() {
  let previousHost = hostCpuTimes();
  let previousContainer = null;
  let previousAt = Date.now();
  let cached = null;
  let cachedAt = 0;
  let pending = null;

  async function sample() {
    const [containerUsage, capacity, memory, storage] = await Promise.all([
      containerCpuUsage(), containerCpuCapacity(), memoryMetrics(), storageMetrics(),
    ]);
    const now = Date.now();
    const host = hostCpuTimes();
    const hostTotal = host.total - previousHost.total;
    const hostBusy = hostTotal - (host.idle - previousHost.idle);
    let cpuPercent = hostTotal > 0 ? hostBusy / hostTotal * 100 : null;
    let cpuScope = 'host';
    if (containerUsage !== null) {
      cpuPercent = null;
      cpuScope = 'container';
      if (previousContainer !== null && now > previousAt) {
        const usedUs = containerUsage - previousContainer;
        if (usedUs >= 0 && capacity > 0) cpuPercent = usedUs / ((now - previousAt) * 1000 * capacity) * 100;
      }
    }
    previousHost = host;
    previousContainer = containerUsage;
    previousAt = now;
    return {
      cpuPercent: cpuPercent === null ? null : Math.max(0, Math.min(100, Math.round(cpuPercent * 10) / 10)),
      cpuScope, ...memory, ...storage, sampledAt: now,
    };
  }

  return async function metrics() {
    if (cached && Date.now() - cachedAt < 5000) return cached;
    if (!pending) {
      pending = sample().then((value) => {
        cached = value;
        cachedAt = Date.now();
        return value;
      }).finally(() => { pending = null; });
    }
    return pending;
  };
}

function percentage(used, total) {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round(used / total * 1000) / 10));
}

function publicMetrics(snapshot) {
  const cpuPercent = Number.isFinite(snapshot?.cpuPercent)
    ? Math.max(0, Math.min(100, Math.round(snapshot.cpuPercent * 10) / 10)) : null;
  const memoryPercent = percentage(snapshot?.memoryUsedBytes, snapshot?.memoryTotalBytes);
  const storagePercent = percentage(snapshot?.storageUsedBytes, snapshot?.storageTotalBytes);
  const values = [cpuPercent, memoryPercent].filter(Number.isFinite);
  const highest = values.length ? Math.max(...values) : null;
  return {
    cpuPercent, cpuScope: snapshot?.cpuScope === 'container' ? 'container' : snapshot?.cpuScope === 'host' ? 'host' : null,
    memoryPercent, memoryScope: snapshot?.memoryScope === 'container' ? 'container' : snapshot?.memoryScope === 'host' ? 'host' : null,
    storagePercent, storageScope: 'app-filesystem',
    pressureLevel: highest === null ? 'unknown' : highest >= 90 ? 'critical' : highest >= 80 ? 'high' : highest >= 60 ? 'moderate' : 'normal',
    sampledAt: Number.isSafeInteger(snapshot?.sampledAt) ? snapshot.sampledAt : null,
  };
}

/** Public counters contain aggregate totals only; no names, room codes, or per-room details. */
export async function publicStatusReport({ startedAt, lobby, registry }, announcements, metrics) {
  const difficultyStats = Object.fromEntries(DIFFICULTIES.map((difficulty) => [difficulty, { playing: 0, queued: 0 }]));
  const versionDifficultyStats = {};
  let queued = 0;
  for (const room of lobby.rooms.values()) {
    const counts = difficultyStats[room.difficulty];
    if (!counts) continue;
    const version = typeof room.version === 'string' ? room.version : DEFAULT_VERSION;
    const byVersion = versionDifficultyStats[version] ||= Object.fromEntries(DIFFICULTIES.map((difficulty) => [difficulty, { playing: 0, queued: 0 }]));
    const versionCounts = byVersion[room.difficulty];
    const humans = room.activeHumans().filter((seat) => seat.connected).length;
    if (room.match) { counts.playing += humans; versionCounts.playing += humans; }
    if (room.matchmaking && !room.match) { counts.queued += humans; versionCounts.queued += humans; queued += humans; }
  }
  const stats = lobby.stats();
  return {
    ok: true, app: APP_VERSION, uptimeSec: Math.round((Date.now() - startedAt) / 1000), updatedAt: Date.now(),
    online: [...registry.all()].filter((session) => session.connected).length,
    queued, rooms: Number(stats.rooms) || 0, matches: Number(stats.matches) || 0, difficultyStats, versionDifficultyStats,
    metrics: publicMetrics(await metrics()), announcements: await announcements.publicList(),
  };
}
