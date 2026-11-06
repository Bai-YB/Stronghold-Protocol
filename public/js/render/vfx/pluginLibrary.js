// Validated, hash-pinned visual-set effects. All runtime keys are private to one plugin.
import { fxNamespace, fxPath, fxId, fxObject, ownsFxUnit, pluginFxProblems, PLUGIN_FX_LIMITS as CAP } from './pluginFormat.js';
import { boundedFxJson, validateFxPrefab } from './pluginValidate.js';

// The loader pins its checked dependency owners in the effects payload. Legacy payloads own only their provider's
// namespace; deriving ownership from bind/index keys would let the payload authorize itself.
function validPluginFx(id, e) {
  try {
    if (!fxId(id) || !fxObject(e)) return false;
    const owners = e.owners ?? [id];
    if (!Array.isArray(owners) || !owners.includes(id) || !owners.every(fxId) || pluginFxProblems(e.config, owners).length) return false;
    if (e.index) {
      boundedFxJson(e.index);
      if (!fxObject(e.index.units) || Object.keys(e.index.units).length > CAP.units ||
        Object.keys(e.index.units).some(key => !ownsFxUnit(key, owners))) return false;
    }
    const prefabs = e.prefabs ?? {};
    if (!fxObject(prefabs) || Object.keys(prefabs).length > CAP.effects) return false;
    for (const [key, d] of Object.entries(prefabs)) {
      if (!fxId(key) || key !== d?.key) return false;
      validateFxPrefab(d, e.textures || {});
    }
    return true;
  } catch { return false; }
}

function namespacedBinding(value, namespace) {
  return typeof value === 'string' ? namespace + value : { ...value, effect: namespace + value.effect };
}

function namespacedPhases(phases, namespace) {
  return Object.fromEntries(Object.entries(phases || {}).map(([phase, value]) => [phase, namespacedBinding(value, namespace)]));
}

function namespacedTable(table, namespace) {
  return Object.fromEntries(Object.entries(table || {}).map(([target, skills]) => [target,
    Object.fromEntries(Object.entries(skills).map(([skill, phases]) => [skill, namespacedPhases(phases, namespace)]))]));
}

function phasesFor(table, key, index, skillId) {
  const row = table?.[key];
  if (!fxObject(row)) return {};
  const out = {};
  for (const slot of ['default', Number.isInteger(index) ? String(index) : null, skillId].filter((v, i, all) => v && all.indexOf(v) === i)) {
    if (fxObject(row[slot])) Object.assign(out, row[slot]);
  }
  return out;
}

/** Resolve old direct operator/skin/enemy declarations together with namespaced plugin-unit bindings. */
export function resolvePluginFxBinding({ info, record, idx, skillId, catalog } = {}) {
  if (!info || !catalog) return {};
  const enemy = info.kind === 'enemy' || info.side === 'enemy';
  if (enemy) return phasesFor(catalog.enemyBindings, info.defId || info.spine, idx, skillId);
  const charId = info.diy?.charId || record?.charId || info.charId || info.spine || info.defId;
  const base = phasesFor(catalog.operatorBindings, charId, idx, skillId);
  const plugin = phasesFor(catalog.bindings, charId, idx, skillId);
  const skin = info.kind === 'op' && typeof info.skin === 'string' ? phasesFor(catalog.skinBindings, info.skin, idx, skillId) : {};
  return { ...base, ...plugin, ...skin };
}

/** Extend a checked visual document's prepared writes without changing the legacy visual protocol. */
export function preparePluginFx(doc, visual) {
  const writes = (doc?.writes || []).flatMap(w => (w.ops || []).filter(op => op.effects).map(op => ({ id: w.id, op })));
  if (!writes.length || visual.checkVisualDoc(doc, doc.visual?.vs)) return [];
  const out = [];
  for (const { id, op } of writes) {
    if (op.at?.length !== 2 || op.at[0] !== 'fx' || op.at[1] !== id) continue;
    const files = doc.visual.overlays.find(o => o.id === id)?.files || {};
    const e = op.effects;
    // Hash validation proves which payload arrived; ownership and prefab budgets must still hold in the browser.
    if (!validPluginFx(id, e) || !e.images) continue;
    const urls = [], images = {};
    let bad = false;
    for (const rel of Object.keys(e.images)) {
      const hash = files[rel];
      if (!fxPath(rel) || !/^[a-f0-9]{64}$/.test(hash)) { bad = true; break; }
      const url = `/p/${id}/${hash.slice(0, 8)}/${rel}`;
      images[rel] = { ...e.images[rel], url }; urls.push(url);
    }
    if (!bad) out.push({ at: ['fx', id], value: { ...e, id, images }, urls });
  }
  return out;
}

/** Merge a fragment without mutating the official index, or replacing any official key. */
export function mergePluginFx(index, effects) {
  const idx = { ...(index || { format: 'fx-index', version: 3 }), units: { ...index?.units }, skills: { ...index?.skills },
    prefabs: { ...index?.prefabs }, skins: { ...index?.skins }, projectiles: { ...index?.projectiles }, pluginUnits: {} };
  const descriptors = new Map(), textures = {}, books = new Map(), bindings = {}, operatorBindings = {}, skinBindings = {}, enemyBindings = {}, eventBindings = {}, silent = new Set();
  for (const [id, e] of Object.entries(effects || {})) {
    if (!validPluginFx(id, e)) continue;
    const ns = fxNamespace(id), ix = e.index;
    const names = new Set([...Object.keys(ix?.prefabs || {}), ...Object.keys(ix?.skills || {}), ...Object.keys(e.textures || {})]);
    const rewrite = (v, key = '') => {
      if (typeof v === 'string') return names.has(v) && !['name', 'class', 'role', 'kind', 'from', 'ability', 'rootClass'].includes(key) ? ns + v : v;
      if (Array.isArray(v)) return v.map(x => rewrite(x, key));
      if (!v || typeof v !== 'object') return v;
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [key === 'skills' ? ns + k : k, rewrite(x, k)]));
    };
    for (const [key, u] of Object.entries(ix?.units || {})) { idx.units[ns + key] = rewrite(u); idx.pluginUnits[key] = ns + key; }
    for (const [key, s] of Object.entries(ix?.skills || {})) idx.skills[ns + key] = rewrite(s);
    for (const [key, p] of Object.entries(ix?.prefabs || {})) idx.prefabs[ns + key] = { ...p };
    for (const [key, d] of Object.entries(e.prefabs || {})) descriptors.set(ns + key, rewrite(d));
    for (const [key, t] of Object.entries(e.textures || {})) if (e.images[t.path]) textures[ns + key] = { path: e.images[t.path].url };
    for (const [key, b] of Object.entries(e.config.flipbooks || {})) if (e.images[b.image]) books.set(ns + key, { ...b, ...e.images[b.image] });
    for (const [unit, skills] of Object.entries(e.config.bind || {})) {
      bindings[unit] = Object.fromEntries(Object.entries(skills).map(([s, phases]) => [s, namespacedPhases(phases, ns)]));
    }
    Object.assign(operatorBindings, namespacedTable(e.config.bindOperators, ns));
    Object.assign(skinBindings, namespacedTable(e.config.bindSkins, ns));
    Object.assign(enemyBindings, namespacedTable(e.config.bindEnemies, ns));
    for (const [event, binding] of Object.entries(e.config.bindEvents || {})) eventBindings[event] = namespacedBinding(binding, ns);
    for (const phase of e.config.silentPhases || []) silent.add(phase);
  }
  return { index: idx, descriptors, textures, books, bindings, operatorBindings, skinBindings, enemyBindings, eventBindings, silent };
}
