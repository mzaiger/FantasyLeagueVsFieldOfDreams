/* =====================================================================
   ReplaySystem.js — instant replay: LIVE-flight ring recorder, ghost-ball
   playback with a mid-replay ANGLE CUT (low sideline dolly → crowd-side
   reverse), cinematic camera take-over, letterbox/lower-third chrome.
   Self-triggers a 'catch' replay off G's physics-honest outcome flags;
   Game.js still owns the HR call via tryBeginReplay('hr').
   Part of the Lincoln Red Gauntlet engine · js/core/
===================================================================== */
import * as THREE from 'three';
import { scene, camera } from './SceneManager.js';
import { ball } from '../physics/BallPhysics.js';
import { G } from './GameState.js';
import { FENCE_R } from './Constants.js';
import { canvasTex, clamp, lerp, dampF, rand } from '../utils/MathUtils.js';

/* ---- Tuning ---------------------------------------------------------- */
const CAP        = 900;   // ring budget (~15 s @60 fps)
const MIN_SPAN   = .45;   // min recorded seconds worth showing
const RATE       = .62;   // nominal playback dilation (slower than live)
const WALL_HR    = 2.6;   // hard wall-clock cap per replay (s) — HR
const WALL_CATCH = 1.75;  // outs get a shorter look (DEAD hold is brief)
const FOV_A      = 46;    // sideline lens
const FOV_B      = 40;    // reverse lens (tighter, long-lens compression)
const Z_FX       = 50;    // under the game's #final(60) / #boot(80) overlays

/* ---- Module state ------------------------------------------------------ */
let inited = false;
const buf  = new Float32Array(CAP * 4);   // stride-4 ring: t,x,y,z
let wAbs   = 0;                           // total samples ever written
let count  = 0;                           // samples in the current recording
let recT   = 0;
let recording = false, playing = false;
let playT = 0, wallDur = 1, uCut = .52;
let segA = 0, segB = 0;                   // playback window (absolute indices)
let fx = null, ghost = null, camSaved = null;
let dolly = 0, baseY = 1.6, revDolly = 0;
let side = 1;
let pendCatch = -1;                       // countdown to a self-triggered catch replay
let prevState = G.state;

/* Scratch — reused every frame, zero allocation in the hot path */
const _dir = new THREE.Vector3(), _perp = new THREE.Vector3(),
      _mid = new THREE.Vector3(), _base = new THREE.Vector3(),
      _pt  = new THREE.Vector3();

const slotOf = i => (i % CAP) * 4;

/* ---- Chrome (injected once; pure DOM/CSS, no external assets) ----------- */
const RP_CSS = `
#replayFx{position:fixed;inset:0;z-index:${Z_FX};pointer-events:none;font-family:'Barlow Condensed',system-ui,sans-serif}
#replayFx .rp-bar{position:absolute;left:0;right:0;height:0;background:#000;transition:height .45s cubic-bezier(.22,.61,.36,1)}
#replayFx .rp-top{top:0}
#replayFx .rp-bot{bottom:0}
#replayFx.on .rp-bar{height:9vh}
#replayFx .rp-tag{position:absolute;left:50%;bottom:calc(9vh + 24px);transform:translate(-50%,16px);
  display:flex;flex-direction:column;align-items:center;gap:7px;padding:9px 24px 8px;border-radius:999px;
  background:rgba(8,10,15,.55);border:1px solid rgba(242,193,78,.38);
  backdrop-filter:blur(10px) saturate(1.2);-webkit-backdrop-filter:blur(10px) saturate(1.2);
  color:#fff;font-weight:800;font-size:clamp(13px,2vw,18px);letter-spacing:6px;text-indent:6px;text-transform:uppercase;
  opacity:0;transition:opacity .45s cubic-bezier(.22,.61,.36,1),transform .45s cubic-bezier(.22,.61,.36,1)}
#replayFx .rp-tag::after{content:'';width:44px;height:2px;background:#F2C14E;border-radius:1px}
#replayFx.on .rp-tag{opacity:1;transform:translate(-50%,0)}
`;

/** Build ghost ball + letterbox chrome. Idempotent. */
export function initReplay() {
  if (inited) return;
  inited = true;

  /* Ghost ball — seams painted exactly like BallPhysics so it reads as THE baseball */
  const seam = canvasTex(256, 256, g => {
    g.fillStyle = '#fdfdfa'; g.fillRect(0, 0, 256, 256);
    g.strokeStyle = '#c8102e'; g.lineWidth = 7;
    [64, 192].forEach(cx => {
      g.beginPath();
      for (let y = 0; y <= 256; y += 6) {
        const x = cx + 46 * Math.sin((y / 256) * Math.PI * 1.12) + (cx < 128 ? -26 : 26);
        y === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
      }
      g.stroke();
    });
    for (let i = 0; i < 300; i++) { g.fillStyle = 'rgba(160,160,150,.12)'; g.fillRect(rand(0,256), rand(0,256), 2, 2); }
  });
  ghost = new THREE.Mesh(new THREE.SphereGeometry(.055, 20, 16),
    new THREE.MeshStandardMaterial({ map:seam, roughness:.4 }));
  ghost.castShadow = true; ghost.visible = false;
  scene.add(ghost);

  if (!document.getElementById('replay-style')) {
    const st = document.createElement('style'); st.id = 'replay-style';
    st.textContent = RP_CSS; document.head.appendChild(st);
  }
  fx = document.createElement('div'); fx.id = 'replayFx';
  fx.innerHTML = '<div class="rp-bar rp-top"></div><div class="rp-bar rp-bot"></div>'
               + '<div class="rp-tag">Instant Replay</div>';
  document.body.appendChild(fx);
}

/** Record during LIVE · drive playback while active · arm catch replays.
    Once per frame. The recorder is a preallocated Float32Array ring — no
    per-sample objects, no shift() compaction. */
export function updateReplay(dt) {
  if (!inited) return;
  dt = clamp(dt || 0, 0, .05);

  if (playing) {
    /* Abort safety — next at-bat (ANY non-DEAD state, incl. OVER) kills it */
    if (G.state !== 'DEAD') { endReplay(); return; }
    playT += dt;
    const u = clamp(playT / wallDur, 0, 1);
    drivePlayback(u, dt);
    if (u >= 1) endReplay();                        // natural completion
    return;
  }

  /* Self-trigger arm: a physics-honest caught fly ball earns a replay.
     Fires only while DEAD persists (the abort path covers early exits). */
  if (prevState === 'LIVE' && G.state === 'DEAD' &&
      G.result && G.result.type === 'flyout' && G.result.caught) pendCatch = .55;
  else if (G.state !== 'DEAD') pendCatch = -1;
  prevState = G.state;
  if (pendCatch >= 0) {
    pendCatch -= dt;
    if (pendCatch < 0 && G.state === 'DEAD') tryBeginReplay('catch');
  }

  /* Recording: fresh window at each not-recording→LIVE edge (covers PITCH→LIVE) */
  const live = G.state === 'LIVE' && !!(ball.mesh && ball.mesh.visible);
  if (live && !recording) { count = 0; recT = 0; recording = true; }
  else if (!live) recording = false;
  if (!recording) return;

  const s = slotOf(wAbs);
  buf[s] = recT; buf[s + 1] = ball.pos.x; buf[s + 2] = ball.pos.y; buf[s + 3] = ball.pos.z;
  wAbs++; count = Math.min(count + 1, CAP);
  recT += dt;
}

/** Start a replay of the last flight. True iff one actually began.
    kind: 'hr' (Game.js trigger) | 'catch' (self-triggered flyout). */
export function tryBeginReplay(kind) {
  if (!inited || playing || count < 12) return false;
  segA = wAbs - count;                              // contact = first sample
  segB = wAbs - 1;
  /* HR windows end AT the wall crossing — don't replay the kill-radius tail */
  if (kind !== 'catch') {
    let cross = -1;
    for (let i = segB; i >= segA; i--) {
      const s = slotOf(i);
      if (Math.hypot(buf[s + 1], buf[s + 3]) <= FENCE_R - .4) { cross = i; break; }
    }
    if (cross > segA + 10) segB = Math.min(segB, cross + 5);
  }
  const s0 = slotOf(segA), s1 = slotOf(segB);
  const span = buf[s1] - buf[s0];
  if (!(span > MIN_SPAN)) return false;
  wallDur = clamp(span / RATE, .9, kind === 'catch' ? WALL_CATCH : WALL_HR);

  /* Shot A: low lateral dolly alongside the flight midpoint. Shot B (the
     mid-replay cut): crowd-side reverse — mirrored, higher, tighter. */
  _dir.set(buf[s1 + 1] - buf[s0 + 1], 0, buf[s1 + 3] - buf[s0 + 3]);
  if (_dir.lengthSq() < .01) _dir.set(0, 0, -1);
  const carry = _dir.length(); _dir.normalize();
  side = Math.random() < .5 ? 1 : -1;
  _perp.set(_dir.z * side, 0, -_dir.x * side);
  _mid.set((buf[s0 + 1] + buf[s1 + 1]) / 2, 0, (buf[s0 + 3] + buf[s1 + 3]) / 2);
  _base.copy(_mid).addScaledVector(_perp, clamp(carry * .16, 10, 16));
  dolly = clamp(carry * .04, 2, 4.5);
  revDolly = -dolly * 1.35;                         // B dollies the other way
  baseY = clamp(1.2 + carry * .004, 1.2, 1.95);     // capped so the rise arc stays ≤2.5 m

  camSaved = { pos:camera.position.clone(), quat:camera.quaternion.clone(), fov:camera.fov };
  playT = 0; recording = false; playing = true;     // freeze the buffer under us
  ghost.rotation.set(rand(0, 6.28), rand(0, 6.28), 0);
  ghost.visible = true;
  if (fx) {
    fx.querySelector('.rp-tag').textContent =
      kind === 'catch' ? 'Catch Replay' : 'Home Run Replay';
    fx.classList.add('on');
  }
  return true;
}

export function replayActive() { return playing; }  // false pre-init by construction

/* ---- Internals ------------------------------------------------------------ */

/** Interpolate the ghost along the sampled arc + run the cine camera.
    Linear between samples — the dilation supplies the drama. One HARD angle
    cut at uCut: sideline dolly → crowd-side reverse. */
function drivePlayback(u, dt) {
  const f  = segA + u * (segB - segA);
  const i0 = Math.floor(f), i1 = Math.min(i0 + 1, segB), k = f - i0;
  const s0 = slotOf(i0), s1 = slotOf(i1);
  _pt.set(lerp(buf[s0 + 1], buf[s1 + 1], k),
          lerp(buf[s0 + 2], buf[s1 + 2], k),
          lerp(buf[s0 + 3], buf[s1 + 3], k));
  ghost.position.copy(_pt);
  ghost.rotation.x += dt * 14;                      // stepBall's spin, time-dilated
  ghost.rotation.y += dt * 6;

  const b = u < uCut;
  if (b) {                                          // A: sideline dolly + rise arc
    camera.position.copy(_base)
      .addScaledVector(_dir, lerp(-dolly, dolly, u / uCut))
      .addScaledVector(_perp, .15 * Math.sin(playT * 1.9));
    camera.position.y = baseY + Math.sin((u / uCut) * Math.PI) * .55;
    camera.fov = FOV_A;
  } else {                                          // B: crowd-side reverse, tighter
    camera.position.copy(_base)
      .addScaledVector(_perp, 7.5)
      .addScaledVector(_dir, lerp(revDolly, revDolly * .4, (u - uCut) / (1 - uCut)));
    camera.position.y = baseY + 3.1;
    camera.fov = FOV_B;
  }
  camera.lookAt(_pt);
  camera.updateProjectionMatrix();
}

/** Single exit: hide ghost, slide chrome out, hand the camera back.
    Wipes the window — a recording plays at most once. */
function endReplay() {
  if (!playing) return;
  playing = false;                                  // first line — replayActive can never stick
  if (ghost) ghost.visible = false;
  if (fx) fx.classList.remove('on');
  if (camSaved) {                                   // restore pose → director blends from here
    camera.position.copy(camSaved.pos);
    camera.quaternion.copy(camSaved.quat);
    camera.fov = camSaved.fov;
    camera.updateProjectionMatrix();
    camSaved = null;
  }
  count = 0; pendCatch = -1;
}
