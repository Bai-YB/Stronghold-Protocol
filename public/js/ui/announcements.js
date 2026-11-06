// Public urgent announcements (server/http/announcements.js). A player's dismissal is shared by the game and the
// public status page through localStorage, so closing a notice in one tab hides it in the others too.
import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html } from './components.js';
import { announcementsForCurrentVisitor, dismissAnnouncement, dismissedAnnouncementIds } from '../announcementDismissal.js';
import { mountAnnouncementMarquee } from '../announcementMarquee.js';
import { t } from '../../../shared/i18n.js';

const REFRESH_MS = 30_000;

function AnnouncementMarquee({ message }) {
  const viewportRef = useRef(null);
  const trackRef = useRef(null);
  useEffect(() => mountAnnouncementMarquee(viewportRef.current, trackRef.current, message, {
    durationProperty: '--notice-duration', shiftProperty: '--notice-shift',
  }), [message]);
  return html`<div class="urgent-announcement__viewport" ref=${viewportRef}>
    <div class="urgent-announcement__track" ref=${trackRef}></div>
  </div>`;
}

export function UrgentAnnouncementHost() {
  const [entries, setEntries] = useState([]);
  const [dismissed, setDismissed] = useState(() => dismissedAnnouncementIds());

  useEffect(() => {
    let closed = false;
    let timer = null;
    async function refresh() {
      try {
        const response = await fetch('/announcements/api', { cache: 'no-store', credentials: 'same-origin' });
        if (response.ok) {
          const payload = await response.json();
          const received = Array.isArray(payload?.announcements) ? payload.announcements.filter((entry) =>
            entry && typeof entry.id === 'string' && typeof entry.title === 'string'
              && typeof entry.body === 'string' && (entry.priority === 'urgent' || entry.audience === 'new')) : [];
          const next = announcementsForCurrentVisitor(received);
          if (!closed) setEntries(next);
        }
      } catch { /* the game remains usable while the announcement endpoint is unavailable */ }
      if (!closed) timer = setTimeout(refresh, REFRESH_MS);
    }
    const onStorage = () => setDismissed(dismissedAnnouncementIds());
    window.addEventListener('storage', onStorage);
    refresh();
    return () => {
      closed = true;
      clearTimeout(timer);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const active = entries.filter((entry) => !dismissed.has(entry.id));
  if (!active.length) return null;

  function dismiss(id) {
    dismissAnnouncement(id);
    setDismissed((previous) => new Set([...previous, id]));
  }

  return html`<aside class="urgent-announcement-host" aria-label=${t('公告提醒')}>
    ${active.map((entry) => {
      const message = `${entry.title} · ${entry.body}`;
      const welcome = entry.audience === 'new';
      return html`<div key=${entry.id} class=${`urgent-announcement${welcome ? ' urgent-announcement--welcome' : ''}`} role="status" aria-live="polite">
        <strong class="urgent-announcement__label">${t(welcome ? '新手提醒' : '加急通知')}</strong>
        <${AnnouncementMarquee} message=${message} />
        ${welcome ? html`<a class="urgent-announcement__link" href="/status/">${t('查看服务器状态')}</a>` : null}
        <button class="urgent-announcement__close" type="button" aria-label=${t('关闭此加急通知')}
                onClick=${() => dismiss(entry.id)}>×</button>
      </div>`;
    })}
  </aside>`;
}
