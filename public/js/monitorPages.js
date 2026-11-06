import { t } from '../../shared/i18n.js';

/** Public histories show the latest entry or the five most recent entries, including that latest entry. */
export function publicHistoryItems(items, expanded = false) {
  return (Array.isArray(items) ? items : []).slice(0, expanded ? 5 : 1);
}

/** Hash navigation keeps panels mounted so forms, filters and focus survive live refreshes. */
export function mountPageNavigation({ root, attribute, navigation, pages, defaultPage, onChange }) {
  const links = new Map();
  for (const [id, title] of pages) {
    const link = document.createElement('a');
    link.href = `#${id}`;
    link.textContent = t(title);
    links.set(id, link);
    navigation.append(link);
  }
  navigation.setAttribute('aria-label', t('页面导航'));
  let current = null;
  function activate() {
    const requested = location.hash.slice(1);
    const id = links.has(requested) ? requested : defaultPage;
    if (current === id) return;
    current = id;
    for (const panel of root.querySelectorAll(`[${attribute}]`)) panel.hidden = panel.getAttribute(attribute) !== id;
    for (const [page, link] of links) {
      if (page === id) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    onChange?.(id, pages.find(([page]) => page === id)?.[1]);
  }
  window.addEventListener('hashchange', activate);
  activate();
  return { current: () => current };
}

export function element(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = text;
  return node;
}

export function button(text, action, className = 'button button--quiet') {
  const node = element('button', className, text);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

export function mountPager(root, onChange, pageSize = 10) {
  let page = 1;
  let totalPages = 1;
  const nav = element('nav', 'list-pagination');
  nav.setAttribute('aria-label', t('列表分页'));
  const previous = button(t('上一页'), () => { page--; onChange(); });
  const description = element('span', 'list-pagination__description');
  description.setAttribute('aria-live', 'polite');
  const next = button(t('下一页'), () => { page++; onChange(); });
  nav.append(previous, description, next);
  root.append(nav);
  return {
    reset() { page = 1; },
    slice(list) {
      totalPages = Math.max(1, Math.ceil(list.length / pageSize));
      page = Math.max(1, Math.min(page, totalPages));
      previous.disabled = page <= 1;
      next.disabled = page >= totalPages;
      description.textContent = t('第 {page} / {pages} 页 · 共 {total} 条', { page, pages: totalPages, total: list.length });
      return list.slice((page - 1) * pageSize, page * pageSize);
    },
  };
}
