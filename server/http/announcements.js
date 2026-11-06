// File-backed public announcements. The production Compose mounts /app/state so
// notices survive container replacement; the default in-memory store keeps local
// development usable without creating data files in the source tree.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const MAX_ITEMS = 100;
const MAX_STORE_BYTES = 512 * 1024;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export class AnnouncementError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function normalizeAnnouncement(input) {
  try { return validateAnnouncement(input); }
  catch { return null; }
}

export function validateAnnouncement(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AnnouncementError('BAD_REQUEST');
  if (Object.keys(input).some((key) => !['title', 'body', 'priority', 'audience'].includes(key))) throw new AnnouncementError('BAD_REQUEST');
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  const body = typeof input.body === 'string' ? input.body.replace(/\r\n?/g, '\n').trim() : '';
  const priority = input.priority === undefined ? 'normal' : input.priority;
  const audience = input.audience === undefined ? 'all' : input.audience;
  if (!title || title.length > 80 || CONTROL_CHARS.test(title)) throw new AnnouncementError('INVALID_TITLE');
  if (!body || body.length > 1200 || CONTROL_CHARS.test(body)) throw new AnnouncementError('INVALID_BODY');
  if (priority !== 'normal' && priority !== 'urgent') throw new AnnouncementError('INVALID_PRIORITY');
  if (audience !== 'all' && audience !== 'new') throw new AnnouncementError('INVALID_AUDIENCE');
  return { title, body, priority, audience };
}

function storedItem(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || typeof value.id !== 'string' || !/^[0-9a-f]{24}$/i.test(value.id)
      || typeof value.title !== 'string' || typeof value.body !== 'string'
      || !['normal', 'urgent'].includes(value.priority || 'normal')
      || !['all', 'new'].includes(value.audience || 'all')
      || !Number.isSafeInteger(value.publishedAt) || value.publishedAt < 0) {
    throw new AnnouncementError('ANNOUNCEMENT_STORE_INVALID');
  }
  return {
    id: value.id,
    title: value.title.slice(0, 80),
    body: value.body.slice(0, 1200),
    priority: value.priority || 'normal',
    audience: value.audience || 'all',
    publishedAt: value.publishedAt,
  };
}

export function createAnnouncementStore({ filePath = process.env.SP_ANNOUNCEMENTS_FILE || null } = {}) {
  if (filePath !== null && (typeof filePath !== 'string' || !path.isAbsolute(filePath))) {
    throw new TypeError('SP_ANNOUNCEMENTS_FILE must be an absolute path');
  }
  let items = null;
  let pending = Promise.resolve();

  async function load() {
    if (items !== null) return;
    if (!filePath) { items = []; return; }
    try {
      const info = await stat(filePath);
      if (info.size > MAX_STORE_BYTES) throw new AnnouncementError('ANNOUNCEMENT_STORE_INVALID');
      const parsed = JSON.parse(await readFile(filePath, 'utf8'));
      if (!Array.isArray(parsed) || parsed.length > MAX_ITEMS) throw new AnnouncementError('ANNOUNCEMENT_STORE_INVALID');
      items = parsed.map(storedItem).sort((a, b) => b.publishedAt - a.publishedAt);
    } catch (error) {
      if (error?.code === 'ENOENT') { items = []; return; }
      throw error;
    }
  }

  async function persist(next) {
    if (!filePath) return;
    const directory = path.dirname(filePath);
    await mkdir(directory, { recursive: true });
    const temporary = path.join(directory, '.announcements-' + process.pid + '-' + randomUUID() + '.tmp');
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

  const clone = (item) => ({ ...item });
  const publicView = (list) => list.map(({ id, title, body, priority, audience, publishedAt }) => ({ id, title, body, priority, audience: audience || 'all', publishedAt }));
  return Object.freeze({
    list() {
      return serialize(async () => { await load(); return items.map(clone); });
    },
    publicList(limit = MAX_ITEMS) {
      return serialize(async () => {
        await load();
        const count = Number.isInteger(limit) ? Math.max(0, Math.min(MAX_ITEMS, limit)) : MAX_ITEMS;
        return publicView(items.slice(0, count));
      });
    },
    publicHistory(limit = 5) {
      return serialize(async () => {
        await load();
        const count = Number.isInteger(limit) ? Math.max(0, Math.min(MAX_ITEMS, limit)) : 5;
        return publicView(items.filter((item) => item.priority !== 'urgent').slice(0, count));
      });
    },
    create(input) {
      const clean = validateAnnouncement(input);
      return serialize(async () => {
        await load();
        if (items.length >= MAX_ITEMS) throw new AnnouncementError('ANNOUNCEMENT_LIMIT');
        const item = { id: randomBytes(12).toString('hex'), ...clean, publishedAt: Date.now() };
        const next = [item, ...items];
        await persist(next);
        items = next;
        return clone(item);
      });
    },
    remove(id) {
      return serialize(async () => {
        await load();
        const next = items.filter((item) => item.id !== id);
        if (next.length === items.length) return false;
        await persist(next);
        items = next;
        return true;
      });
    },
  });
}
