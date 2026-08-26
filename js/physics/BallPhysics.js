/* =====================================================================
   BallPhysics.js — ball entity: pitching break, aerodynamic drag,
   bounce/restitution, wall collision, flight prediction.
   Part of the Lincoln Red Gauntlet engine · js/physics/
===================================================================== */
import * as THREE from 'three';
import { scene } from '../core/SceneManager.js';
import { canvasTex, rand, clamp, DEG } from '../utils/MathUtils.js';
import { FENCE_R, FENCE_H, BALLISTICS } from '../core/Constants.js';
import { G } from '../core/GameState.js';
import { FX } from '../effects/ParticleSystem.js';
import { SND } from '../audio/AudioManager.js';

export const ball = {
  mesh:null,
  pos:new THREE.Vector3(), vel:new THREE.Vector3(),
  mode:'hidden',                    // hidden | pitched | held | batted | rolling | dead | thrown
  breakA:new THREE.Vector3(),       // pitch acceleration (curve/change break)
  lift:1,                           // gravity scale for carry tuning
  bounced:false,                    // batted ball has touched the ground — no clean-fly catch
  trailT:0
};

{
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
  ball.mesh = new THREE.Mesh(new THREE.SphereGeometry(.055, 20, 16),
    new THREE.MeshStandardMaterial({ map:seam, roughness:.4 }));
  ball.mesh.castShadow = true; ball.mesh.visible = false;
  scene.add(ball.mesh);
}

export const syncBall = () => ball.mesh.position.copy(ball.pos);

/* ---- Fixed-step flight integration ------------------------------------
   stepBall advances the live flight in fixed BALLISTICS.STEP substeps —
   the SAME step predictFlight uses — so what actually flies always matches
   the outcome oracle regardless of the display's refresh rate. Event checks
   (catcher plane, ground bounce, wall) run per substep; cosmetics (trail,
   spin, sync) stay per frame. Rolling balls integrate continuously — the
   4.4 m/s^2 decay runs per substep until sp <= .4 promotes mode 'dead',
   so rollers coast THROUGH the infield to the fielders instead of
   freezing mid-dirt. */
const _acc = new THREE.Vector3();
let _accT = 0;

function integrateStep(h) {
  /* gravity (+ pitch break), plus quadratic drag on batted flight */
  _acc.set(0, -BALLISTICS.GRAVITY * ball.lift, 0).add(ball.breakA);
  if (ball.mode === 'batted')
    _acc.addScaledVector(ball.vel, -BALLISTICS.DRAG_K * ball.vel.length());
  ball.vel.addScaledVector(_acc, h);
  ball.pos.addScaledVector(ball.vel, h);

  /* Catcher-plane interception: NOTHING pitched blows past the receiver.
     The ball halts at the pocket line the instant it crosses it — takes and
     swinging strikes alike — so Game.js's receive choreography picks it up
     from a natural spot instead of a ball that already flew through the
     catcher (and the camera behind him). */
  if (ball.mode === 'pitched' && ball.pos.z > 1.05) {
    ball.vel.set(0, 0, 0); ball.breakA.set(0, 0, 0);
    ball.pos.z = 1.05;
    ball.mode = 'held';
  }

  /* Ground contact: restitution + dirt puff. Contact line = mesh radius
     (.055) so the shrunken ball rests ON the dirt — predictFlight's landing
     test MUST stay equal to this value or the outcome oracle desyncs. */
  if (ball.pos.y <= .055 && ball.vel.y < 0) {
    ball.pos.y = .055;
    const imp = -ball.vel.y;
    if (ball.mode === 'rolling') {
      /* An admitted roller re-touches every substep (~.16 imp from one STEP
         of gravity). Re-running hop restitution here would shed 22% of its
         ground speed PER SUBSTEP and re-freeze it inches past first touch,
         so rollers only get vel.y re-zeroed — the rolling block below owns
         their slowdown. */
      ball.vel.y = 0;
    } else {
      ball.vel.y *= -.46; ball.vel.x *= .78; ball.vel.z *= .78;
      if (ball.mode === 'batted') ball.bounced = true;   // touched dirt: a hop's descent is not a flyout
      if (ball.vel.y < 1.1) { ball.vel.y = 0; ball.mode = 'rolling'; }
    }
    if (imp > 1) {                       // real hop impacts only — an admitted roller
      FX.dust.spawnCluster(ball.pos, Math.min(12, 2 + imp * .8));   // re-contacts at ~.16 imp
      SND.thud(Math.min(1, imp / 14));   // per substep would spam dust + thuds
    }
  }

  if (ball.mode === 'rolling') {
    ball.pos.y = .055;
    const sp = ball.vel.length();
    if (sp > .4) ball.vel.addScaledVector(ball.vel.clone().normalize(), -4.4 * h);
    else { ball.vel.set(0,0,0); ball.mode = 'dead'; }
  }

  /* Outfield wall collision inside the fair arc (unless HR already confirmed) */
  const r = Math.hypot(ball.pos.x, ball.pos.z);
  if (r > FENCE_R - .4 && ball.pos.z < 0 && !G.hrConfirmed) {
    const fairArc = Math.abs(Math.atan2(ball.pos.x, -ball.pos.z)) < 45.2 * DEG;
    if (fairArc && ball.pos.y < FENCE_H) {
      const n = new THREE.Vector3(ball.pos.x, 0, ball.pos.z).normalize();
      const vn = ball.vel.dot(n);
      if (vn < 0) { ball.vel.addScaledVector(n, -1.55 * vn); ball.vel.multiplyScalar(.42); }
      const rr = (FENCE_R - .5) / r;
      ball.pos.x *= rr; ball.pos.z *= rr;
    }
  }
  if (r > FENCE_R + 26) { ball.mode = 'dead'; ball.mesh.visible = false; }
}

/** Integrate one frame of ball flight (pitched, batted, or rolling). */
export function stepBall(dt) {
  if (!ball.mesh.visible) return;
  if (ball.mode !== 'pitched' && ball.mode !== 'batted' &&
      ball.mode !== 'rolling') { _accT = 0; return; }   // rolling admitted: coast to 'dead' below

  _accT += dt;
  let steps = 0;
  while (_accT >= BALLISTICS.STEP && steps < 8 &&
         (ball.mode === 'pitched' || ball.mode === 'batted' ||
          ball.mode === 'rolling')) {
    integrateStep(BALLISTICS.STEP);
    _accT -= BALLISTICS.STEP;
    steps++;
  }
  if (_accT > BALLISTICS.STEP) _accT = 0;   // backlog after a stall — drop it

  ball.mesh.rotation.x += dt * 22; ball.mesh.rotation.y += dt * 9;

  if (ball.mode === 'batted') {
    ball.trailT -= 1;
    if (ball.trailT <= 0 && ball.vel.length() > 16) {
      ball.trailT = 2;
      FX.trail.spawn(ball.pos, { life:.3, size:.16, speed:.2, up:0, opacity:.5 });   // sized to ball footprint (was .32 at r=.11)
    }
  }
  syncBall();
}

/**
 * Forward-simulate a batted flight to predict landing & HR.
 * Returns {landT, landP, hr, carry}.
 */
export function predictFlight(p0, v0) {
  const p = p0.clone(), v = v0.clone(), lift = ball.lift;
  let t = 0, wallY = null, landT = null;
  const landP = new THREE.Vector3();
  for (let i = 0; i < 3000; i++) {
    const acc = new THREE.Vector3(0, -BALLISTICS.GRAVITY * lift, 0)
      .addScaledVector(v, -BALLISTICS.DRAG_K * v.length());
    const dt = BALLISTICS.STEP;
    v.addScaledVector(acc, dt); p.addScaledVector(v, dt); t += dt;
    const r = Math.hypot(p.x, p.z);
    if (!wallY && r >= FENCE_R - .4 && p.z < 0 && Math.abs(Math.atan2(p.x, -p.z)) < 45 * DEG) wallY = p.y;
    if (p.y <= .055 && v.y < 0) { landT = t; landP.copy(p); landP.y = 0; break; }   // == integrateStep contact line — keep in lockstep
  }
  if (landT === null) { landT = t; landP.copy(p); landP.y = 0; }
  return { landT, landP, hr:wallY != null && wallY >= FENCE_H + .1, carry:Math.hypot(landP.x, landP.z) };
}

export function hideBall() { ball.mode = 'hidden'; ball.mesh.visible = false; }
