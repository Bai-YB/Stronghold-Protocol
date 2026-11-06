// Site polls are operator-authored metadata, separate from match rules/plugins.
// A browser cookie prevents accidental repeat votes; it is not account identity
// and cannot guarantee one person per vote. Only its SHA-256 hash reaches disk.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { clientAddress } from '../net.js';
import { sendJson } from './common.js';

export const POLL_LIMITS = Object.freeze({ polls: 50, votesPerPoll: 10000, totalVotes: 100000, storeBytes: 16 * 1024 * 1024 });
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const SINGLE_LINE_CONTROLS = /[\u0000-\u001f\u007f]/;
const POLL_ID = /^[a-f0-9]{24}$/;
const OPTION_ID = /^[a-f0-9]{12}$/;
const VOTER_HASH = /^[a-f0-9]{64}$/;
const COOKIE = 'sp_poll_voter';
const COOKIE_MS = 365 * 24 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 60 * 1000;
const MAX_RATE_KEYS = 4096;

export class PollError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function record(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function timestamp(value) { return Number.isSafeInteger(value) && value >= 0; }

export function validatePoll(input, now = Date.now()) {
  if (!record(input) || Object.keys(input).some((key) => !['title', 'body', 'options', 'endsAt'].includes(key))) throw new PollError('INVALID_POLL');
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  const body = input.body === undefined ? '' : typeof input.body === 'string' ? input.body.replace(/\r\n?/g, '\n').trim() : null;
  const endsAt = input.endsAt === undefined ? null : input.endsAt;
  if (!title || title.length > 100 || SINGLE_LINE_CONTROLS.test(title)
      || body === null || body.length > 1000 || CONTROL_CHARS.test(body)
      || (endsAt !== null && (!timestamp(endsAt) || endsAt <= now))
      || !Array.isArray(input.options) || input.options.length < 2 || input.options.length > 8) throw new PollError('INVALID_POLL');
  const options = input.options.map((value) => typeof value === 'string' ? value.trim() : '');
  if (options.some((label) => !label || label.length > 100 || SINGLE_LINE_CONTROLS.test(label))
      || new Set(options.map((label) => label.normalize('NFKC').toLowerCase())).size !== options.length) throw new PollError('INVALID_POLL');
  return { title, body, options, endsAt };
}

function storedPoll(value) {
  if (!record(value) || typeof value.id !== 'string' || !POLL_ID.test(value.id) || !timestamp(value.publishedAt)
      || (value.closedAt !== null && (!timestamp(value.closedAt) || value.closedAt < value.publishedAt))
      || (value.endsAt !== null && (!timestamp(value.endsAt) || value.endsAt <= value.publishedAt))
      || !Array.isArray(value.options) || !record(value.voters)) throw new PollError('POLL_STORE_INVALID');
  const clean = validatePoll({ title: value.title, body: value.body, options: value.options.map((item) => item?.label), endsAt: value.endsAt }, value.publishedAt);
  const optionIds = value.options.map((item) => item?.id);
  if (optionIds.some((id) => typeof id !== 'string' || !OPTION_ID.test(id)) || new Set(optionIds).size !== optionIds.length) throw new PollError('POLL_STORE_INVALID');
  const voters = Object.entries(value.voters);
  if (voters.length > POLL_LIMITS.votesPerPoll || voters.some(([hash, id]) => !VOTER_HASH.test(hash) || !optionIds.includes(id))) throw new PollError('POLL_STORE_INVALID');
  return { id: value.id, ...clean, options: clean.options.map((label, index) => ({ id: optionIds[index], label })),
    publishedAt: value.publishedAt, closedAt: value.closedAt, voters: Object.fromEntries(voters) };
}

function defaultFilePath() {
  if (process.env.SP_POLLS_FILE) return process.env.SP_POLLS_FILE;
  const announcements = process.env.SP_ANNOUNCEMENTS_FILE;
  if (!announcements) return null;
  if (!path.isAbsolute(announcements)) throw new TypeError('SP_ANNOUNCEMENTS_FILE must be an absolute path');
  return path.join(path.dirname(announcements), 'polls.json');
}

function voterHash(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(token)) throw new PollError('VOTER_REQUIRED');
  return createHash('sha256').update(token).digest('hex');
}

function view(item, hash = null) {
  const votes = Object.values(item.voters);
  const counts = new Map(item.options.map((option) => [option.id, 0]));
  for (const option of votes) counts.set(option, counts.get(option) + 1);
  return { id: item.id, title: item.title, body: item.body,
    options: item.options.map((option) => ({ ...option, votes: counts.get(option.id) })), totalVotes: votes.length,
    publishedAt: item.publishedAt, closedAt: item.closedAt, endsAt: item.endsAt,
    votedOptionId: hash ? item.voters[hash] || null : null };
}

export function createPollStore({ filePath = defaultFilePath(), now = Date.now } = {}) {
  if (filePath !== null && (typeof filePath !== 'string' || !path.isAbsolute(filePath))) throw new TypeError('SP_POLLS_FILE must be an absolute path');
  let items = null;
  let pending = Promise.resolve();

  async function load() {
    if (items !== null) return;
    if (!filePath) { items = []; return; }
    try {
      const info = await stat(filePath);
      if (!info.isFile() || info.size > POLL_LIMITS.storeBytes) throw new PollError('POLL_STORE_INVALID');
      const bytes = await readFile(filePath);
      if (bytes.length > POLL_LIMITS.storeBytes) throw new PollError('POLL_STORE_INVALID');
      const parsed = JSON.parse(bytes.toString('utf8'));
      if (!record(parsed) || parsed.version !== 1 || !Array.isArray(parsed.polls) || parsed.polls.length > POLL_LIMITS.polls) throw new PollError('POLL_STORE_INVALID');
      const list = parsed.polls.map(storedPoll);
      if (new Set(list.map((item) => item.id)).size !== list.length
          || list.reduce((sum, item) => sum + Object.keys(item.voters).length, 0) > POLL_LIMITS.totalVotes) throw new PollError('POLL_STORE_INVALID');
      items = list.sort((a, b) => b.publishedAt - a.publishedAt);
    } catch (error) {
      if (error?.code === 'ENOENT') { items = []; return; }
      if (error instanceof SyntaxError || error?.code === 'INVALID_POLL') throw new PollError('POLL_STORE_INVALID');
      throw error;
    }
  }

  async function persist(next) {
    const bytes = JSON.stringify({ version: 1, polls: next }) + '\n';
    if (Buffer.byteLength(bytes) > POLL_LIMITS.storeBytes) throw new PollError('POLL_STORE_FULL');
    if (!filePath) return;
    const directory = path.dirname(filePath);
    await mkdir(directory, { recursive: true });
    const temporary = path.join(directory, '.polls-' + process.pid + '-' + randomUUID() + '.tmp');
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(bytes, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporary, filePath);
      const directoryHandle = await open(directory, 'r').catch(() => null);
      if (directoryHandle) { try { await directoryHandle.sync(); } finally { await directoryHandle.close(); } }
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
    list(token = null) {
      const hash = token === null ? null : voterHash(token);
      return serialize(async () => { await load(); return items.map((item) => view(item, hash)); });
    },
    create(input) {
      // Validate again inside the serialized change: a queued write must not create an already-ended poll.
      return serialize(async () => {
        await load();
        const publishedAt = now();
        const clean = validatePoll(input, publishedAt);
        if (items.length >= POLL_LIMITS.polls) throw new PollError('POLL_LIMIT');
        const item = { ...clean, id: randomBytes(12).toString('hex'),
          options: clean.options.map((label) => ({ id: randomBytes(6).toString('hex'), label })), publishedAt, closedAt: null, voters: {} };
        const next = [item, ...items];
        await persist(next);
        items = next;
        return view(item);
      });
    },
    vote(id, optionId, token) {
      const hash = voterHash(token);
      return serialize(async () => {
        await load();
        const index = items.findIndex((item) => item.id === id);
        if (index < 0) throw new PollError('POLL_NOT_FOUND');
        const item = items[index];
        if (item.closedAt !== null || (item.endsAt !== null && item.endsAt <= now())) throw new PollError('POLL_CLOSED');
        if (!item.options.some((option) => option.id === optionId)) throw new PollError('INVALID_OPTION');
        if (Object.hasOwn(item.voters, hash)) throw new PollError('ALREADY_VOTED');
        if (Object.keys(item.voters).length >= POLL_LIMITS.votesPerPoll
            || items.reduce((sum, poll) => sum + Object.keys(poll.voters).length, 0) >= POLL_LIMITS.totalVotes) throw new PollError('POLL_VOTE_LIMIT');
        const updated = { ...item, voters: { ...item.voters, [hash]: optionId } };
        const next = items.map((poll, i) => i === index ? updated : poll);
        await persist(next);
        items = next;
        return view(updated, hash);
      });
    },
    close(id) {
      return serialize(async () => {
        await load();
        const item = items.find((poll) => poll.id === id);
        if (!item) throw new PollError('POLL_NOT_FOUND');
        if (item.closedAt !== null) return view(item);
        const closed = { ...item, closedAt: Math.max(item.publishedAt, now()) };
        const next = items.map((poll) => poll.id === id ? closed : poll);
        await persist(next);
        items = next;
        return view(closed);
      });
    },
    remove(id) {
      return serialize(async () => {
        await load();
        const next = items.filter((item) => item.id !== id);
        if (next.length === items.length) throw new PollError('POLL_NOT_FOUND');
        await persist(next);
        items = next;
      });
    },
  });
}

export function pollHttpError(error) {
  const code = error?.code;
  const status = { INVALID_POLL: 400, INVALID_OPTION: 400, VOTER_REQUIRED: 428, POLL_NOT_FOUND: 404,
    ALREADY_VOTED: 409, POLL_CLOSED: 409, POLL_LIMIT: 409, POLL_VOTE_LIMIT: 409, POLL_STORE_FULL: 507,
    POLL_STORE_INVALID: 503 }[code];
  return status ? { status, error: code } : null;
}

function requestVoter(req) {
  const tokens = String(req.headers.cookie || '').split(';').map((part) => part.trim())
    .filter((part) => part.startsWith(COOKIE + '='));
  if (tokens.length !== 1) return null;
  const value = tokens[0].slice(COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{32}$/.test(value) ? value : null;
}

export function createPublicPollHandler({ polls, trustProxy = 'auto', readJson, isSameOrigin, requestIsSecure }) {
  const attempts = new Map();
  function limited(req, res, token) {
    const address = clientAddress(req, trustProxy);
    // Source keys are hashed and live only for one minute. Clearing cookies alone
    // does not bypass this request budget, but this remains a browser poll.
    const source = createHash('sha256').update(address.key || address.ip || 'unknown').digest('hex');
    const keys = ['source:' + source, 'voter:' + voterHash(token)];
    const now = Date.now();
    for (const [key, bucket] of attempts) if (bucket.resetAt <= now) attempts.delete(key);
    if (keys.some((key) => !attempts.has(key)) && attempts.size + keys.filter((key) => !attempts.has(key)).length > MAX_RATE_KEYS) {
      res.setHeader('Retry-After', '60');
      return true;
    }
    for (const key of keys) {
      const bucket = attempts.get(key) || { count: 0, resetAt: now + RATE_WINDOW_MS };
      const max = key.startsWith('source:') ? 60 : 20;
      if (bucket.count >= max) { res.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)))); return true; }
    }
    for (const key of keys) {
      const bucket = attempts.get(key) || { count: 0, resetAt: now + RATE_WINDOW_MS };
      bucket.count++;
      attempts.set(key, bucket);
    }
    return false;
  }
  return async function handlePoll(req, res, pathname) {
    const collection = pathname === '/polls/api';
    const vote = /^\/polls\/api\/([a-f0-9]{24})\/vote$/.exec(pathname);
    if (!collection && !vote) { sendJson(req, res, 404, { error: 'NOT_FOUND' }); return; }
    if (collection && (req.method === 'GET' || req.method === 'HEAD')) {
      const token = requestVoter(req) || randomBytes(24).toString('base64url');
      const secure = requestIsSecure(req, trustProxy) ? '; Secure' : '';
      res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/polls; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(COOKIE_MS / 1000)}${secure}`);
      try { sendJson(req, res, 200, { polls: await polls.list(token) }); }
      catch (error) { const answer = pollHttpError(error); if (!answer) throw error; sendJson(req, res, answer.status, { error: answer.error }); }
      return;
    }
    if (vote && req.method === 'POST') {
      if (!isSameOrigin(req, trustProxy)) { sendJson(req, res, 403, { error: 'BAD_ORIGIN' }); return; }
      const token = requestVoter(req);
      if (!token) { sendJson(req, res, 428, { error: 'VOTER_REQUIRED' }); return; }
      if (limited(req, res, token)) { sendJson(req, res, 429, { error: 'POLL_RATE_LIMITED' }); return; }
      const body = await readJson(req, 1024);
      if (body.error) { sendJson(req, res, body.error, { error: body.error === 413 ? 'BODY_TOO_LARGE' : body.error === 415 ? 'JSON_REQUIRED' : 'BAD_REQUEST' }); return; }
      if (Object.keys(body.value).length !== 1 || typeof body.value.optionId !== 'string' || !OPTION_ID.test(body.value.optionId)) { sendJson(req, res, 400, { error: 'INVALID_OPTION' }); return; }
      try { sendJson(req, res, 200, { ok: true, poll: await polls.vote(vote[1], body.value.optionId, token) }); }
      catch (error) { const answer = pollHttpError(error); if (!answer) throw error; sendJson(req, res, answer.status, { error: answer.error }); }
      return;
    }
    res.setHeader('Allow', collection ? 'GET, HEAD' : 'POST');
    sendJson(req, res, 405, { error: 'METHOD_NOT_ALLOWED' });
  };
}
