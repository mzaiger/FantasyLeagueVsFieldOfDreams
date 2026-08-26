/* =====================================================================
   MathUtils.js — math helpers, canvas textures, master clock & scheduler
   Part of the Lincoln Red Gauntlet engine · js/utils/
===================================================================== */
import * as THREE from 'three';

export const DEG = Math.PI / 180, TAU = Math.PI * 2;
export const rand  = (a, b) => a + Math.random() * (b - a);
export const rint  = (a, b) => Math.floor(rand(a, b + 1));
export const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
export const lerp  = (a, b, t) => a + (b - a) * t;
export const dampF = (k, dt) => 1 - Math.exp(-k * dt);
export const easeOut = t => 1 - Math.pow(1 - t, 3);
export const easeIn  = t => t * t * t;
export const easeIO  = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
export const pick = a => a[Math.floor(Math.random() * a.length)];
export function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
export const $ = id => document.getElementById(id);

/* ---- Master clock & frame scheduler --------------------------------- */
const CLOCK = new THREE.Clock();
const SCHED = [];

/** Schedule `fn` to run `sec` seconds from NOW (game-time). */
export function after(sec, fn) { SCHED.push({ t: CLOCK.elapsedTime + sec, fn }); }

/** Fire every due scheduled callback (called once per frame by the loop). */
export function runSched() {
  for (let i = SCHED.length - 1; i >= 0; i--) {
    if (CLOCK.elapsedTime >= SCHED[i].t) {
      const f = SCHED[i].fn; SCHED.splice(i, 1);
      try { f(); } catch (e) { console.error('[sched]', e); }
    }
  }
}
export const now      = () => CLOCK.elapsedTime;
export const getDelta = () => Math.min(CLOCK.getDelta(), .05);
export const schedLen = () => SCHED.length;

/* ---- Procedural texture helpers -------------------------------------- */
export function softCircleTexture(inner, outer) {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  gr.addColorStop(0, inner); gr.addColorStop(1, outer);
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * Canvas-backed texture. `draw(ctx, w, h)` paints it; `rep` = [repeatX, repeatY].
 * Needs the renderer for anisotropy — set via `configureCanvasTex(renderer)` once.
 */
let MAX_ANISO = 4;
export function configureCanvasTex(renderer) {
  MAX_ANISO = Math.min(8, renderer.capabilities.getMaxAnisotropy());
}
export function canvasTex(w, h, draw, rep) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = MAX_ANISO;
  if (rep) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rep[0], rep[1]); }
  return t;
}
