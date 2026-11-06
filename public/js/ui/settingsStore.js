// Shared preference state without loading the settings modal / audio just to read image visibility.
// settings.js owns persistence and the audio / document effects, as before.
import { createStore, loadPref, savePref } from '../store.js';
import { sanitizeSettings } from './gameLogic/settings.js';

/**
 * 官方特效默认开启的一次性迁移：本版本更新后，每个浏览器第一次进游戏都把「官方特效」置为「完整」（老玩家也一样，
 * 即使他以前关过）。迁移后写 `sp.pref.fxDefaulted`，之后玩家手动切「关闭 / 完整」都按保存值来，不再重置。
 * 未来要再来一次全量默认，把 FX_DEFAULT_VERSION 加一。
 */
export const FX_DEFAULT_KEY = 'fxDefaulted';
export const FX_DEFAULT_VERSION = 1;
function applyFxDefaultOnce() {
  try {
    if (loadPref(FX_DEFAULT_KEY, null) === FX_DEFAULT_VERSION) return;
    const raw = loadPref('settings', null);
    // 没有存档的浏览器不写 settings：默认值本身就是 full，留给以后调整默认值的余地
    if (raw && typeof raw === 'object') savePref('settings', { ...raw, officialFx: 'full' });
    savePref(FX_DEFAULT_KEY, FX_DEFAULT_VERSION);
  } catch { /* 隐私模式：存不下就按内存默认 full，下次再试 */ }
}
applyFxDefaultOnce();

/** Settings store: { bgm, sfx, voice, voiceLang, voiceNative, voiceOverrides, muted, damageNumbers, officialDamageNumbers, ammoEnergyCount, fullscreenWakeLock, bondTimers, combatMetrics, prepDeployFold, quality, officialFx, otherSkins, textSize, keys }. */
export const settingsStore = createStore(sanitizeSettings(loadPref('settings', null)));
