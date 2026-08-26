/* =====================================================================
   CameraSystem.js — broadcast director. Shot grammar:
     plate    long-lens behind-plate wide (READY/PITCH, sway)
     intro    fresh-PA low close-up on the hitter (hard cut in, ~1.1s out)
     wind     windup tension push over the pitcher's shoulder
     chase    ball-flight tracker: leads the ball, widens on deep flies,
              drops low for grounders, biases toward the covering fielder
     resStd   result framing on camCtl.focus
     crane    deep-fly high outfield crane
     orbit    HR victory orbit — upgraded: low angle rising over the wall,
              look swings from the landing zone back to the trot
     trotWide HR trot crane — high first-base-side wide that frames the whole
              base circuit once the orbit completes; follows the trotting
              group (batter-runner + any forced runners) until the PA resets
     run      runner follow (followActor() or auto-armed on DEAD runners)
   Modes are HARD CUTS between shots (broadcast grammar); moves inside a
   shot are short eased dollies. Micro-sway lives on every live shot.
   Part of the Lincoln Red Gauntlet engine · js/core/
===================================================================== */
import * as THREE from 'three';
import { camera } from './SceneManager.js';
import { lerp, dampF, clamp, now } from '../utils/MathUtils.js';
import { ball } from '../physics/BallPhysics.js';
import { G } from './GameState.js';
import { FENCE_R } from './Constants.js';
import { runnerPool, hasRunningJob } from '../entities/Runners.js';
import { ACTORS } from '../entities/PlayerFactory.js';
import { replayActive } from './ReplaySystem.js';

export const camCtl = {
  mode:'bat',
  focus:new THREE.Vector3(0, 0, -30),
  look:new THREE.Vector3(0, 1.4, -18.4),
  suggest:'',                       // director hint for main.js: 'fly' on deep contact
  /* Debug override (window.__GB.setCam): when non-null, updateCamera parks
     the lens here instead of directing — lets the harness stage aerials and
     inspection angles. Null (or setCam() with no args) resumes the director. */
  manual:null
};

/* ---- Scratch — reused every frame, zero allocation ------------------- */
const _d = new THREE.Vector3(), _dl = new THREE.Vector3(), _flat = new THREE.Vector3();
const _t1 = new THREE.Vector3(), _t2 = new THREE.Vector3();
const _tc = new THREE.Vector3(), _tp = new THREE.Vector3();   // trot group centroid / trailer
let trotCnt = 0;                        // live trotters found by the last gatherTrot()

/* ---- Director state -------------------------------------------------- */
let pState  = G.state;   // previous game state (transition edges)
let shot    = 'plate';   // internal shot key — changes are HARD CUTS
let windT   = 0;         // 0..1 windup-cut blend
let trkD    = 7.5;       // damped track follow distance
let trkH    = 3.4;       // damped track height offset
let trkInit = true;      // snap trackers on chase entry (no stale glide)
let roll    = 0;         // tracker roll, rad (±2° max)
let deepFly = false;     // last batted ball was a deep fly
let wallJob = false;     // batted ball classified HR → frame the wall
let exitAz  = 0;         // exit azimuth of the last fair batted ball
let fovKick = 0;         // 1→0 contact punch-in envelope (~.25s)
let introT   = 0;        // batter-intro cut blend, 1→0 over ~1.15s
let introArm = true;     // fires once on the first READY after load
let hrOrb    = false;    // HR orbit engaged on a confirmed homer
let hrT0     = -1;       // hrConfirmed timestamp — drives the rising orbit
let wideLock = false;    // trot crane latched for the rest of the DEAD window
let vigDone  = false;    // vignette overlay injected once

/* Orbit rise duration — the victory lap hands off to the trot crane after
   this many seconds (k saturates); kept in one place for both users. */
const ORBIT_SPAN = 4.2;

/* Runner follow — manual via followActor() or auto-armed on DEAD.
   kind: 0 idle · 1 auto (yields to READY/WINDUP plate work) · 2 manual */
const fol = { a:null, until:0, used:false, side:1, kind:0 };

/** Put the lens on an actor (base-runner theatre). Holds `hold` seconds or
    until the actor vanishes / a batted ball goes live. followActor(null)
    releases. Manual follows outrank the plate shots. The flanking side is
    picked once, toward wherever the lens already is. */
export function followActor(actor, hold = 1.8) {
  fol.a = actor || null;
  fol.until = actor ? now() + hold : 0;
  fol.used = true;
  fol.kind = actor ? 2 : 0;
  if (actor)
    fol.side = actor.root.position.x > camera.position.x ? -1 : 1;
}

/** Debug probe: which shot the director is actually rendering. */
export function directorShot() { return shot; }

/* ---- HR trot group census ---------------------------------------------
   Who is actually trotting during a confirmed-homer DEAD window:
     • pool pills mid-leg (inherited runners on clone legs),
     • any ACTOR whose body is owned by a runner job — the batter-runner's
       circuit and lent bench rigs alike (Runners.hasRunningJob). Fielders
       that merely play a 'jog' ANIMATION while drifting back to their spots
       own no runner job, so they never pollute the group.
   Fills _tc with the group centroid and _tp with the trailer (trotter
   closest to home — the tightest framing constraint), sets trotCnt.
   Allocation-free: scratch vectors + scalars only. */
function gatherTrot() {
  trotCnt = 0;
  _tc.set(0, 0, 0);
  let best2 = Infinity;
  const batSide = G.half === 'top' ? 'opp' : 'lin';
  for (let i = 0; i < runnerPool.length; i++) {
    const r = runnerPool[i];
    if (!r.active || !r.path || !r.root.visible || r.side !== batSide) continue;
    const p = r.root.position;
    _tc.x += p.x; _tc.z += p.z; trotCnt++;
    const d2 = p.x * p.x + p.z * p.z;
    if (d2 < best2) { best2 = d2; _tp.copy(p); }
  }
  for (let i = 0; i < ACTORS.length; i++) {
    const a = ACTORS[i];
    if (!a.root.visible || !a.animState) continue;
    const an = a.animState.name;
    if ((an !== 'run' && an !== 'jog') || !hasRunningJob(a)) continue;
    const p = a.root.position;
    _tc.x += p.x; _tc.z += p.z; trotCnt++;
    const d2 = p.x * p.x + p.z * p.z;
    if (d2 < best2) { best2 = d2; _tp.copy(p); }
  }
  if (trotCnt) { _tc.x /= trotCnt; _tc.z /= trotCnt; }
}

/* Spring-damper contact shake (positional, ~.4s ring-down) */
const SH_P = new THREE.Vector3(), SH_V = new THREE.Vector3();
const SH_K = 170, SH_C = 8.4;      // stiffness / damping

/** Impact shake + FOV punch trigger. Safe to call anytime. */
export function punchCam(intensity) {
  const p = +intensity || 0;
  if (p <= 0) return;
  const a = Math.min(p, 3), ang = now() * 7.31;
  SH_V.x += Math.cos(ang) * a * 1.8;
  SH_V.z += Math.sin(ang * 1.37) * a * 1.8;
  SH_V.y += a * .9;
  fovKick = 1;
}

/* Tiny always-on vignette — pure DOM/CSS in our own layer, sits under the
   HUD (z 12) and gently corners every shot like a broadcast lens. */
function ensureVignette() {
  if (vigDone || !document.body) return;
  vigDone = true;
  if (document.getElementById('cam-vignette')) return;
  const st = document.createElement('style');
  st.textContent = '#cam-vignette{position:fixed;inset:0;z-index:12;pointer-events:none;'
    + 'background:radial-gradient(ellipse at 50% 46%, transparent 58%, rgba(4,6,10,.34) 100%)}';
  document.head.appendChild(st);
  const v = document.createElement('div');
  v.id = 'cam-vignette';
  document.body.appendChild(v);
}

/* Noise-driven handheld micro-sway (cheap 3-sine pseudo-noise), per-shot amp */
function swayN(t, s) {
  return (Math.sin(t * 1.31 + s) + Math.sin(t * 2.17 + s * 1.7) * .6
        + Math.sin(t * .53 + s * .31) * .8) * .38;
}

/** Resolve which shot renders this frame — internal theatre outranks the
    camCtl.mode main.js feeds us; that contract stays untouched. */
function resolveShot() {
  const hold = fol.a && now() < fol.until && fol.a.root.visible && G.state !== 'LIVE';
  /* Auto follows stand down once a confirmed homer owns result mode — the
     orbit→trotWide sequence IS the runner theatre then (manual follows,
     kind 2, still outrank it). Without this, the pre-replay closeup re-cut
     mid-sequence and its expiry was what left the old orbit staring at the
     wall: its look-swing target died with the hold. */
  if (hold && (fol.kind === 2 ||
      (!(hrOrb && camCtl.mode === 'result') &&
       G.state !== 'READY' && G.state !== 'WINDUP'))) {
    return G.hrConfirmed ? 'trot' : 'run';
  }
  if (fol.a) { fol.a = null; fol.kind = 0; }     // hold expired / actor gone
  if (camCtl.mode === 'track') return 'chase';
  if (camCtl.mode === 'result') {
    if (hrOrb) {
      /* Victory lap first, THEN pull back for the whole circuit: once the
         orbit has finished its rise (k saturated) and runners are genuinely
         trotting, latch the wide crane for the REST of this DEAD window —
         including the tail after the last runner crosses (no falling back
         to a saturated stare). The next READY/WINDUP edge clears the latch. */
      if (wideLock) return 'trotWide';
      if (hrT0 >= 0 && now() - hrT0 >= ORBIT_SPAN + .15 && trotCnt > 0) {
        wideLock = true;
        return 'trotWide';
      }
      return 'orbit';
    }
    return deepFly ? 'crane' : 'resStd';
  }
  return 'plate';                                // bat family (intro/wind blend inside)
}

/* Auto-arm a runner follow once per play: the longest active path wins
   (the batter-runner on hits, the trotter on HRs, the jogger on walks).
   Deferred while an instant replay owns the lens. */
function armRunnerFollow() {
  if (fol.used || fol.a || replayActive()) return;
  let best = null, bl = 1;
  for (let i = 0; i < runnerPool.length; i++) {
    const r = runnerPool[i];
    if (r.active && r.path && r.path.length > bl && r.root.visible) { best = r; bl = r.path.length; }
  }
  if (!best) return;
  fol.used = true;
  followActor(best, G.hrConfirmed ? 2.4 : 1.7);
  fol.kind = 1;                        // auto: yields to fresh-PA plate work
}

export function updateCamera(dt) {
  dt = Math.min(dt || 0, .05);
  ensureVignette();
  const t = now();

  /* Debug override — hold the staged pose, direct nothing (see camCtl.manual) */
  if (camCtl.manual) {
    camera.position.copy(camCtl.manual.pos);
    camera.lookAt(camCtl.manual.look);
    return;
  }

  /* State edges: sample batted-ball flight at LIVE start, disarm between PAs */
  if (G.state !== pState) {
    if (G.state === 'LIVE') {
      deepFly = ball.vel.y > 14;                  // steep carry ⇒ fly-cam candidate
      wallJob = !!(G.result && G.result.type === 'HR');
      exitAz  = Math.atan2(ball.vel.x, -ball.vel.z);
      trkInit = true;
      camCtl.suggest = deepFly ? 'fly' : '';
    } else if (G.state === 'READY' || G.state === 'WINDUP') {
      deepFly = false; wallJob = false; camCtl.suggest = '';
      hrOrb = false; hrT0 = -1;                   // orbit is a per-play effect
      wideLock = false;                           // …so is the trot crane
      fol.used = false;                           // new play → follow may re-arm
      /* Fresh PA: 0-0 READY edge ⇒ new hitter at the plate
         (between-pitch READY re-entry carries a count — no recut) */
      if (G.state === 'READY' && G.balls === 0 && G.strikes === 0) introT = 1;
    }
    pState = G.state;
  }

  /* HR orbit engages on the DEAD entry of a confirmed homer */
  if (G.state === 'DEAD' && G.result && G.result.type === 'HR') hrOrb = true;
  else if (G.result && G.result.type !== 'HR') hrOrb = false;

  /* First READY after module load counts as an entry (no edge seen then) */
  if (introArm && G.state === 'READY') { introT = 1; introArm = false; }

  /* Windup cut: ease in over ~.5s, snap-blend back on release */
  if (G.state === 'WINDUP') windT += (1 - windT) * dampF(6, dt);
  else                      windT -= windT * dampF(14, dt);
  if (windT < .001) windT = 0;
  introT -= introT * dampF(6, dt);          // exp(-6·1.15)≈.001 ⇒ ~1.15s release
  if (introT < .001) introT = 0;

  if (G.state === 'DEAD') armRunnerFollow();      // runner theatre (replay-deferred)

  /* HR trot census — only worth scanning inside a confirmed-homer DEAD
     window; every other frame this is one branch. Feeds resolveShot's
     orbit→trotWide latch, the orbit's late look-swing and the crane. */
  trotCnt = 0;
  if (G.state === 'DEAD' && G.result && G.result.type === 'HR') gatherTrot();

  const ns = resolveShot();
  const cut = ns !== shot;                        // shot change ⇒ HARD CUT
  shot = ns;

  let posK = 2.2, fovK = 3, fov = 48;

  /* =========================== PLATE FAMILY ========================== */
  if (shot === 'plate') {
    const sw = swayN(t, 2.1);
    _d.set(.55 + sw * .3, 2.62 + Math.sin(t * .34) * .08 + swayN(t, 5.7) * .05, 7.6);
    _dl.set(sw * .12, 1.3, -18.4);
    fov = 48;
    const iw = introT > 0 ? introT * introT * (3 - 2 * introT) : 0;
    if (iw > 0) {                                 // intro cut: low side-on close-up
      _d.x = lerp(_d.x, -2.6, iw);                //   batter box at (-0.97, 0, .1)
      _d.y = lerp(_d.y, 1.15, iw);
      _d.z = lerp(_d.z, 2.6, iw);
      _dl.x = lerp(_dl.x, -.85, iw);
      _dl.y = lerp(_dl.y, 1.25, iw);
      _dl.z = lerp(_dl.z, .15, iw);
      fov = lerp(fov, 38, iw);                    //   long lens on the face
    }
    posK = 2.2 + 5 * windT + 6 * iw;              // intro lands fast, reads as a cut
    /* windup blended last ⇒ takes over progressively as the intro fades */
    if (windT > 0) {                              // low & tight toward the mound,
      _d.x = lerp(_d.x, .35 + sw * .12, windT);   // creeping in with the motion
      _d.y = lerp(_d.y, 1.15, windT);
      _d.z = lerp(_d.z, lerp(5.3, 4.85, windT), windT);
      _dl.x = lerp(_dl.x, .35, windT);
      _dl.y = lerp(_dl.y, 1.9, windT);
      _dl.z = lerp(_dl.z, -17.9, windT);
      fov = lerp(fov, 43, windT);
    }

  /* ========================= BALL-FLIGHT CHASE ======================== */
  } else if (shot === 'chase') {
    _flat.copy(ball.vel); _flat.y = 0;
    if (_flat.lengthSq() < .01) _flat.set(0, 0, -1);
    _flat.normalize();
    /* Smart framing: widen/rise with exit speed & launch; line drives stay tight */
    const spd = ball.vel.length(), vy = Math.max(ball.vel.y, 0);
    let dT = Math.min(7.5 + Math.max(spd - 24, 0) * .1 + vy * .24, 15.5);
    let hT = 3.4 + Math.min(ball.pos.y * .05, 2) + Math.min(vy * .13, 2.6);
    /* Wall job (confirmed HR): pull wide & high early so ball AND wall share
       the frame on the way out */
    if (wallJob) { dT = Math.max(dT, 13.5); hT = Math.max(hT, 5.4); }
    /* Grounder chase: low & flattening biases the TARGETS toward
       ground-ball-cam framing; damped trkD/trkH do all the easing */
    if (ball.pos.y < 1.7 && ball.vel.y < 2) {
      dT = lerp(dT, 5.2, .7);
      hT = lerp(hT, 1.2, .75);
    }
    if (trkInit) { trkD = dT; trkH = hT; trkInit = false; }   // cut in framed right
    trkD += (dT - trkD) * dampF(2.5, dt);
    trkH += (hT - trkH) * dampF(3, dt);
    _d.copy(ball.pos).addScaledVector(_flat, -trkD);
    _d.y = Math.max(ball.pos.y + trkH, 1.4);
    /* Lead the ball slightly; on a covered fly bias the look so ball AND
       fielder share the frame as the descent closes */
    _dl.copy(ball.pos).addScaledVector(ball.vel, .07);
    const fl = G.result && G.result.fielder;
    if (fl && fl.root && ball.vel.y < 0) {
      const fd = Math.hypot(fl.root.position.x - ball.pos.x, fl.root.position.z - ball.pos.z);
      if (fd < 14) {
        _t1.copy(fl.root.position); _t1.y = 1.4;
        _dl.lerp(_t1, clamp(1 - fd / 14, 0, 1) * .45);
      }
    } else if (wallJob) {                         // frame the wall on HR departures
      _t1.set(Math.sin(exitAz) * (FENCE_R - 6), 3.2, -Math.cos(exitAz) * (FENCE_R - 6));
      _dl.lerp(_t1, clamp((ball.pos.y - 6) * .08, 0, .4));
    }
    /* Subtle roll from lateral break (hook/slice), hard-clamped ±2° */
    const rl  = Math.hypot(ball.pos.x, ball.pos.z) || 1;
    const lat = (ball.vel.z * ball.pos.x - ball.vel.x * ball.pos.z) / rl;
    roll += (clamp(-lat * .0032, -.0349, .0349) - roll) * dampF(4, dt);
    fov = wallJob ? 54 : 58;
    posK = 3.4;

  /* ============================== RESULT ============================== */
  } else if (shot === 'resStd' || shot === 'crane') {
    const f = camCtl.focus;
    _flat.set(f.x, 0, f.z - 20);
    if (_flat.lengthSq() < 1) _flat.set(0, 0, 1);
    _flat.normalize();
    if (shot === 'crane') {                       // deep ball: high outfield crane, looking back
      _d.copy(f).addScaledVector(_flat, 26);
      _d.y = f.y + 10 + Math.sin(t * .4) * .6;
      _dl.copy(f); _dl.y += 1.5;
      fov = 53;
      posK = 1.4;
    } else {
      _d.copy(f).addScaledVector(_flat, 9);
      _d.y = f.y + 3.6;
      _dl.copy(f); _dl.y += .8;
      fov = 50;
    }

  /* ====================== HR ORBIT — RISING OVER THE WALL ============= */
  } else if (shot === 'orbit') {
    if (hrT0 < 0) hrT0 = t;
    const k = clamp((t - hrT0) / ORBIT_SPAN, 0, 1);  // 0→1 over the victory lap
    /* Cinematic: start LOW inside the park on the landing zone, spiral up
       and back as the look swings from the wall toward the trotting group.
       The swing targets the gathered GROUP centroid — not the old follow
       handle, which always expired during the instant replay and left the
       saturated orbit staring at the wall for the rest of the trot. */
    const az = exitAz + k * .55;
    const cx = Math.sin(az) * 62, cz = -Math.cos(az) * 62;        // orbit centre
    const px = Math.cos(az), pz = Math.sin(az);                   // perp in plane
    _d.set(cx + px * lerp(-16, -23, k), 3.6 + k * k * 8.5, cz + pz * lerp(-16, -23, k));
    _t1.set(Math.sin(exitAz) * (FENCE_R - 4), 3.4, -Math.cos(exitAz) * (FENCE_R - 4));
    if (trotCnt > 0) {                            // swing to the trot group late
      _t2.copy(_tc); _t2.y = 1.2;
      _t1.lerp(_t2, k * k * .8);
    } else if (fol.a && fol.a.root.visible) {     // legacy fallback: manual follow
      _t2.copy(fol.a.root.position); _t2.y = 1.2;
      _t1.lerp(_t2, k * k * .8);
    }
    _dl.copy(_t1);
    fov = lerp(44, 52, k);
    posK = 2.6;

  /* ========================= HR TROT CRANE ========================== */
  } else if (shot === 'trotWide') {
    /* High first-base-side wide: the lens parks in short right field where
       the whole base circuit fits one frame at fov 48 — worst-case framing
       angle from this anchor is a home-crosser ~18° below axis against a
       ±24° vertical half-angle. Tracks the group centroid (gentle drift,
       never a chase) so batter-runner AND every forced runner stay framed
       from first step to plate touch; holds through the dugout jog-off and
       any post-trot DEAD tail until the PA resets to READY/WINDUP. */
    _d.set(26 + _tc.x * .06, 10.5, 10 - _tc.z * .04);
    _dl.copy(_tc); _dl.y = 1.3;
    fov = 48;
    posK = 1.2;                                   // unhurried barge onto the mark

  /* =========================== RUNNER FOLLOW ========================== */
  } else { // 'run' | 'trot'
    const a = fol.a, low = shot === 'trot';
    _t1.copy(a.root.position); _t1.y = 0;
    /* Direction of travel from the runner's facing; lead ahead of the chest */
    const fx = Math.sin(a.root.rotation.y), fz = Math.cos(a.root.rotation.y);
    const side = fol.side;                                        // picked once at cut-in
    _d.copy(_t1).addScaledVector(_t2.set(fx, 0, fz), 2.6)          // lead
      .addScaledVector(_t2.set(fz * side, 0, -fx * side), 4.2);    // flank
    _d.y = low ? 1.15 : 1.5;
    _dl.set(_t1.x + fx * 1.1, low ? 1.0 : 1.15, _t1.z + fz * 1.1);
    fov = low ? 40 : 44;                                          // long lens
    posK = 4.5;                                                   // confident dolly
  }

  /* ===================== COMMIT (cut or blend) ======================== */
  if (cut) {                                      // broadcast hard cut
    camera.position.copy(_d);
    camCtl.look.copy(_dl);
    camera.fov = fov;
    roll = 0;
  } else {
    /* FOV: mode ease + quick punch-in while a contact kick is live */
    if (fovKick > 0) {
      fov -= 4 * fovKick;
      fovK = 12;
      fovKick = Math.max(0, fovKick - dt / .25);
    }
    camera.fov = lerp(camera.fov, fov, dampF(fovK, dt));
    camera.position.lerp(_d, dampF(posK, dt));
  }

  /* Contact shake: semi-implicit spring integration, sleeps when settled */
  SH_V.x += (-SH_K * SH_P.x - SH_C * SH_V.x) * dt;
  SH_V.y += (-SH_K * SH_P.y - SH_C * SH_V.y) * dt;
  SH_V.z += (-SH_K * SH_P.z - SH_C * SH_V.z) * dt;
  SH_P.x += SH_V.x * dt; SH_P.y += SH_V.y * dt; SH_P.z += SH_V.z * dt;
  if (SH_P.lengthSq() < 1e-6 && SH_V.lengthSq() < 1e-4) SH_P.set(0, 0, 0), SH_V.set(0, 0, 0);
  camera.position.add(SH_P);

  if (!cut) camCtl.look.lerp(_dl, dampF(4, dt));
  camera.lookAt(camCtl.look);
  if (shot !== 'chase') roll -= roll * dampF(5, dt);   // settle roll outside tracker
  if (roll) camera.rotateZ(roll);
  camera.updateProjectionMatrix();
}
