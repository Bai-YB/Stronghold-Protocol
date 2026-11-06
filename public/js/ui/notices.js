// The selection-page bell shows the latest host announcement.
import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html } from './components.js';
import { t } from '../../../shared/i18n.js';
import { announcementsForCurrentVisitor } from '../announcementDismissal.js';

const REFRESH_MS = 30_000;
const HOST_SEEN_KEY = 'sp.announcements.read.v1';
const ID_PATTERN = /^[a-f0-9]{24}$/;

function readHostSeen() {
  try {
    const raw = JSON.parse(localStorage.getItem(HOST_SEEN_KEY) || '[]');
    return new Set(Array.isArray(raw) ? raw.filter((id) => typeof id === 'string' && ID_PATTERN.test(id)).slice(-200) : []);
  } catch { return new Set(); }
}

function markHostSeen(ids) {
  const seen = readHostSeen();
  for (const id of ids) if (typeof id === 'string' && ID_PATTERN.test(id)) seen.add(id);
  try { localStorage.setItem(HOST_SEEN_KEY, JSON.stringify([...seen].slice(-200))); } catch { /* keep the in-page state */ }
  return seen;
}

function formatPublishedAt(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '';
  try { return new Intl.DateTimeFormat(document.documentElement.lang || 'zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date); }
  catch { return ''; }
}

function NoticeCard({ entry, t: translate }) {
  const urgent = entry.priority === 'urgent';
  const meta = formatPublishedAt(entry.publishedAt);
  return html`<article key=${entry.id} class=${`notice-card${urgent ? ' notice-card--urgent' : ''}`}>
    <p class="notice-card__meta">
      ${urgent ? html`<span class="notice-card__badge">${translate('紧急通知')}</span>` : null}
      ${entry.audience === 'new' ? html`<span class="notice-card__badge">${translate('新手提醒')}</span>` : null}
      ${meta}
    </p>
    <h3 class="notice-card__title">${entry.title}</h3>
    <p class="notice-card__body">${entry.body}</p>
  </article>`;
}

/** Selection-page bell. The red dot clears when the user opens the rail. */
export function NoticesButton() {
  const rootRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [hostSeen, setHostSeen] = useState(() => readHostSeen());
  const [hostEntries, setHostEntries] = useState([]);
  const [hostLoaded, setHostLoaded] = useState(false);

  useEffect(() => {
    let stopped = false;
    let timer = null;
    async function refresh() {
      try {
        const response = await fetch('/announcements/api', { cache: 'no-store', credentials: 'same-origin' });
        if (!response.ok) throw new Error('ANNOUNCEMENTS_UNAVAILABLE');
        const payload = await response.json();
        const rows = Array.isArray(payload?.announcements) ? payload.announcements.filter((entry) =>
          entry && typeof entry.id === 'string' && ID_PATTERN.test(entry.id)
            && typeof entry.title === 'string' && typeof entry.body === 'string') : [];
        const visible = announcementsForCurrentVisitor(rows)
          .sort((a, b) => (Number(b.publishedAt) || 0) - (Number(a.publishedAt) || 0));
        if (!stopped) { setHostEntries(visible); setHostLoaded(true); }
      } catch { if (!stopped) setHostLoaded(true); }
      if (!stopped) timer = setTimeout(refresh, REFRESH_MS);
    }
    const onStorage = (event) => {
      if (!event.key || event.key === HOST_SEEN_KEY) setHostSeen(readHostSeen());
    };
    window.addEventListener('storage', onStorage);
    refresh();
    return () => {
      stopped = true;
      clearTimeout(timer);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => { if (event.key === 'Escape') setOpen(false); };
    const onPointerDown = (event) => { if (!rootRef.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  const latestEntry = hostEntries[0] || null;
  const unread = Boolean(latestEntry && !hostSeen.has(latestEntry.id));

  function toggle() {
    if (open) { setOpen(false); return; }
    if (latestEntry) setHostSeen(markHostSeen([latestEntry.id]));
    setOpen(true);
  }

  return html`<span class="notice-slot" ref=${rootRef}>
    <button type="button" class="notice-entry tapx" data-testid="notices-open" aria-label=${t('公告')}
      title=${t('公告')} aria-expanded=${String(open)} aria-controls="notice-popover" onClick=${toggle}>
      <svg class="notice-entry__icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      ${unread ? html`<span class="notice-entry__dot" aria-label=${t('有未读公告')}></span>` : null}
    </button>
    ${open ? html`<aside id="notice-popover" class="notice-popover" role="dialog" aria-label=${t('公告')}>
      <header class="notice-popover__heading">
        <strong>${t('公告')}</strong>
        <button type="button" class="notice-popover__close" aria-label=${t('关闭')} onClick=${() => setOpen(false)}>×</button>
      </header>
      <div class="notice-popover__body">
        ${latestEntry ? html`<section>
          <h2 class="notice-popover__section-title">${t('服主公告')}</h2>
          <div class="notice-list"><${NoticeCard} entry=${latestEntry} t=${t} /></div>
        </section>` : hostLoaded ? null : html`<p class="notice-popover__empty">${t('正在读取状态…')}</p>`}
        ${hostLoaded && !latestEntry ? html`<p class="notice-popover__empty">${t('当前没有公告。')}</p>` : null}
      </div>
      <footer class="notice-popover__footer"><a href="/status/">${t('查看服务器状态')}</a></footer>
    </aside>` : null}
  </span>`;
}
