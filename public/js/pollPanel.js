import { N_, t } from '../../shared/i18n.js';
import { button, element, mountPager, publicHistoryItems } from './monitorPages.js';

const failureLabels = {
  ALREADY_VOTED: N_('此浏览器已参与该投票，请勿重复提交。'),
  POLL_CLOSED: N_('投票已结束，请查看结果。'),
  POLL_LIMIT: N_('投票列表已满，请先删除旧投票。'),
  POLL_VOTE_LIMIT: N_('该投票已达到参与人数上限。'),
  INVALID_POLL: N_('请填写标题及 2 至 8 个不同选项，并检查截止时间。'),
  INVALID_OPTION: N_('请选择一个有效选项。'),
  POLL_NOT_FOUND: N_('此投票已删除，请刷新列表。'),
  POLL_RATE_LIMITED: N_('操作过于频繁，请稍后重试。'),
  POLL_STORE_FULL: N_('投票存储已满，请联系管理员。'),
};
const isClosed = (poll) => poll.closedAt != null || (poll.endsAt != null && Number(new Date(poll.endsAt)) <= Date.now());
const formatTime = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '—' : new Intl.DateTimeFormat(document.documentElement.lang || 'zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(date);
};

/** Shared admin publisher and public single-choice ballots, with drafts retained between snapshots. */
export function mountPollPanel(root, { admin = false, onUnauthorized = () => {} } = {}) {
  const base = admin ? '/admin/api/polls' : '/polls/api';
  let polls = [];
  let signature = '';
  let loading = false;
  let mutating = false;
  let loaded = false;
  let mutationEpoch = 0;
  let pendingRefresh = false;
  let pendingFocus = null;
  let historyExpanded = false;
  const choices = new Map();
  const messages = new Map();
  const heading = element('div', 'section-heading');
  const title = element('h2', '', t(admin ? N_('投票管理') : N_('社区投票')));
  title.id = `${admin ? 'admin' : 'public'}-polls-heading`;
  title.tabIndex = -1;
  root.setAttribute('aria-labelledby', title.id);
  heading.append(title);
  const note = element('p', 'poll-panel__note', t(admin ? N_('发布后会显示在公开资源页面，所有访问者均可参与。') : N_('每项投票为单选，同一浏览器每项可投一票。')));
  const message = element('p', 'poll-panel__message');
  message.setAttribute('role', 'status');
  message.setAttribute('aria-live', 'polite');
  root.append(heading, note);
  if (admin) createPublisher();
  const filterLabel = element('label', 'list-filter poll-filter');
  const filter = document.createElement('select');
  for (const [value, text] of [['all', N_('全部投票')], ['open', N_('进行中')], ['closed', N_('已结束')]]) {
    const option = element('option', '', t(text)); option.value = value; filter.append(option);
  }
  filterLabel.append(element('span', '', t('投票状态')), filter);
  const list = element('div', 'poll-list');
  list.id = admin ? 'admin-poll-list' : 'public-poll-list';
  if (admin) root.append(filterLabel);
  root.append(message, list);
  const historyToggle = admin ? null : button('', () => { historyExpanded = !historyExpanded; render(); }, 'button public-history-toggle');
  if (historyToggle) {
    historyToggle.hidden = true;
    historyToggle.setAttribute('aria-controls', list.id);
    historyToggle.setAttribute('aria-expanded', 'false');
    root.append(historyToggle);
  }
  const pager = admin ? mountPager(root, render, 5) : null;
  filter.addEventListener('change', () => { pager?.reset(); render(); });

  function setMessage(text) { message.textContent = text; }
  function focusedControl() {
    const active = document.activeElement;
    if (!list.contains(active)) return null;
    const card = active.closest('.poll-card');
    return card ? { pollId: card.dataset.pollId, optionId: active.dataset.pollOption, action: active.dataset.pollAction } : null;
  }
  function restoreFocus(focus) {
    const card = [...list.children].find((entry) => entry.dataset.pollId === focus.pollId);
    const control = card && [...card.querySelectorAll('input,button')].find((entry) => !entry.disabled
      && ((focus.optionId && entry.dataset.pollOption === focus.optionId) || (focus.action && entry.dataset.pollAction === focus.action)));
    // If a poll closed or the control disappeared, keep focus on its result card.
    (control || card || (admin ? filter : title)).focus({ preventScroll: true });
  }
  function beginMutation() {
    pendingFocus = focusedControl();
    mutationEpoch++;
    mutating = true;
    // A GET that began before this write cannot publish its snapshot afterwards.
    pendingRefresh = true;
  }
  function finishMutation() {
    mutating = false;
    if (pendingRefresh) { pendingRefresh = false; return refresh(); }
  }

  async function request(path = '', init = {}) {
    const response = await fetch(`${base}${path}`, { credentials: 'same-origin', cache: 'no-store', ...init });
    if (admin && response.status === 401) { onUnauthorized(); throw new Error('AUTH'); }
    let payload = {};
    try { payload = await response.json(); } catch { /* handled as a request failure */ }
    if (!response.ok) throw new Error(payload.error || 'POLL_REQUEST_FAILED');
    return payload;
  }
  function failure(error) {
    return error?.message === 'AUTH' ? t('登录已过期，请重新登录。') : t(failureLabels[error?.message] || N_('投票操作失败，请稍后重试。'));
  }
  function field(form, label, input) {
    const wrapper = element('label', 'poll-publisher__field');
    wrapper.append(element('span', '', label), input);
    form.append(wrapper);
    return input;
  }
  function createPublisher() {
    const form = element('form', 'poll-publisher');
    const titleInput = document.createElement('input');
    titleInput.maxLength = 100; titleInput.required = true;
    field(form, t('投票标题'), titleInput);
    const body = document.createElement('textarea');
    body.maxLength = 1000; body.rows = 3;
    field(form, t('投票说明（可选）'), body);
    const options = element('fieldset', 'poll-publisher__options');
    options.append(element('legend', '', t('投票选项（2 至 8 个）')));
    const inputs = element('div', 'poll-option-inputs');
    const add = button(t('添加选项'), addOption);
    options.append(inputs, add);
    function updateOptions() {
      add.disabled = inputs.children.length >= 8;
      for (const row of inputs.children) row.querySelector('button').disabled = inputs.children.length <= 2;
    }
    function addOption() {
      if (inputs.children.length >= 8) return;
      const row = element('div', 'poll-option-input');
      const input = document.createElement('input');
      input.maxLength = 100; input.required = true;
      input.setAttribute('aria-label', t('投票选项'));
      row.append(input, button(t('移除选项'), () => { row.remove(); updateOptions(); }));
      inputs.append(row);
      updateOptions();
    }
    addOption(); addOption();
    form.append(options);
    const ends = document.createElement('input');
    ends.type = 'datetime-local';
    field(form, t('截止时间（可选，按本机时间）'), ends);
    const submit = element('button', 'button button--primary', t('发布投票'));
    submit.type = 'submit';
    form.append(submit);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (mutating || !form.reportValidity()) return;
      const optionValues = [...inputs.querySelectorAll('input')].map((input) => input.value.trim());
      const endsAt = ends.value ? Number(new Date(ends.value)) : null;
      if (!titleInput.value.trim() || optionValues.some((value) => !value) || new Set(optionValues).size !== optionValues.length || (endsAt !== null && (!Number.isFinite(endsAt) || endsAt <= Date.now()))) {
        setMessage(t(failureLabels.INVALID_POLL)); return;
      }
      beginMutation(); submit.disabled = true; setMessage('');
      try {
        await request('', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: titleInput.value.trim(), body: body.value.trim(), options: optionValues, endsAt }) });
        form.reset();
        while (inputs.children.length > 2) inputs.lastElementChild.remove();
        updateOptions();
        setMessage(t('投票已发布。'));
        signature = '';
      } catch (error) { setMessage(failure(error)); }
      finally { submit.disabled = false; await finishMutation(); }
    });
    root.append(form);
  }
  function render() {
    const focus = focusedControl() || (document.activeElement === document.body ? pendingFocus : null);
    pendingFocus = null;
    const visible = polls.filter((poll) => filter.value === 'all' || isClosed(poll) === (filter.value === 'closed'));
    if (historyToggle) {
      const count = Math.min(visible.length, 5);
      if (count <= 1) historyExpanded = false;
      historyToggle.hidden = count <= 1;
      historyToggle.setAttribute('aria-expanded', String(historyExpanded));
      historyToggle.textContent = historyExpanded ? t('收起投票') : t('展开最近 {n} 项投票', { n: count });
    }
    const fragment = document.createDocumentFragment();
    for (const poll of pager ? pager.slice(visible) : publicHistoryItems(visible, historyExpanded)) {
      const card = element('article', 'poll-card');
      card.dataset.pollId = poll.id;
      card.tabIndex = -1;
      const top = element('div', 'poll-card__heading');
      const closed = isClosed(poll);
      top.append(element('h3', '', poll.title), element('span', `poll-state${closed ? ' poll-state--closed' : ''}`, t(closed ? N_('已结束') : N_('进行中'))));
      card.append(top);
      if (poll.body) card.append(element('p', 'poll-card__body', poll.body));
      const meta = element('p', 'poll-card__meta', t('共 {n} 票', { n: Math.max(0, Number(poll.totalVotes) || 0) }));
      if (poll.endsAt) meta.append(document.createTextNode(` · ${t('截止于 {time}', { time: formatTime(poll.endsAt) })}`));
      card.append(meta);
      const form = element('form', 'poll-ballot');
      const fieldset = element('fieldset', 'poll-ballot__options');
      fieldset.append(element('legend', 'visually-hidden', t('投票选项')));
      const voted = poll.votedOptionId;
      for (const option of poll.options || []) {
        const row = element(admin ? 'div' : 'label', 'poll-option');
        const bar = element('span', 'poll-option__bar');
        bar.style.width = `${poll.totalVotes > 0 ? Math.min(100, Math.max(0, option.votes / poll.totalVotes * 100)) : 0}%`;
        bar.setAttribute('aria-hidden', 'true');
        row.append(bar);
        if (!admin) {
          const input = document.createElement('input');
          input.dataset.pollOption = option.id;
          input.setAttribute('aria-label', option.label);
          input.type = 'radio'; input.name = `poll-${poll.id}`; input.value = option.id; input.required = true;
          input.disabled = !!voted || closed;
          input.checked = (voted || choices.get(poll.id)) === option.id;
          input.addEventListener('change', () => choices.set(poll.id, option.id));
          row.append(input);
        }
        row.append(element('span', 'poll-option__label', option.label), element('span', 'poll-option__votes', t('{n} 票', { n: Math.max(0, Number(option.votes) || 0) })));
        fieldset.append(row);
      }
      form.append(fieldset);
      const feedback = element('p', 'poll-card__feedback', messages.get(poll.id) || (voted ? t('你已投票，感谢参与。') : ''));
      feedback.setAttribute('role', 'status');
      if (!admin && !closed && !voted) {
        const submit = element('button', 'button button--primary', t('提交投票'));
        submit.dataset.pollAction = 'vote';
        submit.type = 'submit';
        form.append(submit);
        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          if (mutating || !form.reportValidity()) return;
          beginMutation(); submit.disabled = true;
          try {
            const payload = await request(`/${encodeURIComponent(poll.id)}/vote`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ optionId: choices.get(poll.id) }) });
            messages.delete(poll.id);
            if (payload.poll) polls = polls.map((entry) => entry.id === poll.id ? payload.poll : entry);
            signature = ''; render();
          } catch (error) {
            messages.set(poll.id, failure(error)); feedback.textContent = failure(error);
            if (['ALREADY_VOTED', 'POLL_CLOSED', 'POLL_NOT_FOUND'].includes(error.message)) { signature = ''; }
          } finally { submit.disabled = false; await finishMutation(); }
        });
      }
      card.append(form, feedback);
      if (admin) {
        const actions = element('div', 'poll-card__actions');
        if (!closed) {
          const close = button(t('结束投票'), () => mutate(poll, 'close'));
          close.dataset.pollAction = 'close';
          actions.append(close);
        }
        const remove = button(t('删除投票'), () => {
          if (confirm(t('确定删除投票“{title}”及全部结果？', { title: poll.title }))) mutate(poll, 'delete');
        }, 'button button--quiet poll-delete');
        remove.dataset.pollAction = 'delete';
        actions.append(remove);
        card.append(actions);
      }
      fragment.append(card);
    }
    if (!visible.length) fragment.append(element('p', 'empty-state', t(loaded ? N_('当前没有符合条件的投票。') : N_('正在读取投票…'))));
    list.replaceChildren(fragment);
    if (focus) restoreFocus(focus);
  }
  async function mutate(poll, operation) {
    if (mutating) return;
    beginMutation();
    setMessage('');
    try {
      await request(`/${encodeURIComponent(poll.id)}${operation === 'close' ? '/close' : ''}`, { method: operation === 'close' ? 'POST' : 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      setMessage(t(operation === 'close' ? N_('投票已结束。') : N_('投票已删除。')));
      signature = '';
    } catch (error) { setMessage(failure(error)); }
    finally { await finishMutation(); }
  }
  async function refresh() {
    if (loading || mutating) { pendingRefresh = true; return; }
    loading = true;
    const epoch = mutationEpoch;
    try {
      const payload = await request();
      if (epoch !== mutationEpoch) { pendingRefresh = true; return; }
      const next = Array.isArray(payload.polls) ? payload.polls : [];
      const nextSignature = JSON.stringify(next.map((poll) => [poll, isClosed(poll)]));
      polls = next; loaded = true;
      if (nextSignature !== signature) { signature = nextSignature; render(); }
      else if (pendingFocus) {
        if (document.activeElement === document.body) restoreFocus(pendingFocus);
        pendingFocus = null;
      }
    } catch (error) {
      if (epoch !== mutationEpoch) { pendingRefresh = true; return; }
      setMessage(failure(error));
      if (!loaded) list.replaceChildren(element('p', 'empty-state', t('暂时无法读取投票。')));
    } finally {
      loading = false;
      if (pendingRefresh && !mutating) { pendingRefresh = false; queueMicrotask(() => refresh()); }
    }
  }
  render();
  return { refresh };
}
