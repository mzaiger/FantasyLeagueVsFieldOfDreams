/* =====================================================================
   PitchPicker.js — player pitch-location picker for the half-innings
   when LINCOLN FIELDS (CPU bats). A dark-glass panel with a 3×3 grid
   matching the umpire's zone box (|x| ≤ .24 m, y ∈ [.72, 1.32] — same
   bounds StrikeZone.js draws and Game.js judgeTake() calls); tap a cell
   or DRAG anywhere in the grid for fine aim, then hit PITCH to commit.
   Part of the Lincoln Red Gauntlet engine · js/ui/

   CONTRACT:
     init({ onCommit })   build once; onCommit({x,y}) fires on PITCH
     show() / hide()      display control (Game.js owns WHEN)
     reset()              clear the placed target
     getTarget()          current aimed spot {x,y} or null

   Purely EVENT-DRIVEN DOM — zero per-frame work.
===================================================================== */
import { $ } from '../utils/MathUtils.js';

/* Zone geometry — MUST mirror StrikeZone.js / judgeTake() */
const ZX = .24;
const Z_LO = .72, Z_HI = 1.32;

let root = null, gridEl = null, markEl = null, btnEl = null;
let onCommit = null;
let target = null;                       // {x, y} in plate metres, or null
let dragging = false;

/** Map a point in the grid's client rect to plate metres. */
function ptFromEvent(e) {
  const r = gridEl.getBoundingClientRect();
  const u = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  const v = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
  return { x: (u * 2 - 1) * ZX, y: Z_HI - v * (Z_HI - Z_LO) };
}

function place(t) {
  target = t;
  markEl.style.display = 'block';
  /* position the marker INSIDE the padded grid box (same mapping as ptFromEvent,
     minus one border pixel so the dot never clips) */
  const r = gridEl.getBoundingClientRect();
  const u = (t.x / ZX + 1) / 2, v = (Z_HI - t.y) / (Z_HI - Z_LO);
  markEl.style.left = (u * r.width - 7) + 'px';
  markEl.style.top = (v * r.height - 7) + 'px';
  btnEl.disabled = false;
}

export function initPitchPicker(o = {}) {
  if (root) return;
  onCommit = o.onCommit || null;

  root = document.createElement('div');
  root.id = 'pp-root';
  root.className = 'glass';
  root.style.cssText =
    'position:fixed;right:calc(12px + env(safe-area-inset-right));bottom:118px;z-index:22;' +
    'padding:10px 12px;display:none;flex-direction:column;gap:8px;align-items:center;' +
    'touch-action:none;';
  root.innerHTML =
    `<div style="font-family:'Barlow Condensed';font-weight:800;font-size:14px;letter-spacing:2.5px;` +
      `color:#F2C14E">PICK YOUR SPOT</div>` +
    `<div id="pp-grid" style="position:relative;width:132px;height:150px;border-radius:10px;overflow:hidden;` +
      `cursor:crosshair;background:rgba(255,255,255,.05);border:1.5px solid rgba(255,255,255,.35);` +
      `background-image:linear-gradient(rgba(255,255,255,.16) 1px,transparent 1px),` +
      `linear-gradient(90deg,rgba(255,255,255,.16) 1px,transparent 1px);` +
      `background-size:33.4% 33.4%;background-position:-.5px -.5px;">` +
      `<div id="pp-mark" style="display:none;position:absolute;width:14px;height:14px;border-radius:50%;` +
        `background:#C8102E;border:2px solid #fff;box-shadow:0 0 10px rgba(200,16,46,.85);` +
        `pointer-events:none;"></div>` +
    `</div>` +
    `<button id="pp-pitch" disabled style="border:0;cursor:pointer;padding:9px 26px;border-radius:999px;` +
      `font-family:'Barlow Condensed';font-weight:800;font-size:17px;letter-spacing:2px;color:#fff;` +
      `background:radial-gradient(circle at 32% 28%,#ff5a6e,#C8102E 58%,#6e0009);` +
      `box-shadow:var(--shadow)">PITCH</button>`;

  document.body.appendChild(root);
  gridEl = $('pp-grid');
  markEl = $('pp-mark');
  btnEl = $('pp-pitch');

  /* Pointer events cover mouse + touch; the game supports tap input */
  gridEl.addEventListener('pointerdown', e => {
    e.preventDefault();
    dragging = true;
    try { gridEl.setPointerCapture(e.pointerId); } catch (_) { /* synthetic pointers can't be captured */ }
    place(ptFromEvent(e));
  });
  gridEl.addEventListener('pointermove', e => {
    if (!dragging) return;
    e.preventDefault();
    place(ptFromEvent(e));
  });
  const stop = () => { dragging = false; };
  gridEl.addEventListener('pointerup', stop);
  gridEl.addEventListener('pointercancel', stop);

  btnEl.addEventListener('click', () => {
    if (!target || !onCommit || btnEl.disabled) return;
    const t = target;
    reset();
    onCommit(t);
  });
}

export function show() {
  if (root) root.style.display = 'flex';
}
export function hide() {
  if (root) root.style.display = 'none';
  reset();
}
export function reset() {
  target = null;
  if (markEl) markEl.style.display = 'none';
  if (btnEl) btnEl.disabled = true;
}
export function getTarget() {
  return target;
}
