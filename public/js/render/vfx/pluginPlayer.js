// Author flipbooks use Pixi's sprite/quad path on either board, on the same battle clock as official effects.
import { flipbookFrame } from './pluginFormat.js';
import { mergePluginFx, resolvePluginFxBinding } from './pluginLibrary.js';
import { skillRecordOf } from './skills.js';
import { UF } from '../../../../shared/constants.js';

export class PluginFxPlayer {
  constructor({ P, layer, screenLayer = layer, screenSize = () => ({ width: 1, height: 1 }), assets, cam, enabled, record, speed, ofx,
    quality = () => 'high', tier = () => 'full', load = () => 0 }) {
    Object.assign(this, { P, layer, screenLayer, screenSize, assets, cam, enabled, record, speed, ofx, quality, tier, load });
    this.live = new Set(); this.loops = new Map(); this.pendingEnds = new Map(); this.time = 0; this.textures = new Map();
    // Per-shot arrivals, keyed by the shot object; never a target-wide claim on damage events.
    this.hitClaims = new Map();
    this.source = null; this.catalog = mergePluginFx(null, {});
  }
  refresh() {
    const source = this.assets?.manifest?.fx;
    if (source !== this.source) { this.clear(); this.clearTextures(); this.source = source; this.catalog = mergePluginFx(null, source); }
  }
  binding(v, overrideIndex = null) {
    const rec = this.record(v?.info), idx = v?.info?.diy?.skillIndex ?? v?.info?.skillIndex ?? rec?.skill?.index;
    this.ofx.lib?.notePluginUnit?.(rec?.fx?.unit);
    const picked = overrideIndex ?? idx, sk = skillRecordOf(rec, picked);
    return resolvePluginFxBinding({ info: v?.info, record: rec, idx: picked, skillId: sk?.skillId, catalog: this.catalog });
  }
  capacity() {
    const q = this.quality(), tier = this.tier(), load = Math.max(0, Math.min(3, this.load() | 0));
    const base = q === 'low' ? 24 : q === 'medium' ? 48 : 96;
    const tierCap = tier === 'lite' ? Math.floor(base * 0.6) : base;
    return Math.max(8, Math.floor(tierCap * [1, 0.72, 0.5, 0.35][load]));
  }
  play(binding, at, { owner = null, duration = null, target = null, flight = null, loop = false, done = null, screen = false } = {}) {
    this.refresh();
    const spec = typeof binding === 'string' ? { effect: binding } : binding;
    const key = typeof spec?.effect === 'string' ? spec.effect : null;
    if (!this.enabled() || !key || !at || owner?.destroyed || owner?.alive === false || this.live.size >= this.capacity()) return null;
    const b = this.catalog.books.get(key), prefab = this.catalog.descriptors.has(key);
    if (!b && !prefab) return null;
    if (prefab && !this.ofx.active) return null;
    const pos = { x: at.x, y: at.y, z: at.z || 0 };
    const e = { key, b, owner, target, flight, loop, done, pos, screen, scale: spec.scale, start: this.time,
      end: this.time + (duration ?? (loop ? 600 : b ? b.frames / b.fps : 4)), dead: false, sprite: null, handle: null };
    if (b) {
      let base = this.textures.get(b.url);
      if (!base) { base = this.P.BaseTexture.from(b.url); this.textures.set(b.url, base); }
      e.texture = new this.P.Texture(base);
      e.sprite = new this.P.Sprite(e.texture);
      e.sprite.anchor.set(...(b.anchor || [0.5, 0.5]));
      e.sprite.blendMode = b.blend === 'add' ? this.P.BLEND_MODES.ADD : this.P.BLEND_MODES.NORMAL;
      e.sprite.tint = Number.isInteger(spec.tint) ? spec.tint : 0xffffff;
      e.sprite.alpha = Number.isFinite(spec.alpha) ? spec.alpha : 1;
      (screen ? this.screenLayer : this.layer).addChild(e.sprite);
    } else {
      e.handle = this.ofx.spawn(key, { pos: [pos.x - 10, pos.y - 9, -pos.z] }, { owner, loop });
      if (!e.handle) return null;
    }
    e.stop = () => { if (e.dead) return; e.dead = true; e.handle?.kill(); e.sprite?.destroy(); e.texture?.destroy(false); this.live.delete(e); };
    this.live.add(e);
    return e;
  }
  phase(v, phase, at = v, options = {}) {
    this.refresh();
    return this.play(this.binding(v)[phase], at, { owner: v, ...options });
  }
  skill(v, on) {
    const id = v?.info?.id ?? v?.id;
    this.loops.get(id)?.stop(); this.loops.delete(id);
    if (!on) return !!this.phase(v, 'skillEnd');
    const start = this.phase(v, 'skillStart');
    const e = this.phase(v, 'skillLoop', v, { loop: true });
    if (e) this.loops.set(id, e);
    return !!(start || e);
  }
  cast(v, slot, duration = 0) {
    this.refresh();
    const binding = this.binding(v, slot), seconds = Number.isFinite(duration) ? Math.max(0, Math.min(30, duration)) : 0;
    const id = v?.info?.id ?? v?.id ?? v;
    this.loops.get(id)?.stop(); this.loops.delete(id); this.pendingEnds.delete(id);
    const start = this.play(binding.skillStart, v, { owner: v });
    let loop = null, ended = false;
    const finish = () => {
      if (ended) return;
      ended = true; this.pendingEnds.delete(id);
      if (this.loops.get(id) === loop) this.loops.delete(id);
      this.play(binding.skillEnd, v, { owner: v });
    };
    if (seconds > 0) {
      loop = this.play(binding.skillLoop, v, { owner: v, loop: true, duration: seconds, done: finish });
      if (loop) this.loops.set(id, loop);
      if (binding.skillEnd && (start || loop)) this.pendingEnds.set(id, { at: this.time + seconds, owner: v, finish });
    }
    if (seconds <= 0 && !start) return false;
    return !!(start || loop);
  }
  sync(views) {
    if (!this.enabled()) return;
    for (const v of views) {
      const id = v?.info?.id ?? v?.id, on = v.alive !== false && !!((v.flags | 0) & UF.SKILL);
      const held = this.loops.get(id);
      if (!on && held) { held.stop(); this.loops.delete(id); }
      if (on && (!held || held.dead)) {
        const e = this.phase(v, 'skillLoop', v, { loop: true });
        if (e) this.loops.set(id, e);
      }
    }
  }
  attack(src, tgt, kind) {
    if (!src || !tgt) return false;
    const cast = this.phase(src, 'attack');
    if (!kind || kind === 'none') return !!cast;
    // [ASSUMED] Match the generic projectile speed; the event does not carry an authoritative arrival time.
    const flight = Math.max(0.05, Math.min(3, Math.hypot(tgt.x - src.x, tgt.y - src.y) / Math.max(1, this.speed(kind))));
    const projectile = this.phase(src, 'projectile', src, { target: tgt, flight, duration: flight });
    if (this.enabled() && src.alive !== false && !src.destroyed && this.binding(src).hit && this.hitClaims.size < 128) {
      this.hitClaims.set({ src, tgt }, this.time + flight);
    }
    return !!projectile;
  }
  hit(src, target) {
    // [ASSUMED] The damage tuple has no ranged source id. Only an identified source that draws a hit may
    // suppress this event's spark; estimated arrivals cannot claim unrelated ranged, husk or paired damage.
    return src ? !!this.phase(src, 'hit', target) : false;
  }
  simFx(kind, x, y, extra) {
    this.refresh();
    if (kind === 'phase' && this.catalog.silent.has(extra?.kind)) return true;
    const event = this.catalog.eventBindings[kind];
    if (event && (event.scope !== 'field' || extra?.id == null)) {
      const field = event.scope === 'field';
      const duration = Number.isFinite(extra?.duration) ? Math.max(0.05, Math.min(30, extra.duration)) : event.duration;
      if (this.play(event, { x, y }, { screen: field, loop: field, duration: duration ?? (field ? 1.2 : null) })) return true;
    }
    if (kind !== 'plugin') return false;
    // A missing/disabled plugin effect is a silent visual no-op, never a procedural fallback.
    if (typeof extra?.skill === 'string') this.play(extra.skill, { x, y }, { duration: Number.isFinite(extra.dur) ? Math.max(0, Math.min(30, extra.dur)) : null });
    return true;
  }
  update(dt) {
    this.refresh();
    if (!this.enabled()) { this.clear(); return; }
    this.time += Math.max(0, dt);
    for (const [shot, at] of this.hitClaims) {
      const { src, tgt } = shot;
      if (src.destroyed || src.alive === false || tgt.destroyed || tgt.alive === false) this.hitClaims.delete(shot);
      else if (at <= this.time) { this.hitClaims.delete(shot); this.phase(src, 'hit', tgt); }
    }
    for (const e of [...this.live]) {
      if (e.owner && (e.owner.destroyed || e.owner.alive === false)) { e.stop(); continue; }
      if (this.time >= e.end) { e.stop(); e.done?.(); continue; }
      const age = this.time - e.start;
      let pos = e.loop && e.owner ? e.owner : e.pos;
      if (e.flight && e.target) { const f = Math.min(1, age / e.flight); pos = { x: e.pos.x + (e.target.x - e.pos.x) * f, y: e.pos.y + (e.target.y - e.pos.y) * f, z: (e.pos.z || 0) + 0.4 }; }
      e.handle?.place({ pos: [pos.x - 10, pos.y - 9, -(pos.z || 0)] });
      if (!e.b) continue;
      const frame = flipbookFrame(e.b, age, e.loop || !!e.flight || e.b.loop);
      if (!frame) { e.stop(); continue; }
      const base = e.texture.baseTexture;
      if (!base.valid) { e.sprite.visible = false; continue; }
      const w = e.b.w / e.b.cols, h = e.b.h / frame.rows;
      e.texture.frame = new this.P.Rectangle(frame.col * w, frame.row * h, w, h);
      e.sprite.visible = true;
      if (e.screen) {
        const size = this.screenSize();
        e.sprite.position.set(0, 0); e.sprite.width = size.width; e.sprite.height = size.height;
      } else {
        const p = this.cam().project(pos.x, pos.y, (pos.z || 0) + 0.4);
        e.sprite.position.set(p.x, p.y);
        e.sprite.width = p.s * (e.scale ?? e.b.scale ?? 1); e.sprite.height = e.sprite.width * h / w;
      }
    }
    for (const [id, pending] of this.pendingEnds) {
      if (pending.owner?.destroyed || pending.owner?.alive === false) { this.pendingEnds.delete(id); continue; }
      if (pending.at <= this.time) pending.finish();
    }
  }
  clearField() { for (const e of [...this.live]) if (e.screen) e.stop(); }
  finish() { for (const e of [...this.live]) if (e.loop) e.stop(); this.loops.clear(); this.pendingEnds.clear(); this.hitClaims.clear(); }
  clear() { for (const e of [...this.live]) e.stop(); this.loops.clear(); this.pendingEnds.clear(); this.hitClaims.clear(); }
  clearTextures() { for (const base of this.textures.values()) base.destroy(); this.textures.clear(); }
  destroy() { this.clear(); this.clearTextures(); }
}
