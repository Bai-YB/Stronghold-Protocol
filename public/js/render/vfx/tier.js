// render/vfx/tier.js — 设置「官方特效」 (settings `officialFx`): 'auto' | 'off' | 'lite' | 'full' → the tier the
// official battle effects run at. Only 完整 ('full') runs the host's extracted official effects; 精简 ('lite') and
// 关闭 ('off') both draw this repo's own procedural skill/hit effects (identical to each other). 'auto' is 完整 on a
// desktop and the repo's own effects on a touch device. Nothing runs when no effects were extracted from the local
// client (the setting is hidden then, ui/settings.js).

export const OFFICIAL_FX = Object.freeze(['auto', 'off', 'lite', 'full']);

/** A touch-first device (coarse pointer, no fine one): the light tier by default. */
export function touchDevice() {
  try {
    const mm = globalThis.matchMedia;
    if (typeof mm !== 'function') return false;
    return mm('(pointer: coarse)').matches && !mm('(any-pointer: fine)').matches;
  } catch { return false; }
}

/** The effective tier of a setting value ('off' | 'full'): only 'full' enables the extracted official effects. */
export function resolveOfficialFx(value, available = true, touch = touchDevice()) {
  if (!available) return 'off';
  if (value === 'full') return 'full';
  if (value === 'off' || value === 'lite') return 'off';   // 精简 = 关闭 = 本仓库自带的技能与打击特效
  return touch ? 'off' : 'full';                            // 'auto': 完整 on a desktop, the repo's own on touch
}
