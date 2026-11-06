// Small public site settings. When announcements use persistent storage, keep
// these settings beside them so existing deployments retain admin changes.
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

export const PLUGIN_NOTICE_POSITIONS = Object.freeze([
  'right-above-meta',
  'center-above-copyright',
  'left-above-actions',
  'hidden',
]);

export const DEFAULT_SITE_SETTINGS = Object.freeze({ pluginNoticePosition: 'right-above-meta' });

const MAX_STORE_BYTES = 4096;

function defaultFilePath() {
  if (process.env.SP_SITE_SETTINGS_FILE) return process.env.SP_SITE_SETTINGS_FILE;
  if (process.env.SP_ANNOUNCEMENTS_FILE) {
    return path.join(path.dirname(process.env.SP_ANNOUNCEMENTS_FILE), 'site-settings.json');
  }
  return null;
}

export function normalizeSiteSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some((key) => key !== 'pluginNoticePosition')
      || !PLUGIN_NOTICE_POSITIONS.includes(input.pluginNoticePosition)) return null;
  return { pluginNoticePosition: input.pluginNoticePosition };
}

export function createSiteSettingsStore({ filePath = defaultFilePath() } = {}) {
  if (filePath !== null && (typeof filePath !== 'string' || !path.isAbsolute(filePath))) {
    throw new TypeError('SP_SITE_SETTINGS_FILE must be an absolute path');
  }

  let settings = null;
  let pending = Promise.resolve();

  async function load() {
    if (settings !== null) return;
    if (!filePath) { settings = { ...DEFAULT_SITE_SETTINGS }; return; }
    try {
      const info = await stat(filePath);
      if (info.size > MAX_STORE_BYTES) throw new Error('SITE_SETTINGS_STORE_INVALID');
      const parsed = JSON.parse(await readFile(filePath, 'utf8'));
      settings = normalizeSiteSettings(parsed);
      if (!settings) throw new Error('SITE_SETTINGS_STORE_INVALID');
    } catch (error) {
      if (error?.code === 'ENOENT') { settings = { ...DEFAULT_SITE_SETTINGS }; return; }
      throw error;
    }
  }

  async function persist(next) {
    if (!filePath) return;
    const directory = path.dirname(filePath);
    await mkdir(directory, { recursive: true });
    const temporary = path.join(directory, '.site-settings-' + process.pid + '-' + randomUUID() + '.tmp');
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(next) + '\n', 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporary, filePath);
      const dirHandle = await open(directory, 'r').catch(() => null);
      if (dirHandle) {
        try { await dirHandle.sync(); } finally { await dirHandle.close(); }
      }
    } finally {
      if (handle) await handle.close().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  function serialize(operation) {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  }

  return Object.freeze({
    get() {
      return serialize(async () => { await load(); return { ...settings }; });
    },
    update(input) {
      const clean = normalizeSiteSettings(input);
      if (!clean) throw new TypeError('INVALID_SITE_SETTINGS');
      return serialize(async () => {
        await load();
        await persist(clean);
        settings = clean;
        return { ...settings };
      });
    },
  });
}
