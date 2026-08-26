/* =====================================================================
   StrikeZone.js — broadcast-style strike-zone overlay at the plate,
   plus a flash-and-fade pitch-location marker on every taken pitch.
   Bounds mirror the umpire in Game.js judgeTake(): |x| <= .24, y ∈ [.72, 1.32].
   Part of the Lincoln Red Gauntlet engine · js/ui/
===================================================================== */
import * as THREE from 'three';
import { G } from '../core/GameState.js';
import { dampF, clamp, softCircleTexture, now } from '../utils/MathUtils.js';

const ZX = .24;                       // half-width of the zone
const Z_LO = .72, Z_HI = 1.32;        // bottom / top of the zone
const Z_Z = .15;                      // plane depth (matches G.pitch.target.z)
const ZCY = (Z_LO + Z_HI) / 2;

const MARK_N = 4, MARK_T = 1.0;       // pooled marks · seconds from flash to gone

let root = null, zoneG = null, markG = null;
let frameMat = null, gridMat = null, fillMat = null;
let texStrike = null, texBall = null;   // mark styles: gold reads STRIKE, pearl reads BALL
let level = 0;                        // smoothed show amount (0 hidden · 1 shown)
let prevState = null;                 // last-seen G.state — for resolve edge detection
const MARKS = [];
let markIdx = 0;

/* ---- Pitch-mark pool (round-robin) ------------------------------------ */
function dropMark(target) {
  if (!target || !texStrike) return;
  const m = MARKS[markIdx = (markIdx + 1) % MARK_N];
  /* Colour IS the call — gold dot inside the grid = strike, pearl dot
     outside it = ball (mirrors judgeTake()'s zone exactly) */
  m.in = Math.abs(target.x) <= ZX && target.y >= Z_LO && target.y <= Z_HI;
  m.s.material.map = m.in ? texStrike : texBall;
  m.s.material.needsUpdate = true;
  m.s.position.set(target.x, target.y, Z_Z - .01);
  m.age = 0;
  m.s.material.opacity = 0;
  m.s.visible = true;
}

export function initStrikeZone(scene) {
  if (!scene || root) return;

  root = new THREE.Group();
  root.name = 'strikeZone';
  root.visible = false;
  scene.add(root);

  zoneG = new THREE.Group(); zoneG.name = 'zoneRect';
  markG = new THREE.Group(); markG.name = 'zoneMarks';
  root.add(zoneG, markG);

  /* Outer frame — crisp white line pairs; depthTest off so it can never
     z-fight with the plate or be swallowed by the catcher's mitt */
  frameMat = new THREE.LineBasicMaterial({ color:0xffffff, transparent:true,
    opacity:.75, depthTest:false, depthWrite:false });
  const X = ZX, Y0 = Z_LO, Y1 = Z_HI, Z = Z_Z;
  const frameGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-X, Y0, Z), new THREE.Vector3( X, Y0, Z),   // bottom
    new THREE.Vector3(-X, Y1, Z), new THREE.Vector3( X, Y1, Z),   // top
    new THREE.Vector3(-X, Y0, Z), new THREE.Vector3(-X, Y1, Z),   // left
    new THREE.Vector3( X, Y0, Z), new THREE.Vector3( X, Y1, Z)    // right
  ]);
  const frame = new THREE.LineSegments(frameGeo, frameMat);
  frame.renderOrder = 920;
  zoneG.add(frame);

  /* 3×3 inner grid — thirds of the zone at a quieter opacity */
  gridMat = new THREE.LineBasicMaterial({ color:0xffffff, transparent:true,
    opacity:.26, depthTest:false, depthWrite:false });
  const gpts = [];
  [-X / 3, X / 3].forEach(x => gpts.push(new THREE.Vector3(x, Y0, Z), new THREE.Vector3(x, Y1, Z)));
  [Y0 + (Y1 - Y0) / 3, Y0 + 2 * (Y1 - Y0) / 3].forEach(y => gpts.push(new THREE.Vector3(-X, y, Z), new THREE.Vector3(X, y, Z)));
  const grid = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(gpts), gridMat);
  grid.renderOrder = 921;
  zoneG.add(grid);

  /* Whisper-faint fill so the zone reads as a surface, not just wireframe */
  fillMat = new THREE.MeshBasicMaterial({ color:0xffffff, transparent:true,
    opacity:.06, side:THREE.DoubleSide, depthTest:false, depthWrite:false });
  const fill = new THREE.Mesh(new THREE.PlaneGeometry(2 * X, Y1 - Y0), fillMat);
  fill.position.set(0, ZCY, Z);
  fill.renderOrder = 919;
  zoneG.add(fill);

  /* Mark pool — soft dots that pop in and melt away. Two shared textures,
     per-sprite materials so each dot fades on its own clock:
     gold (#F2C14E) marks strikes landed in the grid, pearl-white marks balls */
  texStrike = softCircleTexture('rgba(242,193,78,1)', 'rgba(242,193,78,0)');
  texBall = softCircleTexture('rgba(232,232,238,1)', 'rgba(232,232,238,0)');
  for (let i = 0; i < MARK_N; i++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map:texBall, color:0xffffff,
      transparent:true, opacity:0, depthWrite:false, depthTest:false }));
    s.visible = false; s.renderOrder = 940;
    markG.add(s);
    MARKS.push({ s, age:MARK_T, in:false });   // age >= MARK_T ⇒ idle
  }
}

/* ---- Per-frame update — call from the main tick ------------------------
   Zone shows (with a gentle pulse) only through WINDUP & PITCH; every other
   state fades it out. A PITCH → DEAD transition with a live pitch descriptor
   drops a marker at the pitch's plate location. Stateless w.r.t. the count. */
export function updateStrikeZone(dt = 0, t = now()) {
  if (!root || !G) return;
  const st = G.state;

  /* Resolve edge: pitch crossed the plate untimed (take or swing-miss) */
  if (prevState !== null && st !== prevState && st === 'DEAD' && prevState === 'PITCH'
      && G.pitch && G.pitch.target)
    dropMark(G.pitch.target);
  prevState = st;

  /* Fade the rectangle toward its target visibility (~¼s either way) */
  const want = (st === 'WINDUP' || st === 'PITCH') ? 1 : 0;
  level += (want - level) * dampF(want > level ? 12 : 15, dt);
  const active = level > .01;
  const marksLive = MARKS.some(m => m.age < MARK_T);
  root.visible = active || marksLive;
  zoneG.visible = active;
  markG.visible = marksLive;

  if (active) {
    const pulse = 1 + Math.sin(t * 6.2) * .09;   // gentle broadcast shimmer
    frameMat.opacity = clamp(.75 * level * pulse, 0, 1);
    gridMat.opacity  = clamp(.26 * level * pulse, 0, 1);
    fillMat.opacity  = clamp(.06 * level * pulse, 0, 1);
  }

  /* Marks: quick flash in (~90 ms), then ease out over the rest of a second */
  for (const m of MARKS) {
    if (m.age >= MARK_T) continue;
    m.age += dt;
    const u = m.age / MARK_T;
    if (u >= 1) { m.s.visible = false; continue; }
    m.s.material.opacity = .95 * clamp(m.age / .09, 0, 1) * Math.pow(1 - u, 1.7);
    m.s.scale.setScalar((m.in ? .175 : .145) + .05 * u);   // strikes read a touch bigger
  }
}
