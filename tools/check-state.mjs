#!/usr/bin/env node
// tools/check-state.mjs — 启动前检查挂进来的 state 文件（公告 / 投票 / 站点设置）能否被服务端读取。
//
//   node tools/check-state.mjs /path/announcements.json [/path/polls.json] [/path/site-settings.json]
//
// 退出码 0 = 全部可用；1 = 有文件格式不对（会打印服务端抛出的错误码）。
// 只读：不会修改或重写这些文件。
import { createAnnouncementStore } from '../server/http/announcements.js';
import { createPollStore } from '../server/http/polls.js';
import { createSiteSettingsStore } from '../server/http/siteSettings.js';

const [, , annPath, pollPath, sitePath] = process.argv;
if (!annPath) {
  console.error('用法: node tools/check-state.mjs <announcements.json> [polls.json] [site-settings.json]');
  process.exit(2);
}

let failed = false;
const show = (label, value) => console.log(`${label}: ${value}`);

try {
  const items = await createAnnouncementStore({ filePath: annPath }).list();
  show('公告 announcements', `${items.length} 条`);
  for (const item of items.slice(0, 5)) console.log(`  - [${item.priority}] ${item.title} (${new Date(item.publishedAt).toISOString()})`);
  if (items.length > 5) console.log(`  … 其余 ${items.length - 5} 条`);
} catch (error) {
  failed = true;
  console.error(`公告 announcements: 读取失败 ${error?.name || ''} ${error?.code || error?.message || error}`);
}

if (pollPath) {
  try {
    const polls = await createPollStore({ filePath: pollPath }).list();
    show('投票 polls', `${polls.length} 个`);
    for (const poll of polls.slice(0, 5)) console.log(`  - ${poll.title} · ${poll.totalVotes} 票 · ${poll.closedAt ? '已关闭' : '进行中'}`);
  } catch (error) {
    failed = true;
    console.error(`投票 polls: 读取失败 ${error?.name || ''} ${error?.code || error?.message || error}`);
  }
}

if (sitePath) {
  try {
    const settings = await createSiteSettingsStore({ filePath: sitePath }).get();
    show('站点设置 site-settings', settings.pluginNoticePosition);
  } catch (error) {
    failed = true;
    console.error(`站点设置 site-settings: 读取失败 ${error?.name || ''} ${error?.code || error?.message || error}`);
  }
}

process.exit(failed ? 1 : 0);
