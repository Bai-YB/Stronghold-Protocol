// server/http/admin.js — authenticated monitor and guarded update requests.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, statfs } from 'node:fs/promises';
import { availableParallelism, cpus, freemem, totalmem } from 'node:os';
import { clientAddress, isLocalIp } from '../net.js';
import { APP_VERSION, DIFFICULTIES } from '../../shared/constants.js';
import { sendJson } from './common.js';
import { createAdminUpdateService } from './adminUpdate.js';
import { createAnnouncementStore, normalizeAnnouncement } from './announcements.js';
import { createSiteSettingsStore, normalizeSiteSettings } from './siteSettings.js';
import { createPollStore, pollHttpError } from './polls.js';

const COOKIE = 'sp_admin';
const SESSION_MS = 8 * 60 * 60 * 1000;
const BODY_LIMIT = 2048;
const ATTEMPT_LIMIT = 5;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const METRICS_CACHE_MS = 5000;

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
  for (const dir of ['/sys/fs/cgroup/cpu', '/sys/fs/cgroup/cpu,cpuacct']) {
    const [quota, period] = await Promise.all([
      readSystemFile(`${dir}/cpu.cfs_quota_us`),
      readSystemFile(`${dir}/cpu.cfs_period_us`),
    ]);
    const q = Number(quota);
    const p = Number(period);
    if (Number.isFinite(q) && q > 0 && Number.isFinite(p) && p > 0) return Math.min(available, q / p);
  }
  return available;
}

async function memoryMetrics() {
  const hostTotal = totalmem();
  const v2Current = await readSystemFile('/sys/fs/cgroup/memory.current');
  const v2Limit = await readSystemFile('/sys/fs/cgroup/memory.max');
  let used = Number(v2Current);
  let limit = Number(v2Limit);
  if (!v2Current || !v2Limit) {
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
  return {
    storageUsedBytes: Number(used),
    storageTotalBytes: Number(total),
    storageScope: 'app-filesystem',
  };
}

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
        if (usedUs >= 0 && capacity > 0) {
          cpuPercent = usedUs / ((now - previousAt) * 1000 * capacity) * 100;
        }
      }
    }
    previousHost = host;
    previousContainer = containerUsage;
    previousAt = now;
    return {
      cpuPercent: cpuPercent === null ? null : Math.max(0, Math.min(100, Math.round(cpuPercent * 10) / 10)),
      cpuScope,
      ...memory,
      ...storage,
      processRssBytes: process.memoryUsage().rss,
      sampledAt: now,
    };
  }

  return async function metrics() {
    if (cached && Date.now() - cachedAt < METRICS_CACHE_MS) return cached;
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

function cookieValue(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const item = part.trim();
    if (item.startsWith(`${COOKIE}=`)) return item.slice(COOKIE.length + 1);
  }
  return '';
}

function trustedForwarder(req, trustProxy) {
  const remote = String(req.socket?.remoteAddress || '').replace(/^::ffff:/i, '');
  return trustProxy === true || (trustProxy !== false && isLocalIp(remote));
}

export function isSameOrigin(req, trustProxy) {
  const origin = req.headers.origin;
  const forwardedHost = req.headers['x-forwarded-host'];
  const host = trustedForwarder(req, trustProxy) && typeof forwardedHost === 'string'
    ? forwardedHost.split(',')[0].trim() : req.headers.host;
  if (typeof origin !== 'string' || typeof host !== 'string') return false;
  try {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.host.toLowerCase() !== host.toLowerCase()) return false;
    return !req.headers['sec-fetch-site'] || req.headers['sec-fetch-site'] === 'same-origin';
  } catch {
    return false;
  }
}

export function requestIsSecure(req, trustProxy) {
  if (req.socket?.encrypted) return true;
  const origin = req.headers.origin;
  if (typeof origin === 'string') {
    try { if (new URL(origin).protocol === 'https:') return true; } catch { /* malformed Origin header */ }
  }
  if (!trustedForwarder(req, trustProxy)) return false;
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return forwarded === 'https';
}

function setSessionCookie(req, res, token, trustProxy) {
  const secure = requestIsSecure(req, trustProxy) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_MS / 1000)}${secure}`);
}

function clearSessionCookie(req, res, trustProxy) {
  const secure = requestIsSecure(req, trustProxy) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
}

export function readJson(req, maxBytes = BODY_LIMIT) {
  return new Promise((resolve) => {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') { req.resume(); resolve({ error: 415 }); return; }
    let size = 0;
    const chunks = [];
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > maxBytes) {
        done = true;
        chunks.length = 0;
        req.resume();
        resolve({ error: 413 });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(value && typeof value === 'object' && !Array.isArray(value) ? { value } : { error: 400 });
      } catch {
        resolve({ error: 400 });
      }
    });
    req.on('error', () => { if (!done) { done = true; resolve({ error: 400 }); } });
  });
}

function overview(health, metrics, announcements) {
  const { lobby } = health;
  const matchQueues = Object.fromEntries(DIFFICULTIES.map((difficulty) => [difficulty, 0]));
  for (const room of lobby.rooms.values()) {
    if (room.matchmaking && !room.match && Object.hasOwn(matchQueues, room.difficulty)) {
      matchQueues[room.difficulty] += room.activeHumans().filter((seat) => seat.connected).length;
    }
  }
  const players = [...lobby.registry.all()]
    .filter((session) => session.connected)
    .map((session) => {
      const room = lobby.roomOf(session);
      const seat = room?.seatOf(session.playerId) || null;
      const spectator = room?.spectatorOf(session.playerId) || null;
      const queued = !!room?.matchmaking && !room.match;
      let status = 'lobby';
      if (room?.match && seat && !seat.left) status = 'playing';
      else if (room?.match && spectator) status = 'spectating';
      else if (queued) status = 'queued';
      else if (room) status = 'room';
      return {
        id: String(session.playerId),
        name: session.name,
        status,
        inGame: status === 'playing',
        roomCode: room?.code || null,
        mode: room?.mode || null,
        custom: room?.custom === true,
        runKind: room?.runKind || null,
        difficulty: room?.difficulty || null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const rooms = [...lobby.rooms.values()].map((room) => {
    const humans = room.seats.filter((seat) => seat && !seat.isBot && !seat.left);
    const connectedHumans = humans.filter((seat) => seat.connected).length;
    const bots = room.seats.filter((seat) => seat && seat.isBot && !seat.left).length;
    const spectators = room.spectators.filter((seat) => seat.connected).length;
    return {
      code: room.code,
      mode: room.mode,
      difficulty: room.difficulty,
      state: room.match ? 'running' : 'waiting',
      // a hosted match (gameplay plugin or another official version) has no `round` on the proxy: the last m.public frame's
      round: Number.isSafeInteger(room.match?.round) && room.match.round >= 0 ? room.match.round
        : Number.isSafeInteger(room.matchRound) && room.matchRound >= 0 ? room.matchRound : null,
      custom: room.custom === true,
      runKind: room.runKind || null,
      version: typeof room.version === 'string' ? room.version : null,
      matchmaking: !!room.matchmaking,
      humans: humans.length,
      connectedHumans,
      bots,
      spectators,
      createdAt: room.createdAt,
    };
  }).sort((a, b) => a.createdAt - b.createdAt);
  const queueTotal = Object.values(matchQueues).reduce((sum, count) => sum + count, 0);
  return {
    updatedAt: Date.now(),
    online: players.length,
    players,
    queueTotal,
    matchQueues,
    rooms,
    roomTotal: rooms.length,
    matchTotal: rooms.filter((room) => room.state === 'running').length,
    serverInfo: {
      appVersion: APP_VERSION,
      nodeVersion: process.versions.node,
      uptimeSec: Math.round((Date.now() - health.startedAt) / 1000),
      memoryBytes: process.memoryUsage().rss,
    },
    metrics,
    announcements,
  };
}

function pluginName(value, id) {
  if (typeof value === 'string') return value.slice(0, 120);
  if (value && typeof value === 'object') {
    const candidate = value.zh || value['zh-CN'] || value.en || Object.values(value).find((entry) => typeof entry === 'string');
    if (typeof candidate === 'string') return candidate.slice(0, 120);
  }
  return id;
}

/** Admin-only read view of the native 0.3.1 plugin registry. Studio retains its own gated write API. */
function createRegistryPluginView(health) {
  const registry = health.packs;
  if (!registry) return null;
  const { lobby } = health;
  const usage = (id) => {
    const rooms = [...lobby.rooms.values()].filter((room) => room.content?.plugins?.some((entry) => entry.id === id));
    return { rooms: rooms.map((room) => room.code), activeMatches: rooms.filter((room) => room.match).length };
  };
  const skippedId = (where) => /(?:^|\/)plugins\/([a-z0-9][a-z0-9-]{1,31})(?:\/|$)/.exec(String(where || ''))?.[1] || null;
  const all = () => {
    const scanned = registry.plugins().filter((plugin) => plugin.source === 'plugins');
    const skipped = registry.report().skipped;
    const entries = scanned.map((plugin) => {
      const use = usage(plugin.id);
      return {
        id: plugin.id, name: pluginName(plugin.manifest?.name, plugin.id), class: plugin.class,
        version: String(plugin.manifest?.version || ''), status: plugin.status,
        unofficial: plugin.class !== 'lang', inUse: use.rooms.length, activeMatches: use.activeMatches,
        problems: 0, warnings: 0, linked: false,
      };
    });
    const known = new Set(entries.map((entry) => entry.id));
    for (const item of skipped) {
      const id = skippedId(item.where);
      if (!id || known.has(id)) continue;
      known.add(id);
      entries.push({ id, name: id, class: 'unknown', version: '', status: 'skipped', unofficial: true,
        inUse: 0, activeMatches: 0, problems: item.problems.length, warnings: 0, linked: false });
    }
    return entries.sort((a, b) => a.id.localeCompare(b.id));
  };
  return {
    readOnly: true,
    list: all,
    rescan() { registry.rescan(); return all(); },
    inspect(id) {
      const entry = all().find((item) => item.id === id);
      if (!entry) { const error = new Error('PLUGIN_UNKNOWN'); error.status = 404; error.code = 'PLUGIN_UNKNOWN'; throw error; }
      const plugin = registry.plugin(id);
      const skipped = registry.report().skipped.find((item) => skippedId(item.where) === id);
      return {
        ...entry, manifest: plugin ? { name: entry.name, version: entry.version, scope: plugin.manifest?.scope || [] } : { name: entry.name },
        bytes: Number(plugin?.bytes) || 0, rooms: usage(id).rooms, lock: null,
        check: { issues: (skipped?.issues || []).slice(0, 20).map((issue) => ({ level: issue.level, code: issue.code })) },
      };
    },
  };
}

/**
 * Build the `/admin/api/*` handler. Update requests are sent only to the separate
 * host helper, which performs the final idle check before any container restart.
 * @param {{ health: { startedAt: number, lobby: import('../lobby.js').Lobby }, studio?: { management?: {
 *   list: () => any[], rescan: () => any[], inspect: (id: string) => any,
 *   catalog: (body: any) => Promise<any>, install: (body: any) => Promise<any>, remove: (id: string) => any,
 * } } | null, trustProxy?: 'auto' | boolean,
 *   metrics?: ReturnType<typeof createMetricsSampler>,
 *   announcements?: ReturnType<typeof createAnnouncementStore>,
 *   polls?: ReturnType<typeof createPollStore>,
 *   siteSettings?: ReturnType<typeof createSiteSettingsStore> }} opts
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, path: string) => Promise<boolean>}
 */
export function createAdminHandler({ health, studio = null, trustProxy = 'auto', announcements = createAnnouncementStore(), polls = createPollStore(), siteSettings = createSiteSettingsStore(), metrics = createMetricsSampler() }) {
  const sessions = new Map();
  const attempts = new Map();
  const updates = createAdminUpdateService();
  const registryPlugins = createRegistryPluginView(health);
  const configuredPassword = String(process.env.SP_ADMIN_PASSWORD || '');
  const enabled = configuredPassword.length >= 16;
  const expected = createHash('sha256').update(configuredPassword).digest();

  function authorized(req) {
    const token = cookieValue(req);
    if (!/^[A-Za-z0-9_-]{40,50}$/.test(token)) return false;
    const expiresAt = sessions.get(token);
    if (!expiresAt) return false;
    if (expiresAt <= Date.now()) { sessions.delete(token); return false; }
    return true;
  }

  function sourceKey(req) {
    const address = clientAddress(req, trustProxy);
    return address.key || address.ip || 'unknown';
  }

  function reply(req, res, status, payload) {
    sendJson(req, res, status, payload);
  }

  function pluginError(error) {
    const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
    const code = typeof error?.code === 'string' && /^PLUGIN_[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'ADMIN_PLUGIN_MANAGER_ERROR';
    const source = error?.params && typeof error.params === 'object' && !Array.isArray(error.params) ? error.params : {};
    const params = {};
    for (const key of ['id', 'rooms', 'matches', 'max', 'file', 'where', 'kind', 'ext']) {
      const value = source[key];
      if (typeof value === 'string') params[key] = value.slice(0, 240);
      else if (Number.isFinite(value)) params[key] = value;
    }
    return { status, value: { error: code, params } };
  }

  const pluginDetail = pathname => /^\/admin\/api\/plugins\/item\/([a-z0-9][a-z0-9-]{1,31})$/.exec(pathname);

  return async function handleAdmin(req, res, pathname) {
    const deletingAnnouncement = pathname.match(/^\/admin\/api\/announcements\/([a-f0-9]{24})$/);
    const siteSettingsPath = pathname === '/admin/api/site-settings';
    const pollCollection = pathname === '/admin/api/polls';
    const pollItem = /^\/admin\/api\/polls\/([a-f0-9]{24})(\/close)?$/.exec(pathname);
    const pluginId = pluginDetail(pathname);
    const pluginCollection = pathname === '/admin/api/plugins';
    const pluginCatalog = pathname === '/admin/api/plugins/catalog';
    const pluginInstall = pathname === '/admin/api/plugins/install';
    const pluginRescan = pathname === '/admin/api/plugins/rescan';
    const knownPath = pathname === '/admin/api/login' || pathname === '/admin/api/logout'
      || pathname === '/admin/api/status' || pathname === '/admin/api/update'
      || pathname === '/admin/api/announcements' || Boolean(deletingAnnouncement)
      || siteSettingsPath
      || pollCollection || Boolean(pollItem)
      || pluginCollection || Boolean(pluginId) || pluginCatalog || pluginInstall || pluginRescan;
    if (!knownPath) { reply(req, res, 404, { error: 'NOT_FOUND' }); return true; }

    if (pathname === '/admin/api/login') {
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); reply(req, res, 405, { error: 'METHOD_NOT_ALLOWED' }); return true; }
      if (!enabled) { reply(req, res, 503, { error: 'ADMIN_DISABLED' }); return true; }
      if (!isSameOrigin(req, trustProxy)) { reply(req, res, 403, { error: 'BAD_ORIGIN' }); return true; }

      const key = sourceKey(req);
      const now = Date.now();
      for (const [source, attempt] of attempts) if (attempt.resetAt <= now) attempts.delete(source);
      let bucket = attempts.get(key);
      if (!bucket || bucket.resetAt <= now) { bucket = { count: 0, resetAt: now + ATTEMPT_WINDOW_MS }; attempts.set(key, bucket); }
      if (bucket.count >= ATTEMPT_LIMIT) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
        reply(req, res, 429, { error: 'LOGIN_RATE_LIMITED' });
        return true;
      }

      const body = await readJson(req);
      if (body.error) { reply(req, res, body.error, { error: body.error === 413 ? 'BODY_TOO_LARGE' : body.error === 415 ? 'JSON_REQUIRED' : 'BAD_REQUEST' }); return true; }
      const candidate = typeof body.value.password === 'string' ? body.value.password : '';
      const supplied = createHash('sha256').update(candidate).digest();
      if (!timingSafeEqual(expected, supplied)) {
        bucket.count++;
        reply(req, res, 401, { error: 'INVALID_CREDENTIALS' });
        return true;
      }

      attempts.delete(key);
      const nowSession = Date.now();
      for (const [token, expiresAt] of sessions) if (expiresAt <= nowSession) sessions.delete(token);
      while (sessions.size >= 32) {
        const oldest = sessions.keys().next().value;
        if (!oldest) break;
        sessions.delete(oldest);
      }
      const token = randomBytes(32).toString('base64url');
      sessions.set(token, nowSession + SESSION_MS);
      setSessionCookie(req, res, token, trustProxy);
      reply(req, res, 200, { ok: true });
      return true;
    }

    if (pathname === '/admin/api/logout') {
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); reply(req, res, 405, { error: 'METHOD_NOT_ALLOWED' }); return true; }
      if (!isSameOrigin(req, trustProxy)) { reply(req, res, 403, { error: 'BAD_ORIGIN' }); return true; }
      const token = cookieValue(req);
      if (token) sessions.delete(token);
      clearSessionCookie(req, res, trustProxy);
      reply(req, res, 200, { ok: true });
      return true;
    }

    if (!enabled) { reply(req, res, 503, { error: 'ADMIN_DISABLED' }); return true; }
    if (!authorized(req)) { reply(req, res, 401, { error: 'AUTH_REQUIRED' }); return true; }

    if (pollCollection || pollItem) {
      const allowed = pollCollection ? 'GET, HEAD, POST' : pollItem[2] ? 'POST' : 'DELETE';
      if (!allowed.split(', ').includes(req.method)) {
        res.setHeader('Allow', allowed);
        reply(req, res, 405, { error: 'METHOD_NOT_ALLOWED' });
        return true;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD' && !isSameOrigin(req, trustProxy)) {
        reply(req, res, 403, { error: 'BAD_ORIGIN' });
        return true;
      }
      try {
        if (pollCollection && (req.method === 'GET' || req.method === 'HEAD')) {
          reply(req, res, 200, { polls: await polls.list() });
        } else if (pollCollection) {
          const body = await readJson(req, 8192);
          if (body.error) {
            reply(req, res, body.error, { error: body.error === 413 ? 'BODY_TOO_LARGE' : body.error === 415 ? 'JSON_REQUIRED' : 'BAD_REQUEST' });
            return true;
          }
          reply(req, res, 201, { ok: true, poll: await polls.create(body.value) });
        } else if (pollItem[2]) {
          reply(req, res, 200, { ok: true, poll: await polls.close(pollItem[1]) });
        } else {
          await polls.remove(pollItem[1]);
          reply(req, res, 200, { ok: true });
        }
      } catch (error) {
        const result = pollHttpError(error);
        if (!result) throw error;
        reply(req, res, result.status, { error: result.error });
      }
      return true;
    }

    if (pathname === '/admin/api/announcements' && req.method === 'POST') {
      if (!isSameOrigin(req, trustProxy)) { reply(req, res, 403, { error: 'BAD_ORIGIN' }); return true; }
      const body = await readJson(req, 8192);
      if (body.error) { reply(req, res, body.error, { error: 'BAD_REQUEST' }); return true; }
      const normalized = normalizeAnnouncement(body.value);
      if (!normalized) { reply(req, res, 400, { error: 'INVALID_ANNOUNCEMENT' }); return true; }
      try {
        reply(req, res, 201, { ok: true, announcement: await announcements.create(normalized) });
      } catch (error) {
        if (error?.code === 'ANNOUNCEMENT_LIMIT') reply(req, res, 409, { error: 'ANNOUNCEMENT_LIMIT' });
        else throw error;
      }
      return true;
    }

    if (deletingAnnouncement && req.method === 'DELETE') {
      if (!isSameOrigin(req, trustProxy)) { reply(req, res, 403, { error: 'BAD_ORIGIN' }); return true; }
      if (!await announcements.remove(deletingAnnouncement[1])) { reply(req, res, 404, { error: 'ANNOUNCEMENT_NOT_FOUND' }); return true; }
      reply(req, res, 200, { ok: true });
      return true;
    }

    if (siteSettingsPath && req.method === 'PUT') {
      if (!isSameOrigin(req, trustProxy)) { reply(req, res, 403, { error: 'BAD_ORIGIN' }); return true; }
      const body = await readJson(req, 2048);
      if (body.error) { reply(req, res, body.error, { error: 'BAD_REQUEST' }); return true; }
      const normalized = normalizeSiteSettings(body.value);
      if (!normalized) { reply(req, res, 400, { error: 'INVALID_SITE_SETTINGS' }); return true; }
      reply(req, res, 200, { ok: true, settings: await siteSettings.update(normalized) });
      return true;
    }

    if (pathname === '/admin/api/update' && req.method === 'POST') {
      if (!isSameOrigin(req, trustProxy)) { reply(req, res, 403, { error: 'BAD_ORIGIN' }); return true; }
      const body = await readJson(req);
      if (body.error) { reply(req, res, body.error, { error: 'BAD_REQUEST' }); return true; }
      const tag = body.value?.tag;
      if (Object.keys(body.value).length !== 1 || typeof tag !== 'string' || !/^v\d+\.\d+\.\d+$/.test(tag)) {
        reply(req, res, 400, { error: 'INVALID_TAG' });
        return true;
      }
      const answer = await updates.apply(tag);
      reply(req, res, answer.status, answer.value);
      return true;
    }

    if (pluginCollection || pluginId || pluginCatalog || pluginInstall || pluginRescan) {
      const manager = studio?.management || registryPlugins;
      if (!manager) { reply(req, res, 503, { error: 'ADMIN_PLUGIN_MANAGER_UNAVAILABLE' }); return true; }
      if (pluginCollection && (req.method === 'GET' || req.method === 'HEAD')) {
        reply(req, res, 200, { plugins: manager.list() });
        return true;
      }
      if (pluginId && (req.method === 'GET' || req.method === 'HEAD')) {
        try { reply(req, res, 200, manager.inspect(pluginId[1])); }
        catch (error) { const result = pluginError(error); reply(req, res, result.status, result.value); }
        return true;
      }
      if (pluginRescan && req.method === 'POST') {
        if (!isSameOrigin(req, trustProxy)) { reply(req, res, 403, { error: 'BAD_ORIGIN' }); return true; }
        try { reply(req, res, 200, { plugins: manager.rescan() }); }
        catch (error) { const result = pluginError(error); reply(req, res, result.status, result.value); }
        return true;
      }
      if (manager.readOnly) {
        res.setHeader('Allow', pluginId ? 'GET, HEAD' : pluginCollection ? 'GET, HEAD' : pluginRescan ? 'POST' : '');
        reply(req, res, 405, { error: 'ADMIN_PLUGIN_READ_ONLY' });
        return true;
      }
      if ((pluginCatalog || pluginInstall) && req.method === 'POST') {
        if (!isSameOrigin(req, trustProxy)) { reply(req, res, 403, { error: 'BAD_ORIGIN' }); return true; }
        const body = await readJson(req, 64 * 1024);
        if (body.error) { reply(req, res, body.error, { error: body.error === 413 ? 'BODY_TOO_LARGE' : body.error === 415 ? 'JSON_REQUIRED' : 'BAD_REQUEST' }); return true; }
        try {
          if (pluginCatalog) reply(req, res, 200, await manager.catalog(body.value));
          else reply(req, res, 201, await manager.install(body.value));
        } catch (error) { const result = pluginError(error); reply(req, res, result.status, result.value); }
        return true;
      }
      if (pluginId && req.method === 'DELETE') {
        if (!isSameOrigin(req, trustProxy)) { reply(req, res, 403, { error: 'BAD_ORIGIN' }); return true; }
        try {
          const result = manager.remove(pluginId[1]);
          const refused = result.refused || [];
          const safeRefused = refused.map((item) => {
            const params = item.params && typeof item.params === 'object' ? item.params : {};
            return {
              id: String(item.id || '').slice(0, 64),
              error: String(item.error || 'ADMIN_PLUGIN_MANAGER_ERROR').slice(0, 80),
              params: {
                ...(typeof params.rooms === 'string' ? { rooms: params.rooms.slice(0, 240) } : {}),
                ...(Number.isFinite(params.matches) ? { matches: params.matches } : {}),
              },
            };
          });
          reply(req, res, safeRefused.length ? 409 : 200, { ok: safeRefused.length === 0, removed: result.removed || [], refused: safeRefused });
        } catch (error) { const result = pluginError(error); reply(req, res, result.status, result.value); }
        return true;
      }
      res.setHeader('Allow', pluginId ? 'GET, HEAD, DELETE' : pluginCatalog || pluginInstall || pluginRescan ? 'POST' : 'GET, HEAD');
      reply(req, res, 405, { error: 'METHOD_NOT_ALLOWED' });
      return true;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', siteSettingsPath ? 'GET, HEAD, PUT' : 'GET, HEAD');
      reply(req, res, 405, { error: 'METHOD_NOT_ALLOWED' });
      return true;
    }
    if (pathname === '/admin/api/update') {
      const force = new URL(req.url || '', 'http://localhost').searchParams.get('refresh') === '1';
      reply(req, res, 200, await updates.status({ force }));
      return true;
    }
    if (pathname === '/admin/api/announcements') {
      reply(req, res, 200, { announcements: await announcements.list() });
      return true;
    }
    if (siteSettingsPath) {
      reply(req, res, 200, { settings: await siteSettings.get() });
      return true;
    }
    reply(req, res, 200, overview(health, await metrics(), await announcements.list()));
    return true;
  };
}
