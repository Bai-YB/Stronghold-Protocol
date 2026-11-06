// Official release notices and a narrow bridge to the FNOS host updater.
// Docker and shell access remain outside the game process.
import { request as httpRequest } from 'node:http';
import { APP_VERSION } from '../../shared/constants.js';

const RELEASE_API = 'https://api.github.com/repos/sganggs/Stronghold-Protocol/releases/latest';
const RELEASE_PAGE = 'https://github.com/sganggs/Stronghold-Protocol/releases/tag/';
const VERSION = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RELEASE_CACHE_MS = 15 * 60 * 1000;
const FORCE_INTERVAL_MS = 60 * 1000;
const HELPER_BODY_LIMIT = 8192;

function newerThanCurrent(tag) {
  const latest = VERSION.exec(tag || '');
  const current = VERSION.exec(`v${APP_VERSION}`);
  if (!latest || !current) return false;
  for (let i = 1; i <= 3; i++) {
    const difference = Number(latest[i]) - Number(current[i]);
    if (difference) return difference > 0;
  }
  return false;
}

function helperRequest(socketPath, path, method = 'GET', body = null, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const rawBody = body === null ? null : Buffer.from(JSON.stringify(body));
    const req = httpRequest({ socketPath, path, method, timeout,
      headers: rawBody ? { 'Content-Type': 'application/json', 'Content-Length': rawBody.length } : undefined,
    }, (res) => {
      let size = 0;
      const chunks = [];
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > HELPER_BODY_LIMIT) { req.destroy(new Error('UPDATER_REPLY_TOO_LARGE')); return; }
        chunks.push(chunk);
      });
      res.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('UPDATER_BAD_REPLY');
          resolve({ status: res.statusCode || 502, value });
        } catch { reject(new Error('UPDATER_BAD_REPLY')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('UPDATER_TIMEOUT')));
    req.on('error', reject);
    if (rawBody) req.write(rawBody);
    req.end();
  });
}

function createFallbackReleaseChecker() {
  let cache = null;
  let checkedAt = 0;
  let lastAttempt = 0;
  let pending = null;

  async function check(force) {
    const now = Date.now();
    if (pending) return pending;
    if (cache && ((!force && now - checkedAt < RELEASE_CACHE_MS) || (force && now - lastAttempt < FORCE_INTERVAL_MS))) return cache;
    lastAttempt = now;
    pending = (async () => {
      try {
        const response = await fetch(RELEASE_API, {
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Stronghold-Protocol-Admin' },
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw new Error('RELEASE_UNAVAILABLE');
        const release = await response.json();
        const tag = release?.tag_name;
        if (!VERSION.test(tag || '') || release.draft || release.prerelease || release.html_url !== RELEASE_PAGE + tag) {
          throw new Error('INVALID_RELEASE');
        }
        cache = { tag, releaseUrl: release.html_url, error: null };
      } catch {
        cache = { tag: cache?.tag || null, releaseUrl: cache?.releaseUrl || null, error: 'RELEASE_UNAVAILABLE' };
      }
      checkedAt = Date.now();
      return cache;
    })().finally(() => { pending = null; });
    return pending;
  }

  return async (force) => {
    const release = await check(force);
    return { ...release, checkedAt };
  };
}

export function createAdminUpdateService() {
  const socketPath = process.env.SP_UPDATE_SOCKET || '';
  const fallback = createFallbackReleaseChecker();

  async function status({ force = false } = {}) {
    if (socketPath) {
      try {
        const answer = await helperRequest(socketPath, force ? '/check' : '/status', 'GET', null, force ? 15000 : 5000);
        if (answer.status !== 200) throw new Error('UPDATER_UNAVAILABLE');
        const host = answer.value;
        const latestTag = VERSION.test(host.latestTag || '') ? host.latestTag : null;
        const updateAvailable = newerThanCurrent(latestTag);
        return {
          enabled: host.enabled === true,
          checkedAt: Number.isFinite(host.checkedAt) ? host.checkedAt * 1000 : null,
          currentVersion: `v${APP_VERSION}`,
          latestVersion: latestTag,
          updateAvailable,
          updateReady: updateAvailable && host.updateReady === true && host.currentVersion === APP_VERSION,
          releaseUrl: latestTag && host.releaseUrl === RELEASE_PAGE + latestTag ? host.releaseUrl : null,
          phase: String(host.phase || 'idle').slice(0, 40),
          error: typeof host.error === 'string' ? host.error.slice(0, 80) : null,
        };
      } catch { /* show the official release notice even when the host helper is absent */ }
    }
    const release = await fallback(force);
    return {
      enabled: false, checkedAt: release.checkedAt,
      currentVersion: `v${APP_VERSION}`,
      latestVersion: release.tag,
      updateAvailable: newerThanCurrent(release.tag), updateReady: false,
      releaseUrl: release.releaseUrl, phase: 'unavailable', error: release.error,
    };
  }

  async function apply(tag) {
    if (!socketPath) return { status: 503, value: { error: 'UPDATER_UNAVAILABLE' } };
    if (!VERSION.test(tag || '')) return { status: 400, value: { error: 'INVALID_TAG' } };
    try {
      const answer = await helperRequest(socketPath, '/apply', 'POST', { tag });
      return answer.status === 202 ? answer : {
        status: [400, 409, 503].includes(answer.status) ? answer.status : 503,
        value: { error: String(answer.value.error || 'UPDATER_UNAVAILABLE').slice(0, 80) },
      };
    } catch { return { status: 503, value: { error: 'UPDATER_UNAVAILABLE' } }; }
  }

  return { status, apply };
}
