import { addMessages, N_, setLang, t } from '../../shared/i18n.js';
import { DIFFICULTIES, DIFFICULTY_NAMES } from '../../shared/constants.js';
import { announcementsForCurrentVisitor, dismissAnnouncement, dismissedAnnouncementIds } from './announcementDismissal.js';
import { mountAnnouncementMarquee } from './announcementMarquee.js';
import { publicHistoryItems } from './monitorPages.js';
import { mountPollPanel } from './pollPanel.js';

const $ = (id) => document.getElementById(id);
const refreshMs = 5000;
let timer = null;
let loading = false;
let tickerSignature = '';
let currentMetrics = null;
let tickerCleanups = [];
let announcementHistorySignature = '';
let announcementEntries = [];
let historyExpanded = false;
let pollPanel = null;

async function initializeLanguage() {
  let selected = new URLSearchParams(location.search).get('lang');
  if (!selected) {
    try { selected = JSON.parse(localStorage.getItem('sp.pref.lang') || 'null'); } catch { selected = null; }
  }
  if (typeof selected !== 'string' || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(selected) || selected.toLowerCase() === 'zh') return;
  try {
    const response = await fetch(`/i18n/${encodeURIComponent(selected)}.json`, { cache: 'no-cache' });
    if (!response.ok) return;
    addMessages(selected, await response.json());
    setLang(selected);
    document.documentElement.lang = selected;
  } catch { /* the Chinese source strings remain available */ }
}

function applyLabels() {
  document.title = t('卫戍协议：盟约 · 服务器状态');
  $('brand-link').setAttribute('aria-label', t('返回游戏主页'));
  $('brand-title').textContent = t('卫戍协议：盟约');
  $('brand-subtitle').textContent = t('公共监控');
  $('home-link').textContent = t('返回游戏');
  $('page-kicker').textContent = t('PUBLIC NODE MONITOR');
  $('page-title').textContent = t('服务器状态');
  $('page-intro').textContent = t('阅读服主公告、参与社区投票，向下查看服务器信息与实时性能。');
  $('announcement-kicker').textContent = t('MESSAGE FROM HOST');
  $('announcement-heading').textContent = t('服主公告');
  $('refresh-note').textContent = t('每 5 秒自动刷新');
  $('announcement-empty').textContent = t('当前没有公告。');
  $('urgent-ticker-stack').setAttribute('aria-label', t('紧急通知'));
  $('overview-kicker').textContent = t('LIVE NODE');
  $('overview-heading').textContent = t('服务器信息');
  $('updated-label').textContent = t('更新时间');
  $('online-label').textContent = t('在线玩家');
  $('queue-label').textContent = t('匹配队列');
  $('rooms-label').textContent = t('活跃房间');
  $('matches-label').textContent = t('进行中对局');
  $('difficulty-kicker').textContent = 'DIFFICULTY ACTIVITY';
  $('difficulty-heading').textContent = t('按难度统计');
  $('difficulty-note').textContent = t('游玩人数只计连接中的真人玩家，不含 AI 和观战者。');
  $('difficulty-label').textContent = t('难度');
  $('playing-label').textContent = t('正在游玩');
  $('difficulty-queue-label').textContent = t('匹配排队');
  $('version-label').textContent = t('程序版本');
  $('uptime-label').textContent = t('运行时长');
  $('pressure-kicker').textContent = 'RESOURCE HEALTH';
  $('pressure-heading').textContent = t('服务器压力');
  $('pressure-description').textContent = t('压力等级按 CPU 与内存利用率较高的一项计算：60% 中等，80% 偏高，90% 过高。');
  $('latency-label').textContent = t('访问延迟');
  $('latency-note').textContent = t('当前浏览器至状态接口的响应时间，各地访问结果会不同。');
  $('cpu-label').textContent = t('CPU 使用率');
  $('memory-label').textContent = t('内存使用率');
  $('storage-label').textContent = t('存储占用');
  $('footer-caption').textContent = t('公开资源与投票 · 不展示玩家或房间明细');
  $('admin-link').textContent = t('服主管理入口');
  $('health-label').textContent = t('正在读取状态…');
}

function formatUptime(value) {
  const totalMinutes = Math.floor(Math.max(0, Number(value) || 0) / 60);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  return `${days ? `${days}d ` : ''}${String(hours).padStart(2, '0')}h ${String(minutes).padStart(2, '0')}m`;
}

function formatTime(value, options = { dateStyle: 'medium', timeStyle: 'short' }) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '—';
  return new Intl.DateTimeFormat(document.documentElement.lang || 'zh-CN', options).format(date);
}

function renderDifficultyStats(stats) {
  const rows = document.createDocumentFragment();
  const available = stats && typeof stats === 'object';
  for (const difficulty of DIFFICULTIES) {
    const counts = stats?.[difficulty] || {};
    const row = document.createElement('tr');
    const name = document.createElement('th');
    name.scope = 'row';
    name.textContent = t(DIFFICULTY_NAMES[difficulty]);
    const playing = document.createElement('td');
    playing.textContent = available ? String(Math.max(0, Number(counts.playing) || 0)) : '—';
    const queued = document.createElement('td');
    queued.textContent = available ? String(Math.max(0, Number(counts.queued) || 0)) : '—';
    row.append(name, playing, queued);
    rows.append(row);
  }
  $('difficulty-rows').replaceChildren(rows);
}

function setMetricMeter(id, value, scope) {
  const meter = $(`${id}-meter`);
  const fill = $(`${id}-bar`);
  const percent = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
  fill.style.width = `${percent ?? 0}%`;
  meter.setAttribute('aria-label', t(id === 'cpu' ? 'CPU 使用率' : id === 'memory' ? '内存使用率' : '存储占用'));
  if (percent === null) {
    meter.removeAttribute('aria-valuenow');
    meter.setAttribute('aria-valuetext', t('数据不可用'));
  } else {
    meter.setAttribute('aria-valuenow', String(percent));
    meter.setAttribute('aria-valuetext', `${percent.toFixed(1)}%`);
  }
  $(`${id}-value`).textContent = percent === null ? '—' : `${percent.toFixed(1)}%`;
  const scopeText = id === 'storage' ? t('应用所在文件系统') : scope === 'container' ? t('容器') : scope === 'host' ? t('宿主机') : t('数据不可用');
  $(`${id}-scope`).textContent = t('运行范围：{scope}', { scope: scopeText });
}

function renderPressure(metrics, latencyMs) {
  currentMetrics = metrics && typeof metrics === 'object' ? metrics : null;
  const cpu = Number.isFinite(metrics?.cpuPercent) ? metrics.cpuPercent : null;
  const memory = Number.isFinite(metrics?.memoryPercent) ? metrics.memoryPercent : null;
  const level = ['normal', 'moderate', 'high', 'critical'].includes(metrics?.pressureLevel) ? metrics.pressureLevel : 'unknown';
  const levelLabels = {
    normal: N_('压力正常'), moderate: N_('压力中等'), high: N_('压力偏高'), critical: N_('压力过高'), unknown: N_('采样中'),
  };
  const badge = $('pressure-badge');
  badge.className = `pressure-badge is-${level}`;
  $('pressure-label').textContent = t(levelLabels[level]);
  setMetricMeter('cpu', cpu, currentMetrics?.cpuScope);
  setMetricMeter('memory', memory, currentMetrics?.memoryScope);
  const storage = Number.isFinite(metrics?.storagePercent) ? metrics.storagePercent : null;
  setMetricMeter('storage', storage, 'app-filesystem');

  const latency = Number.isFinite(latencyMs) && latencyMs >= 0 ? Math.round(latencyMs) : null;
  $('latency-value').textContent = latency === null ? '—' : String(latency);
  const latencyCard = $('latency-card');
  latencyCard.classList.remove('latency-good', 'latency-moderate', 'latency-high', 'latency-unknown');
  latencyCard.classList.add(latency === null ? 'latency-unknown' : latency < 100 ? 'latency-good' : latency < 250 ? 'latency-moderate' : 'latency-high');
}

function renderAnnouncementHistory(entries) {
  const count = Math.min(entries.length, 5);
  if (count <= 1) historyExpanded = false;
  const toggle = $('announcement-history-toggle');
  toggle.hidden = count <= 1;
  toggle.setAttribute('aria-expanded', String(historyExpanded));
  toggle.textContent = historyExpanded ? t('收起公告') : t('展开最近 {n} 条公告', { n: count });
  const visible = publicHistoryItems(entries, historyExpanded);
  const signature = JSON.stringify(visible.map(({ id, title, body, publishedAt, priority }) => [id, title, body, publishedAt, priority]));
  if (signature === announcementHistorySignature) return;
  announcementHistorySignature = signature;
  const fragment = document.createDocumentFragment();
  for (const entry of visible) {
    const item = document.createElement('li');
    item.className = `announcement-item${entry.priority === 'urgent' ? ' announcement-item--urgent' : ''}`;
    const meta = document.createElement('p');
    meta.className = 'announcement-item__meta';
    const published = t('公告发布于 {time}', { time: formatTime(entry.publishedAt) });
    meta.textContent = entry.priority === 'urgent' ? `${t('加急通知')} · ${published}` : published;
    const title = document.createElement('h3');
    title.textContent = String(entry.title || '');
    const body = document.createElement('p');
    body.textContent = String(entry.body || '');
    item.append(meta, title, body);
    fragment.append(item);
  }
  $('announcement-list').replaceChildren(fragment);
  $('announcement-empty').hidden = entries.length !== 0;
}

function renderAnnouncements(entries) {
  const list = announcementsForCurrentVisitor(entries);
  announcementEntries = list;
  renderAnnouncementHistory(list);
  renderUrgentTicker(list);
}

function renderUrgentTicker(entries) {
  const dismissed = dismissedAnnouncementIds();
  const active = entries.filter((entry) => (entry.priority === 'urgent' || entry.audience === 'new') && !dismissed.has(entry.id));
  const signature = JSON.stringify(active.map(({ id, title, body, audience }) => [id, title, body, audience]));
  if (signature === tickerSignature) return;
  tickerSignature = signature;
  const stack = $('urgent-ticker-stack');
  for (const cleanup of tickerCleanups) cleanup();
  tickerCleanups = [];
  const fragment = document.createDocumentFragment();
  const marquees = [];
  for (const entry of active) {
    const row = document.createElement('div');
    const welcome = entry.audience === 'new';
    row.className = `urgent-ticker${welcome ? ' urgent-ticker--welcome' : ''}`;
    row.setAttribute('role', 'status');
    row.setAttribute('aria-live', 'polite');
    const label = document.createElement('strong');
    label.className = 'urgent-ticker__label';
    label.textContent = t(welcome ? '新手提醒' : '紧急通知');
    const viewport = document.createElement('div');
    viewport.className = 'urgent-ticker__viewport';
    const track = document.createElement('div');
    track.className = 'urgent-ticker__track';
    const text = entry.title + ' · ' + entry.body;
    viewport.append(track);
    marquees.push({ viewport, track, text });
    if (welcome) {
      const statusLink = document.createElement('a');
      statusLink.className = 'urgent-ticker__link';
      statusLink.href = '/status/';
      statusLink.textContent = t('查看服务器状态');
      row.append(label, viewport, statusLink);
    }
    const close = document.createElement('button');
    close.className = 'urgent-ticker__close';
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', t('关闭此加急通知'));
    close.addEventListener('click', () => {
      dismissAnnouncement(entry.id);
      tickerSignature = '';
      renderUrgentTicker(entries);
    });
    if (welcome) row.append(close);
    else row.append(label, viewport, close);
    fragment.append(row);
  }
  stack.replaceChildren(fragment);
  stack.hidden = active.length === 0;
  for (const marquee of marquees) tickerCleanups.push(mountAnnouncementMarquee(marquee.viewport, marquee.track, marquee.text));
}

function setConnectionState(isConnected, maintenance = false) {
  const pill = $('health-pill');
  pill.classList.toggle('is-offline', !isConnected);
  pill.classList.toggle('is-maintenance', isConnected && maintenance);
  $('health-label').textContent = !isConnected ? t('连接中断') : maintenance ? t('维护模式') : t('服务运行中');
  $('connection-note').textContent = isConnected ? '' : t('服务器暂时不可用，恢复连接后会自动重试。');
}

function displayStatus(data, latencyMs) {
  setConnectionState(true, data.maintenance === true);
  $('online-value').textContent = String(Math.max(0, Number(data.online) || 0));
  $('queue-value').textContent = String(Math.max(0, Number(data.queued) || 0));
  $('rooms-value').textContent = String(Math.max(0, Number(data.rooms) || 0));
  $('matches-value').textContent = String(Math.max(0, Number(data.matches) || 0));
  $('version-value').textContent = data.app ? `v${String(data.app).slice(0, 40)}` : '—';
  $('uptime-value').textContent = formatUptime(data.uptimeSec);
  $('updated-at').textContent = formatTime(data.updatedAt, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  renderDifficultyStats(data.difficultyStats);
  renderPressure(data.metrics, latencyMs);
  renderAnnouncements(data.announcements);
}

function schedulePoll() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (document.hidden) schedulePoll();
    else refreshStatus();
  }, refreshMs);
}

async function refreshStatus() {
  if (loading) return;
  loading = true;
  try {
    const startedAt = performance.now();
    const response = await fetch('/status/api', { cache: 'no-store' });
    const latencyMs = performance.now() - startedAt;
    if (!response.ok) throw new Error('status');
    displayStatus(await response.json(), latencyMs);
  } catch {
    setConnectionState(false);
    $('online-value').textContent = '—';
    $('queue-value').textContent = '—';
    $('rooms-value').textContent = '—';
    $('matches-value').textContent = '—';
    renderDifficultyStats(null);
    renderPressure(null, null);
  } finally {
    loading = false;
    pollPanel?.refresh();
    schedulePoll();
  }
}

await initializeLanguage();
applyLabels();
pollPanel = mountPollPanel($('polls'));
$('announcement-history-toggle').addEventListener('click', () => {
  historyExpanded = !historyExpanded;
  renderAnnouncementHistory(announcementEntries);
});
pollPanel.refresh();
refreshStatus();
