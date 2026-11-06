import { N_, t } from '../../shared/i18n.js';
import { DIFFICULTIES, DIFFICULTY_NAMES } from '../../shared/constants.js';
import { button, element, mountPager } from './monitorPages.js';

const states = {
  playing: N_('游戏中'), spectating: N_('对局观战'), room: N_('房间等待'), queued: N_('匹配中'), lobby: N_('大厅在线'),
};
const difficulty = (value) => DIFFICULTIES.includes(value) ? t(DIFFICULTY_NAMES[value]) : '—';
const mode = (value) => value === 'solo' ? t('独立模拟') : t('同盟模拟');
/** The room's kind as the admin page classifies it: a custom (modded) room, the endless ladder, the matchmaking queue, or solo/co-op. */
const roomMode = (room) => room?.runKind === 'endless' ? t('无尽模式') : room?.custom ? t('自定义对局') : room?.matchmaking ? t('同盟匹配') : mode(room?.mode);
const roomModeKey = (room) => room?.runKind === 'endless' ? 'endless' : room?.custom ? 'custom' : room?.matchmaking ? 'matchmaking' : (room?.mode === 'solo' ? 'solo' : 'coop');
const roomState = (room) => room.state === 'running' ? t('进行中') : room.matchmaking ? t('匹配中') : t('等待中');
const round = (room) => room.state !== 'running' ? '—' : room.round === 0 ? t('准备中') : Number.isSafeInteger(room.round) && room.round > 0 ? t('第 {r} 回合', { r: room.round }) : '—';
const playerKey = (player) => String(player.id ?? `${player.name}\n${player.roomCode || ''}`);

/** Stable component state is kept outside the 5-second snapshot rendering. */
export function mountAdminBrowser(root) {
  let snapshot = { players: [], rooms: [] };
  let selected = null;
  let detailSignature = '';
  const views = {};
  const dialog = element('dialog', 'monitor-detail');
  const heading = element('h2', '', t('详情'));
  heading.id = 'monitor-detail-heading';
  dialog.setAttribute('aria-labelledby', heading.id);
  const close = button(t('关闭'), () => dialog.close());
  const header = element('div', 'monitor-detail__heading');
  const content = element('div', 'monitor-detail__content');
  header.append(heading, close);
  dialog.append(header, content);
  root.append(dialog);
  dialog.addEventListener('close', () => { selected = null; });
  function openDetail(kind, id) {
    selected = { kind, id };
    detailSignature = '';
    renderDetail();
    if (!dialog.open) dialog.showModal();
  }
  function addFact(list, label, value) {
    const item = element('div');
    item.append(element('dt', '', label), element('dd', '', String(value ?? '—')));
    list.append(item);
  }
  function renderDetail() {
    if (!selected) return;
    const kind = selected.kind;
    const entry = kind === 'players'
      ? snapshot.players.find((player) => playerKey(player) === selected.id)
      : snapshot.rooms.find((room) => room.code === selected.id);
    const signature = JSON.stringify([selected, entry, kind === 'rooms' ? snapshot.players.filter((player) => player.roomCode === entry?.code) : snapshot.rooms.find((room) => room.code === entry?.roomCode)]);
    if (signature === detailSignature) return;
    detailSignature = signature;
    heading.textContent = t(kind === 'players' ? N_('玩家详情') : N_('房间详情'));
    const facts = element('dl', 'monitor-detail__facts');
    if (!entry) {
      content.replaceChildren(element('p', 'empty-state', t('此玩家已离线或房间已关闭。')));
      return;
    }
    if (kind === 'players') {
      addFact(facts, t('玩家'), entry.name);
      addFact(facts, t('状态'), t(states[entry.status] || states.lobby));
      addFact(facts, t('房间'), entry.roomCode);
      const room = snapshot.rooms.find((room) => room.code === entry.roomCode);
      addFact(facts, t('模式'), room ? roomMode(room) : entry.mode ? mode(entry.mode) : '—');
      addFact(facts, t('难度'), difficulty(entry.difficulty));
      if (room) addFact(facts, t('回合'), round(room));
      content.replaceChildren(facts);
      if (room) content.append(button(t('查看房间详情'), () => openDetail('rooms', room.code)));
    } else {
      addFact(facts, t('房间'), entry.code);
      addFact(facts, t('模式'), roomMode(entry));
      addFact(facts, t('难度'), difficulty(entry.difficulty));
      if (entry.version) addFact(facts, t('版本'), entry.version);
      addFact(facts, t('状态'), roomState(entry));
      addFact(facts, t('回合'), round(entry));
      addFact(facts, t('真人'), `${entry.connectedHumans || 0}/${entry.humans || 0}`);
      addFact(facts, t('AI'), entry.bots || 0);
      addFact(facts, t('观战'), entry.spectators || 0);
      const list = element('ul', 'monitor-detail__players');
      for (const player of snapshot.players.filter((player) => player.roomCode === entry.code)) {
        const item = element('li');
        item.append(button(`${player.name} · ${t(states[player.status] || states.lobby)}`, () => openDetail('players', playerKey(player))));
        list.append(item);
      }
      content.replaceChildren(facts, element('h3', '', t('在线玩家')), list);
    }
  }
  function makeView(kind, statusOptions) {
    const panel = root.querySelector(`.${kind}-panel`);
    const toolbar = element('div', 'list-filters');
    const filters = {};
    function select(name, title, options) {
      const label = element('label', 'list-filter');
      const input = document.createElement('select');
      for (const [value, text] of [['all', N_('全部')], ...options]) {
        const option = element('option', '', t(text)); option.value = value; input.append(option);
      }
      label.append(element('span', '', title), input);
      toolbar.append(label);
      input.addEventListener('change', () => { pager.reset(); render(); });
      filters[name] = input;
    }
    select('status', t('状态'), statusOptions);
    select('difficulty', t('难度'), DIFFICULTIES.map((code) => [code, DIFFICULTY_NAMES[code]]));
    select('mode', t('模式'), [['solo', N_('独立模拟')], ['coop', N_('同盟模拟')], ['custom', N_('自定义对局')], ['endless', N_('无尽模式')], ['matchmaking', N_('同盟匹配')]]);
    const searchLabel = element('label', 'list-filter list-filter--search');
    const search = document.createElement('input');
    search.type = 'search';
    search.maxLength = 100;
    search.placeholder = t(kind === 'players' ? N_('搜索玩家或房间号') : N_('搜索房间号'));
    searchLabel.append(element('span', '', t('搜索')), search);
    toolbar.append(searchLabel);
    search.addEventListener('input', () => { pager.reset(); render(); });
    panel.querySelector('.table-wrap').before(toolbar);
    const pager = mountPager(panel, render);
    let rowSignature = '';
    function render() {
      const list = snapshot[kind].filter((entry) => {
        const state = kind === 'players' ? entry.status : entry.state === 'running' ? 'running' : entry.matchmaking ? 'queued' : 'waiting';
        return (filters.status.value === 'all' || state === filters.status.value)
          && (filters.difficulty.value === 'all' || entry.difficulty === filters.difficulty.value)
          && (filters.mode.value === 'all' || (kind === 'rooms' ? roomModeKey(entry) : entry.mode) === filters.mode.value)
          && `${entry.name || ''} ${entry.roomCode || entry.code || ''}`.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase());
      });
      const entries = pager.slice(list);
      root.querySelector(`#empty-${kind}`).hidden = list.length !== 0;
      root.querySelector(`#${kind === 'players' ? 'player' : 'room'}-count`).textContent = String(list.length);
      const signature = JSON.stringify(entries);
      if (signature === rowSignature) return;
      rowSignature = signature;
      const rows = document.createDocumentFragment();
      for (const entry of entries) {
        const row = element('tr');
        const cells = kind === 'players'
          ? [[entry.name, 'player-name'], [t(states[entry.status] || states.lobby)], [entry.roomCode || '—', 'room-code']]
          : [[entry.code, 'room-code'], [roomMode(entry)], [difficulty(entry.difficulty)], [`${entry.connectedHumans || 0}/${entry.humans || 0}`], [entry.bots || 0], [entry.spectators || 0], [round(entry), 'room-round'], [roomState(entry)]];
        for (const [text, className] of cells) row.append(element('td', className, String(text ?? '—')));
        const action = element('td');
        action.append(button(t('查看详情'), () => openDetail(kind, kind === 'players' ? playerKey(entry) : entry.code)));
        row.append(action);
        rows.append(row);
      }
      root.querySelector(`#${kind === 'players' ? 'player' : 'room'}-rows`).replaceChildren(rows);
      root.querySelector(`#empty-${kind}`).hidden = list.length !== 0;
      root.querySelector(`#${kind === 'players' ? 'player' : 'room'}-count`).textContent = String(list.length);
    }
    views[kind] = render;
  }
  makeView('players', Object.entries(states));
  makeView('rooms', [['running', N_('进行中')], ['waiting', N_('等待中')], ['queued', N_('匹配中')]]);
  return {
    update(data) {
      snapshot = { players: Array.isArray(data.players) ? data.players : [], rooms: Array.isArray(data.rooms) ? data.rooms : [] };
      views.players();
      views.rooms();
      renderDetail();
    },
    close() { if (dialog.open) dialog.close(); },
  };
}
