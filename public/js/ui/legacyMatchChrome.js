// The v0.3.1 pre-game header retained for the migrated briefing and strategy draft screens.
import { html, Button, PingPill, DifficultyTag, Countdown, MicroLabel } from './components.js';
import { useStore, shallowEqual } from '../store.js';
import { GuideButton } from './guide.js';
import { TestMark } from './testConsole.js';
import { t } from '../../../shared/i18n.js';

export function LegacyStepHeader({ step, of, title, micro, pub, total, onExit }) {
  const conn = useStore((s) => s.connection, shallowEqual);
  return html`<header class="stephead">
    <div class="stephead__left">
      <${Button} variant="danger" size="lg" square=${true} icon="exit" onClick=${onExit} aria-label=${t('离开')} title=${t('离开')} />
      <div class="stephead__meta">
        <${PingPill} ms=${conn.ping} online=${conn.status === 'online'} />
        ${pub?.difficulty ? html`<${DifficultyTag} difficulty=${pub.difficulty} />` : null}
        ${pub?.test ? html`<${TestMark} />` : null}
      </div>
    </div>
    <div class="stephead__center">
      <${MicroLabel} tone="mint">${micro}</${MicroLabel}>
      <h1 class="stephead__title"><b class="num">${step}</b><span class="num stephead__of">/${of}</span>${title}</h1>
    </div>
    <div class="stephead__right">
      <${GuideButton} class="stephead__guide" variant="secondary" />
      <${Countdown} deadline=${pub?.deadline} total=${total ?? undefined} size="md" />
    </div>
  </header>`;
}
