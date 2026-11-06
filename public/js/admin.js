import { addMessages, N_, setLang, t } from '../../shared/i18n.js';
import { mountPageNavigation } from './monitorPages.js';
import { mountAdminBrowser } from './adminBrowse.js';
import { mountPollPanel } from './pollPanel.js';

const $ = (id) => document.getElementById(id);
const ui = {
  login: $('login-panel'), disabled: $('disabled-panel'), dashboard: $('dashboard'),
  form: $('login-form'), password: $('password'), loginButton: $('login-button'), loginMessage: $('login-message'),
  refresh: $('refresh-button'), logout: $('logout-button'),
  online: $('online-value'), queue: $('queue-value'), rooms: $('rooms-value'), matches: $('matches-value'),
  liveIndicator: $('live-indicator'), liveLabel: $('live-label'), nodeState: $('node-state'), nodeStateLabel: $('node-state-label'),
  nodeHost: $('node-host'), appVersion: $('app-version'), appUptime: $('app-uptime'), appMemory: $('app-memory'), nodeRuntime: $('node-runtime'),
  queueGrid: $('queue-grid'), roomRows: $('room-rows'), emptyRooms: $('empty-rooms'), roomCount: $('room-count'),
  playerRows: $('player-rows'), emptyPlayers: $('empty-players'), playerCount: $('player-count'),
  updated: $('updated-at'), dashboardMessage: $('dashboard-message'),
  latency: $('latency-value'), cpu: $('cpu-value'), memoryUsage: $('memory-usage-value'), storage: $('storage-value'),
  updatePanel: $('update-panel'), updateTitle: $('update-title'), updateDescription: $('update-description'),
  updateChecked: $('update-checked'), updateReleaseLink: $('update-release-link'),
  updateCheck: $('update-check-button'), updateApply: $('update-apply-button'),
  announcementForm: $('announcement-form'), announcementTitle: $('announcement-title-input'),
  announcementBody: $('announcement-body-input'), announcementPriority: $('announcement-priority-input'),
  announcementAudience: $('announcement-audience-input'),
  announcementPublish: $('announcement-publish-button'),
  announcementMessage: $('announcement-message'), announcementList: $('admin-announcement-list'),
  siteSettingsForm: $('site-settings-form'), siteSettingsPosition: $('plugin-notice-position'),
  siteSettingsSave: $('site-settings-save'), siteSettingsMessage: $('site-settings-message'),
  pluginMessage: $('plugin-message'), pluginRows: $('plugin-rows'), pluginCount: $('plugin-count'),
  pluginDetail: $('plugin-detail'), pluginUpdated: $('plugin-updated'), pluginRescan: $('plugin-rescan-button'),
  pluginCatalogForm: $('plugin-catalog-form'), pluginCatalogUrl: $('plugin-catalog-url'), pluginCatalogButton: $('plugin-catalog-button'),
  pluginCatalogResults: $('plugin-catalog-results'), pluginCatalogRows: $('catalog-rows'), pluginCatalogName: $('catalog-name'),
  pluginDirectForm: $('plugin-direct-form'), pluginZipUrl: $('plugin-zip-url'), pluginZipSha: $('plugin-zip-sha'),
  pluginZipId: $('plugin-zip-id'), pluginZipBytes: $('plugin-zip-bytes'), pluginInstall: $('plugin-install-button'),
};
const difficulties = [
  ['FUNNY', N_('标准模拟')], ['NORMAL', N_('险境模拟')], ['HARD', N_('绝境模拟')], ['ABYSS', N_('终极模拟')],
];
const refreshMs = 5000;
const updateRefreshMs = 60000;
let pollingTimer = null;
let updateTimer = null;
let loading = false;
let hasDashboard = false;
let updateLoading = false;
let updateChecked = false;
let updateState = null;
let lastOverview = null;
let announcementLoading = false;
let pluginLoading = false;
let siteSettingsLoading = false;
let siteSettingsLoaded = false;
let pluginManagerLoaded = false;
let catalogEntries = [];
let pageNavigation = null;
let browser = null;
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
    const pack = await response.json();
    addMessages(selected, pack);
    setLang(selected);
    document.documentElement.lang = selected;
  } catch { /* the Chinese source strings remain available */ }
}

function label(id, text) { $(id).textContent = text; }

function applyLabels() {
  document.title = t('卫戍协议：盟约 · 管理后台');
  label('brand-title', t('卫戍协议：盟约'));
  label('brand-subtitle', t('服务器管理'));
  label('refresh-button', t('刷新数据'));
  label('logout-button', t('退出登录'));
  label('public-status-link', t('查看公开状态'));
  label('login-kicker', t('管理员认证'));
  label('login-title', t('管理员登录'));
  label('login-copy', t('登录后查看本服务器的在线人数、匹配队列和房间状态。'));
  label('password-label', t('管理员密码'));
  label('login-button', t('登录'));
  $('password').setAttribute('aria-label', t('管理员密码'));
  $('brand-link').setAttribute('aria-label', t('返回游戏主页'));
  $('summary-grid').setAttribute('aria-label', t('服务端状态'));
  label('disabled-kicker', t('服务器管理'));
  label('disabled-title', t('后台未启用'));
  label('disabled-copy', t('请在容器环境变量中配置 SP_ADMIN_PASSWORD（至少 16 个字符）后重启服务。'));
  label('page-kicker', t('服务器管理'));
  label('page-title', t('服务器监控台'));
  $('update-panel').setAttribute('aria-label', t('更新中心'));
  label('update-kicker', t('更新中心'));
  label('update-title', t('正在检查官方版本…'));
  label('update-description', t('当前版本检查中。'));
  label('update-checked', t('尚未检查'));
  label('update-release-link', t('查看发布说明'));
  label('update-check-button', t('检查更新'));
  label('update-apply-button', t('一键更新'));
  label('announcement-kicker', t('PUBLIC ANNOUNCEMENTS'));
  label('announcement-heading', t('公告管理'));
  label('announcement-note', t('发布后会同步到主站和公开监控页'));
  label('announcement-title-label', t('公告标题'));
  label('announcement-body-label', t('公告内容'));
  label('announcement-priority-label', t('公告优先级'));
  label('announcement-normal-option', t('普通公告'));
  label('announcement-urgent-option', t('加急通知'));
  label('announcement-audience-label', t('公告受众'));
  label('announcement-all-audience-option', t('所有访问者'));
  label('announcement-new-audience-option', t('首次访问者'));
  label('announcement-priority-note', t('加急通知会在主站和对局内滚动显示，直到玩家关闭。首次访问者公告会显示到关闭，并可跳转查看服务器状态。'));
  $('announcement-title-input').setAttribute('aria-label', t('公告标题'));
  $('announcement-body-input').setAttribute('aria-label', t('公告内容'));
  $('announcement-title-input').setAttribute('placeholder', t('最多 80 字'));
  $('announcement-body-input').setAttribute('placeholder', t('最多 1200 字，支持换行'));
  label('announcement-publish-button', t('发布公告'));
  label('announcement-empty', t('当前没有公告。'));
  label('site-settings-kicker', t('MAIN SITE DISPLAY'));
  label('site-settings-heading', t('主站显示设置'));
  label('plugin-notice-position-label', t('首页插件提示位置'));
  label('plugin-notice-position-right', t('右下角状态信息上方'));
  label('plugin-notice-position-center', t('居中显示在版权说明上方'));
  label('plugin-notice-position-left', t('左下角操作按钮上方'));
  label('plugin-notice-position-hidden', t('不显示'));
  label('site-settings-note', t('设置保存后，访客刷新主站即可看到新的位置。'));
  label('site-settings-save', t('保存显示设置'));
  label('plugin-kicker', t('PLUGIN MANAGEMENT'));
  label('plugin-heading', t('插件管理'));
  label('plugin-security-note', t('此处显示本服务器已安装插件及加载状态。外观插件在游戏内的房间「插件」面板由房主开启；个人外观由每位玩家在自己的浏览器选择。安装或编辑插件请使用服务器本地的模组工作台。'));
  label('plugin-game-link', t('进入游戏并设置外观插件 →'));
  label('plugin-rescan-button', t('重新扫描并检查'));
  label('installed-plugins-heading', t('服务器已安装'));
  label('plugin-th-name', t('插件'));
  label('plugin-th-class', t('类别'));
  label('plugin-th-version', t('版本'));
  label('plugin-th-status', t('状态'));
  label('plugin-th-rooms', t('使用中房间'));
  label('plugin-th-check', t('结构检查'));
  label('plugin-th-actions', t('操作'));
  label('empty-plugins', t('服务器当前没有已安装插件。'));
  label('plugin-catalog-label', t('插件目录 HTTPS 地址'));
  label('plugin-catalog-note', t('目录只提供包地址和 SHA-256；服务器会独立校验目录和安装包。'));
  label('plugin-catalog-button', t('读取插件目录'));
  label('plugin-zip-url-label', t('插件 ZIP 的公开 HTTPS 地址'));
  label('plugin-zip-sha-label', t('SHA-256 校验值'));
  $('plugin-zip-sha').setAttribute('placeholder', t('64 位小写十六进制'));
  label('plugin-zip-id-label', t('预期插件 ID（可选）'));
  label('plugin-zip-bytes-label', t('预期大小（字节，可选）'));
  label('plugin-direct-note', t('直接安装也必须提供 SHA-256；不能上传服务器路径或绕过插件检查。'));
  label('plugin-install-button', t('校验并安装'));
  label('catalog-results-heading', t('目录中的插件'));
  label('catalog-th-name', t('插件'));
  label('catalog-th-class', t('类别'));
  label('catalog-th-version', t('版本'));
  label('catalog-th-app', t('适用程序'));
  label('catalog-th-status', t('目录状态'));
  label('catalog-th-actions', t('操作'));
  label('empty-catalog', t('这个目录没有可显示的插件。'));
  label('resource-kicker', t('资源监控'));
  label('resource-heading', t('资源监控'));
  label('resource-note', t('每 5 秒刷新'));
  $('resource-section').setAttribute('aria-label', t('资源监控'));
  label('latency-label', t('站点延迟'));
  label('latency-unit', 'ms');
  label('latency-foot', t('此浏览器到本站后台接口'));
  label('cpu-label', t('CPU 占用'));
  label('memory-usage-label', t('内存占用'));
  label('storage-label', t('存储占用'));
  for (const [id, title] of [['cpu-meter', N_('CPU 占用')], ['memory-meter', N_('内存占用')], ['storage-meter', N_('存储占用')]]) {
    $(id).setAttribute('aria-label', t(title));
  }
  label('node-kicker', t('服务端状态'));
  label('node-overline', t('服务器节点'));
  label('node-section-title', t('节点状态'));
  $('node-count').textContent = t('单节点');
  $('node-section-title').setAttribute('aria-label', t('节点状态'));
  label('node-title', t('卫戍协议：盟约'));
  $('node-host').textContent = location.host;
  $('node-details').setAttribute('aria-label', t('服务器信息'));
  label('version-label', t('程序版本'));
  label('uptime-label', t('运行时长'));
  label('memory-label', t('进程内存'));
  label('runtime-label', t('运行环境'));
  label('node-updated-label', t('更新时间'));
  label('footer-caption', t('监控每 5 秒刷新 · 更新操作需管理员登录'));
  label('live-label', t('实时状态'));
  label('online-label', t('在线玩家'));
  label('online-foot', t('已连接到游戏服务器'));
  label('queue-label', t('匹配队列'));
  label('queue-foot', t('四种难度的排队总人数'));
  label('rooms-label', t('活跃房间'));
  label('rooms-foot', t('尚未关闭的房间'));
  label('matches-label', t('进行中对局'));
  label('matches-foot', t('当前正在进行的模拟'));
  label('queue-kicker', t('同盟匹配'));
  label('queue-heading', t('各难度排队人数'));
  label('polling-note', t('每 5 秒自动刷新'));
  label('players-kicker', t('在线玩家'));
  label('players-heading', t('玩家状态'));
  label('th-player', t('玩家'));
  label('th-player-state', t('状态'));
  label('th-player-room', t('房间信息'));
  label('empty-players', t('当前没有在线玩家。'));
  label('rooms-kicker', t('房间总览'));
  label('rooms-heading', t('房间状态'));
  label('th-code', t('房间'));
  label('th-mode', t('模式'));
  label('th-difficulty', t('难度'));
  label('th-humans', t('真人'));
  label('th-bots', t('AI'));
  label('th-spectators', t('观战'));
  label('th-round', t('回合'));
  label('th-state', t('状态'));
  label('empty-rooms', t('当前没有开放的房间。'));
  label('th-player-actions', t('详情'));
  label('th-room-actions', t('详情'));
}

function setConnectionState(connected) {
  ui.liveIndicator.classList.toggle('is-offline', !connected);
  ui.nodeState.classList.toggle('is-offline', !connected);
  const status = t(connected ? '连接正常' : '连接中断');
  ui.liveLabel.textContent = status;
  ui.nodeStateLabel.textContent = status;
}

function showOnly(section) {
  ui.login.hidden = section !== ui.login;
  ui.disabled.hidden = section !== ui.disabled;
  ui.dashboard.hidden = section !== ui.dashboard;
  ui.refresh.hidden = section !== ui.dashboard;
  ui.logout.hidden = section !== ui.dashboard;
}

function setLoginMessage(text = '') { ui.loginMessage.textContent = text; }

function showLogin(text = '') {
  clearTimeout(pollingTimer);
  clearTimeout(updateTimer);
  hasDashboard = false;
  updateChecked = false;
  updateState = null;
  lastOverview = null;
  pluginManagerLoaded = false;
  catalogEntries = [];
  ui.pluginDetail.hidden = true;
  ui.pluginCatalogResults.hidden = true;
  browser?.close();
  showOnly(ui.login);
  setLoginMessage(text);
  if (!text) queueMicrotask(() => ui.password.focus());
}

function showDisabled() {
  browser?.close();
  clearTimeout(pollingTimer);
  clearTimeout(updateTimer);
  showOnly(ui.disabled);
}

function td(text, className = '') {
  const cell = document.createElement('td');
  cell.textContent = text;
  if (className) cell.className = className;
  return cell;
}

function renderQueueCounts(matchQueues) {
  const fragment = document.createDocumentFragment();
  for (const [code, title] of difficulties) {
    const card = document.createElement('article');
    card.className = `queue-card queue-card--${code.toLowerCase()}`;
    const name = document.createElement('span');
    name.className = 'queue-name';
    name.textContent = t(title);
    const value = document.createElement('strong');
    value.className = 'queue-value';
    value.textContent = `${Number(matchQueues?.[code]) || 0}/4`;
    card.append(name, value);
    fragment.append(card);
  }
  ui.queueGrid.replaceChildren(fragment);
}

function formatUptime(value) {
  const totalMinutes = Math.floor(Math.max(0, Number(value) || 0) / 60);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  return `${days ? `${days}d ` : ''}${String(hours).padStart(2, '0')}h ${String(minutes).padStart(2, '0')}m`;
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const power = Math.min(units.length - 1, Math.floor(Math.log(Math.max(bytes, 1)) / Math.log(1024)));
  const adjusted = bytes / 1024 ** power;
  return `${power === 0 || adjusted >= 100 ? Math.round(adjusted) : adjusted.toFixed(adjusted >= 10 ? 1 : 2)} ${units[power]}`;
}

function setMeter(prefix, used, total, foot) {
  const valid = Number.isFinite(used) && Number.isFinite(total) && used >= 0 && total > 0;
  const value = valid ? Math.min(100, Math.max(0, used / total * 100)) : null;
  const card = $(`${prefix}-meter`).closest('.resource-card');
  card.classList.toggle('is-high', value !== null && value >= 75 && value < 90);
  card.classList.toggle('is-critical', value !== null && value >= 90);
  $(`${prefix}-bar`).style.width = value === null ? '0%' : `${value}%`;
  $(`${prefix}-meter`).setAttribute('aria-valuetext', value === null ? t('数据不可用') : `${Math.round(value)}%`);
  if (value === null) $(`${prefix}-meter`).removeAttribute('aria-valuenow');
  else $(`${prefix}-meter`).setAttribute('aria-valuenow', String(Math.round(value)));
  $(prefix === 'memory' ? 'memory-usage-value' : `${prefix}-value`).textContent = value === null ? '—' : String(Math.round(value));
  $(prefix === 'memory' ? 'memory-usage-foot' : `${prefix}-foot`).textContent = value === null ? t('数据不可用') : `${formatBytes(used)} / ${formatBytes(total)} · ${foot}`;
}

function renderMetrics(rawMetrics = {}, latencyMs = null) {
  const metrics = rawMetrics || {};
  ui.latency.textContent = Number.isFinite(latencyMs) ? String(Math.round(latencyMs)) : '—';
  const cpu = Number.isFinite(metrics.cpuPercent) ? metrics.cpuPercent : null;
  ui.cpu.textContent = cpu === null ? '—' : String(Math.round(cpu));
  const cpuCard = $('cpu-meter').closest('.resource-card');
  cpuCard.classList.toggle('is-high', cpu !== null && cpu >= 75 && cpu < 90);
  cpuCard.classList.toggle('is-critical', cpu !== null && cpu >= 90);
  $('cpu-bar').style.width = cpu === null ? '0%' : `${Math.max(0, Math.min(100, cpu))}%`;
  if (cpu === null) $('cpu-meter').removeAttribute('aria-valuenow');
  else $('cpu-meter').setAttribute('aria-valuenow', String(Math.round(cpu)));
  $('cpu-meter').setAttribute('aria-valuetext', cpu === null ? t('采样中') : `${Math.round(cpu)}%`);
  const scope = (value) => t(value === 'container' ? '容器' : '宿主机');
  $('cpu-foot').textContent = cpu === null ? t('采样中') : scope(metrics.cpuScope);
  setMeter('memory', metrics.memoryUsedBytes, metrics.memoryTotalBytes, scope(metrics.memoryScope));
  setMeter('storage', metrics.storageUsedBytes, metrics.storageTotalBytes, t('应用所在文件系统'));
}

function displayOverview(data, latencyMs) {
  lastOverview = data;
  ui.online.textContent = String(Number(data.online) || 0);
  ui.queue.textContent = String(Number(data.queueTotal) || 0);
  ui.rooms.textContent = String(Number(data.roomTotal) || 0);
  ui.matches.textContent = String(Number(data.matchTotal) || 0);
  renderQueueCounts(data.matchQueues);
  browser?.update(data);
  if (pageNavigation?.current() === 'polls') pollPanel?.refresh();
  renderAdminAnnouncements(data.announcements);
  if (!siteSettingsLoaded) loadSiteSettings();
  const server = data.serverInfo || {};
  ui.appVersion.textContent = server.appVersion ? `v${server.appVersion}` : '—';
  ui.appUptime.textContent = formatUptime(server.uptimeSec);
  const memoryMb = Number(server.memoryBytes) / (1024 * 1024);
  ui.appMemory.textContent = Number.isFinite(memoryMb) && memoryMb > 0 ? `${Math.round(memoryMb)} MB` : '—';
  ui.nodeRuntime.textContent = server.nodeVersion ? `Node.js ${server.nodeVersion}` : '—';
  renderMetrics(data.metrics, latencyMs);
  const locale = document.documentElement.lang || 'zh-CN';
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(data.updatedAt));
  ui.updated.textContent = time;
  ui.dashboardMessage.textContent = '';
  if (updateState) renderUpdate(updateState);
  if (!pluginManagerLoaded) refreshPlugins();
}

function renderAdminAnnouncements(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const fragment = document.createDocumentFragment();
  const locale = document.documentElement.lang || 'zh-CN';
  for (const entry of list) {
    const item = document.createElement('li');
    item.className = 'admin-announcement';
    const copy = document.createElement('div');
    copy.className = 'admin-announcement__copy';
    const title = document.createElement('h3');
    title.textContent = String(entry.title || '');
    const body = document.createElement('p');
    body.textContent = String(entry.body || '');
    const meta = document.createElement('span');
    meta.className = 'admin-announcement__date';
    const date = new Date(entry.publishedAt);
    meta.textContent = t('公告发布于 {time}', { time: Number.isNaN(date.valueOf()) ? '—' : new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(date) });
    const priority = entry.priority === 'urgent' ? document.createElement('span') : null;
    if (priority) { priority.className = 'admin-announcement__priority'; priority.textContent = t('加急'); }
    const audience = entry.audience === 'new' ? document.createElement('span') : null;
    if (audience) { audience.className = 'admin-announcement__audience'; audience.textContent = t('首次访问者'); }
    copy.append(title, ...(priority ? [priority] : []), ...(audience ? [audience] : []), body, meta);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'button button--quiet announcement-remove';
    remove.textContent = t('删除');
    remove.setAttribute('aria-label', t('删除公告：{title}', { title: String(entry.title || '') }));
    remove.addEventListener('click', () => removeAnnouncement(entry.id, remove));
    item.append(copy, remove);
    fragment.append(item);
  }
  ui.announcementList.replaceChildren(fragment);
  $('announcement-empty').hidden = list.length !== 0;
}

async function loadSiteSettings() {
  if (siteSettingsLoaded || siteSettingsLoading) return;
  siteSettingsLoading = true;
  ui.siteSettingsSave.disabled = true;
  try {
    const response = await fetch('/admin/api/site-settings', { credentials: 'same-origin', cache: 'no-store' });
    if (response.status === 401) { showLogin(t('登录已过期，请重新登录。')); return; }
    if (!response.ok) throw new Error('site-settings');
    const payload = await response.json();
    const value = payload?.settings?.pluginNoticePosition;
    const allowed = ['right-above-meta', 'center-above-copyright', 'left-above-actions', 'hidden'];
    ui.siteSettingsPosition.value = allowed.includes(value) ? value : 'right-above-meta';
    ui.siteSettingsMessage.textContent = '';
    siteSettingsLoaded = true;
  } catch {
    ui.siteSettingsMessage.textContent = t('无法读取显示设置，请稍后重试。');
  } finally {
    siteSettingsLoading = false;
    ui.siteSettingsSave.disabled = false;
  }
}

async function removeAnnouncement(id, button) {
  if (announcementLoading || typeof id !== 'string' || !/^[a-f0-9]{24}$/.test(id)) return;
  announcementLoading = true;
  button.disabled = true;
  ui.announcementMessage.textContent = '';
  try {
    const response = await fetch(`/admin/api/announcements/${id}`, { method: 'DELETE', credentials: 'same-origin', cache: 'no-store' });
    if (response.status === 401) { showLogin(t('登录已过期，请重新登录。')); return; }
    if (!response.ok) throw new Error('delete');
    ui.announcementMessage.textContent = t('公告已删除。');
    await refreshStatus({ quiet: true });
  } catch {
    ui.announcementMessage.textContent = t('删除公告失败，请稍后重试。');
  } finally {
    announcementLoading = false;
    button.disabled = false;
  }
}

const pluginClasses = {
  lang: N_('语言'), cosmetic: N_('外观'), content: N_('内容'), script: N_('脚本'), ui: N_('界面'), trusted: N_('可信代码'),
};
const pluginStatuses = {
  loaded: N_('已加载'), disabled: N_('已停用'), planned: N_('暂未实现'), unsupported: N_('不支持'), skipped: N_('未加载'),
};
const catalogStatuses = {
  available: N_('可安装'), updatable: N_('有更新'), installed: N_('已安装'), incompatible: N_('版本不兼容'),
};

function pluginClassLabel(value) { return t(pluginClasses[value] || N_('未知类别')); }
function pluginStatusLabel(value) { return t(pluginStatuses[value] || N_('状态未知')); }
function catalogStatusLabel(value) { return t(catalogStatuses[value] || N_('目录状态未知')); }

function pluginFailure(code) {
  const messages = {
    BAD_ORIGIN: N_('请求来源校验失败，请刷新管理页面后重试。'),
    ADMIN_PLUGIN_MANAGER_UNAVAILABLE: N_('插件管理服务当前不可用。'),
    ADMIN_PLUGIN_READ_ONLY: N_('此插件管理操作当前为只读。'),
    PLUGIN_CATALOG_SHAPE: N_('插件目录格式无效或包含未通过检查的字段。'),
    PLUGIN_CATALOG_FIELD: N_('插件目录字段不符合项目格式。'),
    PLUGIN_CATALOG_URL: N_('插件目录或安装地址不符合公开 HTTPS 要求。'),
    PLUGIN_CATALOG_FETCH: N_('无法安全读取插件目录，请检查地址和服务器网络。'),
    PLUGIN_CATALOG_SIZE: N_('插件目录超过 1 MB 限制。'),
    PLUGIN_CATALOG_ID: N_('目录中的插件 ID 无效或重复。'),
    PLUGIN_CATALOG_HASH: N_('目录没有提供有效的 SHA-256 校验值。'),
    PLUGIN_INSTALL_URL: N_('安装地址必须是公开 HTTPS 网址。'),
    PLUGIN_INSTALL_HASH: N_('安装包的 SHA-256 校验失败。'),
    PLUGIN_INSTALL_EXISTS: N_('该插件 ID 已存在；请先确认它未被房间使用，再移入隔离区。'),
    PLUGIN_INSTALL_CHECK: N_('插件包未通过项目结构或安全检查。'),
    PLUGIN_INSTALL_TIMEOUT: N_('服务器下载插件包超时，请稍后重试。'),
    PLUGIN_INSTALL_FETCH: N_('服务器无法下载这个插件包。'),
    PLUGIN_INSTALL_REDIRECT: N_('插件包下载重定向不安全，已拒绝。'),
    PLUGIN_STUDIO_IN_USE: N_('该插件仍被开放房间使用，请关闭相关房间后重试。'),
    PLUGIN_UNKNOWN: N_('找不到这个插件目录。'),
    PLUGIN_ID: N_('插件 ID 格式无效。'),
    PLUGIN_INSTALL_SIZE: N_('插件包超过允许大小。'),
    PLUGIN_INSTALL_ZIP: N_('插件 ZIP 无效，或包含不允许的文件结构。'),
    BODY_TOO_LARGE: N_('请求内容过大。'),
  };
  return t(messages[code] || N_('插件操作失败（{code}）。'), { code: String(code || 'UNKNOWN').slice(0, 80) });
}

function renderPluginList(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const rows = document.createDocumentFragment();
  for (const entry of list) {
    const row = document.createElement('tr');
    const nameCell = document.createElement('td');
    nameCell.className = 'plugin-name-cell';
    const name = document.createElement('strong');
    name.textContent = String(entry.name || entry.id || '—');
    const id = document.createElement('small');
    id.textContent = String(entry.id || '');
    const unofficial = entry.unofficial ? document.createElement('span') : null;
    if (unofficial) { unofficial.className = 'plugin-unofficial'; unofficial.textContent = t('非官方'); }
    nameCell.append(name, ...(unofficial ? [unofficial] : []), id);
    const statusCell = td('');
    const status = document.createElement('span');
    status.className = `plugin-status${entry.status === 'loaded' ? ' plugin-status--loaded' : ''}`;
    status.textContent = pluginStatusLabel(entry.status);
    statusCell.append(status);
    const inUse = Number(entry.inUse) || 0;
    const roomsText = inUse ? t('{n} 个房间 · {matches} 场对局', { n: inUse, matches: Number(entry.activeMatches) || 0 }) : t('未使用');
    const problems = Number(entry.problems) || 0;
    const warnings = Number(entry.warnings) || 0;
    const checksText = problems || warnings
      ? t('问题 {n} · 警告 {warnings}', { n: problems, warnings })
      : t('通过');
    row.append(
      nameCell,
      td(pluginClassLabel(entry.class)),
      td(String(entry.version || '—'), 'plugin-version'),
      statusCell,
      td(roomsText),
      td(checksText, problems ? 'plugin-check plugin-check--bad' : warnings ? 'plugin-check plugin-check--warn' : 'plugin-check'),
    );
    const actions = document.createElement('td');
    const actionGroup = document.createElement('div');
    actionGroup.className = 'plugin-actions';
    const inspect = document.createElement('button');
    inspect.type = 'button';
    inspect.className = 'button button--quiet';
    inspect.textContent = t('检查详情');
    inspect.addEventListener('click', () => inspectPlugin(entry.id, inspect));
    actionGroup.append(inspect);
    if (entry.canRemove === true) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'button button--quiet plugin-remove';
      remove.textContent = t('移入隔离区');
      remove.disabled = pluginLoading || inUse > 0 || entry.linked === true;
      remove.title = inUse > 0 ? t('房间仍在使用，不能移除。') : entry.linked === true ? t('符号链接插件不能通过后台移除。') : '';
      remove.addEventListener('click', () => removePlugin(entry.id, remove));
      actionGroup.append(remove);
    }
    actions.append(actionGroup);
    row.append(actions);
    rows.append(row);
  }
  ui.pluginRows.replaceChildren(rows);
  $('empty-plugins').hidden = list.length !== 0;
  ui.pluginCount.textContent = String(list.length);
}

function renderPluginDetail(detail) {
  const panel = document.createElement('article');
  panel.className = 'plugin-detail__card';
  const heading = document.createElement('div');
  heading.className = 'plugin-subheading';
  const title = document.createElement('h3');
  title.textContent = String(detail.manifest?.name || detail.id || t('插件检查报告'));
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'button button--quiet';
  close.textContent = t('关闭详情');
  close.addEventListener('click', () => { ui.pluginDetail.hidden = true; ui.pluginDetail.replaceChildren(); });
  heading.append(title, close);
  const meta = document.createElement('p');
  meta.className = 'plugin-detail__meta';
  meta.textContent = `${detail.id} · ${pluginClassLabel(detail.class)} · ${String(detail.version || '—')} · ${formatBytes(detail.bytes)}`;
  const state = document.createElement('p');
  state.className = 'plugin-detail__meta';
  const lock = detail.lock?.present ? (detail.lock.fresh ? t('锁文件有效') : t('锁文件需要重新生成')) : t('无代码锁文件');
  const rooms = Array.isArray(detail.rooms) && detail.rooms.length ? detail.rooms.join(', ') : t('没有开放房间使用');
  state.textContent = `${pluginStatusLabel(detail.status)}${detail.lock ? ` · ${lock}` : ''} · ${rooms}`;
  const issues = Array.isArray(detail.check?.issues) ? detail.check.issues : [];
  const list = document.createElement('ul');
  list.className = 'plugin-issue-list';
  for (const issue of issues.slice(0, 20)) {
    const item = document.createElement('li');
    const code = document.createElement('code');
    code.textContent = String(issue.code || 'PLUGIN_INVALID');
    const location = issue.path || issue.file || issue.where;
    const message = document.createElement('span');
    message.textContent = `${issue.level === 'warning' ? t('警告') : t('问题')}${location ? ` · ${String(location).slice(0, 200)}` : ''}`;
    item.append(code, message);
    list.append(item);
  }
  if (!issues.length) {
    const item = document.createElement('li');
    item.textContent = t('没有结构检查问题。');
    list.append(item);
  }
  if (issues.length > 20) {
    const more = document.createElement('li');
    more.textContent = t('其余检查问题未显示。');
    list.append(more);
  }
  panel.append(heading, meta, state, list);
  ui.pluginDetail.replaceChildren(panel);
  ui.pluginDetail.hidden = false;
}

function renderCatalog(entries, name) {
  catalogEntries = Array.isArray(entries) ? entries : [];
  ui.pluginCatalogName.textContent = String(name || '');
  const rows = document.createDocumentFragment();
  for (const entry of catalogEntries) {
    const row = document.createElement('tr');
    const nameCell = document.createElement('td');
    nameCell.className = 'plugin-name-cell';
    const title = document.createElement('strong');
    title.textContent = String(entry.name || entry.id || '—');
    const description = document.createElement('small');
    description.textContent = String(entry.description || entry.id || '');
    const unofficial = entry.class !== 'lang' ? document.createElement('span') : null;
    if (unofficial) { unofficial.className = 'plugin-unofficial'; unofficial.textContent = t('非官方'); }
    nameCell.append(title, ...(unofficial ? [unofficial] : []), description);
    const statusCell = td(catalogStatusLabel(entry.status));
    statusCell.className = `plugin-catalog-status plugin-catalog-status--${String(entry.status || 'unknown')}`;
    row.append(
      nameCell,
      td(pluginClassLabel(entry.class)),
      td(String(entry.version || '—')),
      td(String(entry.app || t('所有版本'))),
      statusCell,
    );
    const action = document.createElement('td');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button button--quiet';
    const replace = entry.status === 'updatable';
    button.textContent = t(replace ? N_('安装更新') : N_('安装'));
    button.disabled = pluginLoading || entry.status === 'incompatible' || entry.status === 'installed';
    button.addEventListener('click', () => installCatalogPlugin(entry, button));
    action.append(button);
    row.append(action);
    rows.append(row);
  }
  ui.pluginCatalogRows.replaceChildren(rows);
  $('empty-catalog').hidden = catalogEntries.length !== 0;
  ui.pluginCatalogResults.hidden = false;
}

function pluginResponseError(code) {
  if (code === 'AUTH_REQUIRED') { showLogin(t('登录已过期，请重新登录。')); return; }
  ui.pluginMessage.textContent = pluginFailure(code);
}

async function refreshPlugins({ rescan = false, quiet = false } = {}) {
  if (pluginLoading) return;
  pluginLoading = true;
  ui.pluginRescan.disabled = true;
  if (!quiet) ui.pluginMessage.textContent = '';
  try {
    const response = await fetch(rescan ? '/admin/api/plugins/rescan' : '/admin/api/plugins', {
      method: rescan ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
    });
    let payload = {};
    try { payload = await response.json(); } catch { /* handled below */ }
    if (response.status === 401) { pluginResponseError('AUTH_REQUIRED'); return; }
    if (!response.ok) {
    if (payload.error === 'ADMIN_PLUGIN_MANAGER_UNAVAILABLE') pluginManagerLoaded = true;
    pluginResponseError(payload.error || 'ADMIN_PLUGIN_MANAGER_ERROR');
      return;
    }
    renderPluginList(payload.plugins);
    pluginManagerLoaded = true;
    const locale = document.documentElement.lang || 'zh-CN';
    ui.pluginUpdated.textContent = t('上次检查：{time}', { time: new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date()) });
    if (rescan) ui.pluginMessage.textContent = t('插件目录已重新扫描，结构状态已更新。');
  } catch {
    if (!quiet) ui.pluginMessage.textContent = t('暂时无法读取插件目录，请稍后重试。');
  } finally {
    pluginLoading = false;
    ui.pluginRescan.disabled = false;
  }
}

async function inspectPlugin(id, button) {
  if (pluginLoading || typeof id !== 'string') return;
  pluginLoading = true;
  if (button) button.disabled = true;
  ui.pluginMessage.textContent = '';
  try {
    const response = await fetch(`/admin/api/plugins/item/${encodeURIComponent(id)}`, { credentials: 'same-origin', cache: 'no-store' });
    let payload = {};
    try { payload = await response.json(); } catch { /* handled below */ }
    if (response.status === 401) { pluginResponseError('AUTH_REQUIRED'); return; }
    if (!response.ok) { pluginResponseError(payload.error || 'ADMIN_PLUGIN_MANAGER_ERROR'); return; }
    renderPluginDetail(payload);
    ui.pluginDetail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch {
    ui.pluginMessage.textContent = t('读取插件检查详情失败，请稍后重试。');
  } finally {
    pluginLoading = false;
    if (button) button.disabled = false;
  }
}

async function removePlugin(id, button) {
  if (pluginLoading || typeof id !== 'string') return;
  if (!window.confirm(t('将把 {id} 移入 plugins/_removed 隔离目录，不会删除文件。确认继续？', { id }))) return;
  pluginLoading = true;
  if (button) button.disabled = true;
  ui.pluginMessage.textContent = '';
  try {
    const response = await fetch(`/admin/api/plugins/item/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'same-origin', cache: 'no-store' });
    let payload = {};
    try { payload = await response.json(); } catch { /* handled below */ }
    if (response.status === 401) { pluginResponseError('AUTH_REQUIRED'); return; }
    if (!response.ok) {
      const refused = payload.refused?.[0];
      ui.pluginMessage.textContent = pluginFailure(refused?.error || payload.error || 'ADMIN_PLUGIN_MANAGER_ERROR');
      return;
    }
    const movedTo = payload.removed?.[0]?.to ? `plugins/${payload.removed[0].to}` : 'plugins/_removed/';
    ui.pluginMessage.textContent = t('插件已移入隔离目录：{path}', { path: movedTo });
    ui.pluginDetail.hidden = true;
    pluginLoading = false;
    await refreshPlugins({ quiet: true });
  } catch {
    ui.pluginMessage.textContent = t('移入隔离目录失败，请稍后重试。');
  } finally {
    pluginLoading = false;
    if (button) button.disabled = false;
  }
}

async function installPackage(payload, button) {
  if (pluginLoading) return;
  pluginLoading = true;
  if (button) button.disabled = true;
  ui.pluginMessage.textContent = '';
  try {
    const response = await fetch('/admin/api/plugins/install', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    let result = {};
    try { result = await response.json(); } catch { /* handled below */ }
    if (response.status === 401) { pluginResponseError('AUTH_REQUIRED'); return false; }
    if (!response.ok) { ui.pluginMessage.textContent = pluginFailure(result.error || 'ADMIN_PLUGIN_MANAGER_ERROR'); return false; }
    ui.pluginMessage.textContent = t('插件 {id} 已通过校验并安装；安装包代码未执行。', { id: result.id || payload.id || '—' });
    ui.pluginDetail.hidden = true;
    pluginLoading = false;
    await refreshPlugins({ quiet: true });
    return true;
  } catch {
    ui.pluginMessage.textContent = t('安装请求失败，请检查服务器网络后重试。');
    return false;
  } finally {
    pluginLoading = false;
    if (button) button.disabled = false;
  }
}

async function installCatalogPlugin(entry, button) {
  if (pluginLoading || !entry) return;
  const replace = entry.status === 'updatable';
  if (replace && !window.confirm(t('将用 {version} 替换 {id}。旧版本会移入隔离目录；使用中的插件无法替换。确认继续？', { version: entry.version, id: entry.id }))) return;
  await installPackage({ url: entry.url, sha256: entry.sha256, id: entry.id, bytes: entry.bytes, ...(replace ? { force: true } : {}) }, button);
}

function safeReleaseUrl(value) {
  try {
    const url = new URL(value);
    if (url.origin !== 'https://github.com' || !/^\/sganggs\/Stronghold-Protocol\/releases\/tag\/v\d+\.\d+\.\d+$/.test(url.pathname)) return null;
    return url.href;
  } catch { return null; }
}

function renderUpdate(data) {
  updateState = data;
  const version = String(data.latestVersion || '').slice(0, 40);
  const phase = String(data.phase || '');
  const isRunning = ['queued', 'applying', 'restarting', 'rolling_back'].includes(phase);
  const busy = Boolean(lastOverview && (lastOverview.online > 0 || lastOverview.roomTotal > 0 || lastOverview.matchTotal > 0));
  const newer = data.updateAvailable === true;
  ui.updatePanel.classList.toggle('is-available', newer);
  ui.updatePanel.classList.toggle('is-running', isRunning);
  ui.updateReleaseLink.hidden = true;
  const releaseUrl = safeReleaseUrl(data.releaseUrl);
  if (releaseUrl) { ui.updateReleaseLink.href = releaseUrl; ui.updateReleaseLink.hidden = false; }
  if (data.checkedAt) {
    const date = new Date(data.checkedAt);
    ui.updateChecked.textContent = Number.isNaN(date.valueOf()) ? t('尚未检查') : t('检查时间：{time}', { time: new Intl.DateTimeFormat(document.documentElement.lang || 'zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(date) });
  } else ui.updateChecked.textContent = t('尚未检查');

  if (isRunning) {
    ui.updateTitle.textContent = t('正在更新，服务会短暂重启…');
    ui.updateDescription.textContent = t('更新请求已提交，服务即将重启。');
  } else if (data.error && !newer) {
    ui.updateTitle.textContent = t('官方版本检查失败，请稍后重试。');
    ui.updateDescription.textContent = t('检查更新');
  } else if (newer) {
    ui.updateTitle.textContent = t('发现新版本 {version}', { version });
    if (phase === 'failed' || phase === 'conflict') ui.updateDescription.textContent = t('更新失败，请查看部署日志。');
    else if (!data.enabled) ui.updateDescription.textContent = t('自动更新服务未启用');
    else if (!data.updateReady) ui.updateDescription.textContent = t('新版本正在准备和检查，暂不能安装。');
    else if (busy) ui.updateDescription.textContent = t('当前有玩家或对局，请等结束后更新。');
    else ui.updateDescription.textContent = t('更新包已就绪，可在无人使用服务器时安装。');
  } else {
    ui.updateTitle.textContent = t('已是最新版本');
    const current = t('当前版本 {version}', { version: data.currentVersion || '—' });
    ui.updateDescription.textContent = data.enabled ? current : `${current} · ${t('自动更新服务未启用')}`;
  }
  ui.updateApply.hidden = !newer && !isRunning;
  ui.updateApply.disabled = !newer || !data.enabled || !data.updateReady || busy || isRunning || updateLoading;
  ui.updateCheck.disabled = updateLoading || isRunning;
  document.title = newer ? `● ${t('卫戍协议：盟约 · 管理后台')}` : t('卫戍协议：盟约 · 管理后台');
}

function scheduleUpdatePoll(delay = updateRefreshMs) {
  clearTimeout(updateTimer);
  if (!hasDashboard) return;
  updateTimer = setTimeout(() => {
    if (document.hidden) { scheduleUpdatePoll(); return; }
    refreshUpdate();
  }, delay);
}

async function refreshUpdate({ force = false } = {}) {
  if (updateLoading || !hasDashboard) return;
  updateLoading = true;
  updateChecked = true;
  ui.updateCheck.disabled = true;
  try {
    const url = force ? '/admin/api/update?refresh=1' : '/admin/api/update';
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
    if (response.status === 401) { showLogin(t('登录已过期，请重新登录。')); return; }
    if (!response.ok) throw new Error('update');
    const payload = await response.json();
    renderUpdate(payload);
  } catch {
    if (!updateState) {
      ui.updateTitle.textContent = t('官方版本检查失败，请稍后重试。');
      ui.updateDescription.textContent = t('无法连接服务器，请检查网络后重试。');
    }
  } finally {
    updateLoading = false;
    ui.updateCheck.disabled = false;
    if (updateState) renderUpdate(updateState);
    scheduleUpdatePoll();
  }
}

async function fetchStatus() {
  const started = performance.now();
  const response = await fetch('/admin/api/status', { credentials: 'same-origin', cache: 'no-store' });
  let payload = {};
  try { payload = await response.json(); } catch { /* handled as an HTTP error below */ }
  return { response, payload, latencyMs: performance.now() - started };
}

function schedulePoll(delay = refreshMs) {
  clearTimeout(pollingTimer);
  if (!hasDashboard) return;
  pollingTimer = setTimeout(() => {
    if (document.hidden) { schedulePoll(refreshMs); return; }
    refreshStatus({ quiet: true });
  }, delay);
}

async function refreshStatus({ quiet = false } = {}) {
  if (loading) return;
  loading = true;
  if (!quiet) ui.refresh.disabled = true;
  try {
    const { response, payload, latencyMs } = await fetchStatus();
    if (response.status === 503 && payload.error === 'ADMIN_DISABLED') { showDisabled(); return; }
    if (response.status === 401) {
      showLogin(hasDashboard ? t('登录已过期，请重新登录。') : '');
      return;
    }
    if (!response.ok) throw new Error('status');
    hasDashboard = true;
    showOnly(ui.dashboard);
    setConnectionState(true);
    displayOverview(payload, latencyMs);
    if (!updateChecked) refreshUpdate();
  } catch {
    if (hasDashboard) {
      setConnectionState(false);
      ui.latency.textContent = '—';
      ui.dashboardMessage.textContent = t('暂时无法连接服务器，正在重试。');
    }
    else showLogin(t('无法连接服务器，请检查网络后重试。'));
  } finally {
    loading = false;
    ui.refresh.disabled = false;
    if (hasDashboard) schedulePoll();
  }
}

ui.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (loading) return;
  loading = true;
  ui.loginButton.disabled = true;
  setLoginMessage('');
  const password = ui.password.value;
  ui.password.value = '';
  try {
    const response = await fetch('/admin/api/login', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    let payload = {};
    try { payload = await response.json(); } catch { /* mapped from status below */ }
    if (response.status === 503 && payload.error === 'ADMIN_DISABLED') { showDisabled(); return; }
    if (response.status === 401) { setLoginMessage(t('密码不正确，请重试。')); ui.password.focus(); return; }
    if (response.status === 429) { setLoginMessage(t('登录尝试过多，请稍后再试。')); return; }
    if (!response.ok) { setLoginMessage(t('登录失败，请稍后重试。')); return; }
    loading = false;
    await refreshStatus();
  } catch {
    setLoginMessage(t('无法连接服务器，请检查网络后重试。'));
  } finally {
    loading = false;
    ui.loginButton.disabled = false;
  }
});

ui.announcementForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (announcementLoading) return;
  announcementLoading = true;
  ui.announcementPublish.disabled = true;
  ui.announcementMessage.textContent = '';
  try {
    const response = await fetch('/admin/api/announcements', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: ui.announcementTitle.value, body: ui.announcementBody.value,
        priority: ui.announcementPriority.value, audience: ui.announcementAudience.value,
      }),
    });
    if (response.status === 401) { showLogin(t('登录已过期，请重新登录。')); return; }
    if (response.status === 400) { ui.announcementMessage.textContent = t('请填写标题和公告内容，并确认长度符合限制。'); return; }
    if (response.status === 409) { ui.announcementMessage.textContent = t('公告列表已满，请先删除旧公告。'); return; }
    if (!response.ok) throw new Error('publish');
    ui.announcementTitle.value = '';
    ui.announcementBody.value = '';
    ui.announcementPriority.value = 'normal';
    ui.announcementAudience.value = 'all';
    ui.announcementMessage.textContent = t('公告已发布。');
    await refreshStatus({ quiet: true });
  } catch {
    ui.announcementMessage.textContent = t('公告发布失败，请稍后重试。');
  } finally {
    announcementLoading = false;
    ui.announcementPublish.disabled = false;
  }
});

ui.siteSettingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (siteSettingsLoading) return;
  siteSettingsLoading = true;
  ui.siteSettingsSave.disabled = true;
  ui.siteSettingsMessage.textContent = '';
  try {
    const response = await fetch('/admin/api/site-settings', {
      method: 'PUT', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pluginNoticePosition: ui.siteSettingsPosition.value }),
    });
    if (response.status === 401) { showLogin(t('登录已过期，请重新登录。')); return; }
    if (response.status === 400) { ui.siteSettingsMessage.textContent = t('显示位置无效，请重新选择。'); return; }
    if (!response.ok) throw new Error('site-settings');
    siteSettingsLoaded = true;
    ui.siteSettingsMessage.textContent = t('主站显示设置已保存，刷新首页后生效。');
  } catch {
    ui.siteSettingsMessage.textContent = t('保存显示设置失败，请稍后重试。');
  } finally {
    siteSettingsLoading = false;
    ui.siteSettingsSave.disabled = false;
  }
});

ui.pluginRescan.addEventListener('click', () => refreshPlugins({ rescan: true }));
ui.pluginCatalogForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (pluginLoading) return;
  pluginLoading = true;
  ui.pluginCatalogButton.disabled = true;
  ui.pluginMessage.textContent = '';
  try {
    const response = await fetch('/admin/api/plugins/catalog', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: ui.pluginCatalogUrl.value.trim() }),
    });
    let payload = {};
    try { payload = await response.json(); } catch { /* handled below */ }
    if (response.status === 401) { pluginResponseError('AUTH_REQUIRED'); return; }
    if (!response.ok) { pluginResponseError(payload.error || 'PLUGIN_CATALOG_SHAPE'); return; }
    renderCatalog(payload.plugins, payload.name);
    ui.pluginMessage.textContent = t('目录已通过检查，共 {n} 个插件条目。', { n: payload.plugins?.length || 0 });
  } catch {
    ui.pluginMessage.textContent = t('读取插件目录失败，请检查地址和服务器网络。');
  } finally {
    pluginLoading = false;
    ui.pluginCatalogButton.disabled = false;
  }
});
ui.pluginDirectForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!ui.pluginDirectForm.reportValidity()) return;
  const payload = {
    url: ui.pluginZipUrl.value.trim(), sha256: ui.pluginZipSha.value.trim(),
  };
  if (ui.pluginZipId.value.trim()) payload.id = ui.pluginZipId.value.trim();
  if (ui.pluginZipBytes.value !== '') payload.bytes = Number(ui.pluginZipBytes.value);
  const ok = await installPackage(payload, ui.pluginInstall);
  if (ok) {
    ui.pluginZipUrl.value = '';
    ui.pluginZipSha.value = '';
    ui.pluginZipId.value = '';
    ui.pluginZipBytes.value = '';
  }
});

ui.refresh.addEventListener('click', () => refreshStatus());
ui.updateCheck.addEventListener('click', () => refreshUpdate({ force: true }));
ui.updateApply.addEventListener('click', async () => {
  const tag = updateState?.latestVersion;
  const busy = lastOverview && (lastOverview.online > 0 || lastOverview.roomTotal > 0 || lastOverview.matchTotal > 0);
  if (!updateState?.updateReady || !updateState?.enabled || !tag || busy || updateLoading) return;
  updateLoading = true;
  let statusUnknown = false;
  let actionMessage = '';
  ui.updateApply.disabled = true;
  ui.updateCheck.disabled = true;
  try {
    const response = await fetch('/admin/api/update', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag }),
    });
    if (response.status === 401) { showLogin(t('登录已过期，请重新登录。')); return; }
    if (!response.ok) {
      let error = '';
      try { error = (await response.json()).error || ''; } catch { /* keep the generic message */ }
      actionMessage = response.status === 409
        ? t(error === 'PLAYERS_ONLINE' ? '当前有玩家或对局，请等结束后更新。' : '新版本正在准备和检查，暂不能安装。')
        : t('更新未能启动，请稍后重试。');
    } else {
      renderUpdate({ ...updateState, phase: 'queued', updateReady: false });
      scheduleUpdatePoll(3000);
    }
  } catch {
    statusUnknown = true;
    actionMessage = t('暂时无法连接服务器，正在重试。');
    scheduleUpdatePoll(3000);
  } finally {
    updateLoading = false;
    const running = ['queued', 'applying', 'restarting', 'rolling_back'].includes(updateState?.phase);
    ui.updateCheck.disabled = running;
    ui.updateApply.disabled = statusUnknown || running || !updateState?.updateReady || Boolean(lastOverview && (lastOverview.online > 0 || lastOverview.roomTotal > 0 || lastOverview.matchTotal > 0));
    if (actionMessage && hasDashboard) ui.updateDescription.textContent = actionMessage;
  }
});
ui.logout.addEventListener('click', async () => {
  clearTimeout(pollingTimer);
  try {
    await fetch('/admin/api/logout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  } catch { /* hiding the dashboard still removes this browser's view */ }
  showLogin();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && hasDashboard) {
    refreshStatus({ quiet: true });
    refreshUpdate();
  }
});

await initializeLanguage();
applyLabels();
browser = mountAdminBrowser(ui.dashboard);
pollPanel = mountPollPanel($('admin-polls'), { admin: true, onUnauthorized: () => showLogin(t('登录已过期，请重新登录。')) });
pageNavigation = mountPageNavigation({
  root: ui.dashboard, attribute: 'data-admin-page', navigation: $('admin-navigation'), defaultPage: 'overview',
  pages: [
    ['overview', N_('运行总览')], ['players', N_('玩家状态')], ['rooms', N_('房间状态')],
    ['announcements', N_('公告管理')], ['polls', N_('投票管理')], ['plugins', N_('插件管理')],
    ['display', N_('显示设置')], ['updates', N_('更新中心')],
  ],
  onChange(page, title) {
    $('page-title').textContent = t(title);
    browser.close();
    if (hasDashboard && page === 'polls') pollPanel.refresh();
  },
});
showOnly(ui.login);
refreshStatus();
