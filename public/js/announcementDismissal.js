const STORAGE_KEY = 'sp.announcements.dismissed.v1';
const VISITOR_KEY = 'sp.visitor.seen.v1';
const WELCOME_PENDING_KEY = 'sp.visitor.welcome-pending.v1';
const ID_PATTERN = /^[a-f0-9]{24}$/;
const sessionDismissed = new Set();
let sessionVisitorSeen = false;
let sessionWelcomePending = new Set();

export function dismissedAnnouncementIds() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    const ids = new Set(Array.isArray(value) ? value.filter((id) => typeof id === 'string' && ID_PATTERN.test(id)) : []);
    for (const id of sessionDismissed) ids.add(id);
    return ids;
  } catch {
    return new Set(sessionDismissed);
  }
}

export function dismissAnnouncement(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) return;
  const ids = [...dismissedAnnouncementIds()].filter((value) => value !== id);
  ids.push(id);
  sessionDismissed.delete(id);
  sessionDismissed.add(id);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(ids.slice(-200))); }
  catch { /* dismissal remains effective for the current render */ }
  const pending = welcomePendingIds();
  if (pending.delete(id)) saveWelcomePending(pending);
}

function welcomePendingIds() {
  try {
    const value = JSON.parse(localStorage.getItem(WELCOME_PENDING_KEY) || '[]');
    const pending = new Set(Array.isArray(value) ? value.filter((id) => typeof id === 'string' && ID_PATTERN.test(id)) : []);
    for (const id of sessionWelcomePending) pending.add(id);
    return pending;
  } catch {
    return new Set(sessionWelcomePending);
  }
}

function saveWelcomePending(ids) {
  sessionWelcomePending = new Set(ids);
  try {
    localStorage.setItem(WELCOME_PENDING_KEY, JSON.stringify([...ids].slice(-20)));
    return true;
  } catch {
    /* the current session still remembers which welcome notice is active */
    return false;
  }
}

/**
 * Select announcements for this browser. A first successful load records at most one welcome notice;
 * it remains eligible until dismissed, including across a reload. No identity or server-side tracking is used.
 */
export function announcementsForCurrentVisitor(entries) {
  const list = Array.isArray(entries) ? entries : [];
  let visited;
  try { visited = localStorage.getItem(VISITOR_KEY) === '1'; }
  catch { visited = sessionVisitorSeen; }

  if (!visited) {
    const welcome = list.find((entry) => entry && entry.audience === 'new' && typeof entry.id === 'string');
    const pending = new Set(welcome ? [welcome.id] : []);
    saveWelcomePending(pending);
    sessionVisitorSeen = true;
    try { localStorage.setItem(VISITOR_KEY, '1'); } catch { /* use a session-only marker when storage is blocked */ }
    return list.filter((entry) => entry?.audience !== 'new' || entry.id === welcome?.id);
  }

  const pending = welcomePendingIds();
  return list.filter((entry) => entry?.audience !== 'new' || pending.has(entry.id));
}
