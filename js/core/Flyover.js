/* =====================================================================
   Flyover.js — opening cinematic: a ~13 s aerial tour of the park that
   plays once at boot, then hands the lens back to CameraSystem untouched.
   Part of the Lincoln Red Gauntlet engine · js/core/

   CONTRACT (why this can sit beside the broadcast director safely):
     • main.js calls updateFlyover() AFTER updateCamera()/updateReplay()
       in the tick, so while we are airborne our pose is the LAST write
       of the frame. CameraSystem keeps running underneath us the whole
       time — its shot edges, damped trackers and camCtl.look stay live —
       which is precisely what makes the handoff seamless: on release its
       next damped lerp starts FROM wherever we left the lens (position
       glides; a shot change is a legal broadcast hard cut). We never
       mutate camCtl or any CameraSystem internal — only the camera's
       position / quaternion / fov, and only while active.
     • ALWAYS skippable: one keydown + one pointerdown listener on window,
       bound here in init and unbound on finish. A skip mid-flight enters
       a short RETURN ease toward the director's rest pose instead of
       releasing instantly, because updateCamera aims via a bare
       camera.lookAt — position would glide but the ORIENTATION would
       hard-snap from a high look-down to plate level in one frame.
       Ending on the rest pose makes either exit read as one continuous
       move (a natural finish already ends exactly there, so it just
       releases).
     • COMPLETION SIGNAL: opts.onDone (passed once at init) fires exactly
       when the lens is released — phase back to 0, camera parked on the
       rest pose — whether the reel ran its course or the player skipped
       it (a skip fast-forwards through the same short return ease to the
       same pose). main.js gates the FIRST at-bat on this signal, so no
       pitch is thrown while we are still airborne.
     • Deterministic: fixed keyframes, zero Math.random; the entire
       vocabulary is Catmull-Rom splines + smoothstep easing. Frame-rate
       independent — the path is a pure function of elapsed seconds.
     • Zero per-frame allocation: every vector lives at module scope and
       curve samples write into scratch via getPointAt(u, target). The
       curves' arc-length caches are warmed once in initFlyover so even
       the first airborne frame allocates nothing.

   FLIGHT PLAN (home plate at the origin, centre field toward −Z):
     FOD REEL (13 s — the original shared path, untouched):
     A · grand tour (8.4 s)  P0 high behind/above home plate, looking
         down the pitcher–CF axis → dive forward over the mound → bank
         right and sweep low across RF foul ground inside the bowl →
         arrive at P3, a hover DEEP in centre field OUTSIDE the fence
         (r ≈ 104): the whole V-bowl, apex stand and skyline in frame.
     B · settle (4.6 s)      swooping descent from the hover back over
         the outfield and infield, easing onto the gameplay plate
         framing (CameraSystem 'plate' shot base pose / fov 48).
     ORACLE REEL (17 s — gated on opts.park in initFlyover): same three
     opening beats, but instead of tucking into CF the tour climbs OUT
     of the bowl past right field and gives McCovey Cove its own beat —
     Skyline.js lays the bay plane from x 114 out to 674 with the
     suspension bridge at x ≈ 372 — then dives home.
     A · grand tour + cove run (11 s)  …RF sweep → climb through the RF
         light-tower gap (towers at (±58,-72)/(±84,-18), lamp heads top
         y ≈ 28.7) → glide over the water to a hover beyond the bowl
         facade (r ≈ 111, tops y 7.8) at Q4 (122, 20, −28), gaze locked
         across the bay at the bridge/skyline bearing (+x).
     B · settle (6 s)        diving descent from the cove back across
         right field onto the same plate framing — the release pose is
         IDENTICAL for both reels, so the handoff contract holds.
===================================================================== */
import * as THREE from 'three';
import { clamp, lerp, dampF } from '../utils/MathUtils.js';
import { VSTAND } from './Constants.js';

/* ---- Tuning ---------------------------------------------------------- */
const DUR_A   = 8.4;     // phase A — grand tour to the CF reveal hover (s)
const DUR_B   = 4.6;     // phase B — settle dive into the plate framing (s)
const TOTAL   = DUR_A + DUR_B;
const DUR_AO  = 11.0;    // oracle phase A — grand tour + cove/bay run (s)
const DUR_BO  = 6.0;     // oracle phase B — settle dive home from the cove (s)
const TOTAL_O = DUR_AO + DUR_BO;   // 17 s — boot-flow ceiling for the bay beat
const HANDOFF = .85;     // post-skip return-ease duration (s)
const FOV_EXTRA = 7;     // aerial wide-start: fov sweeps FOV_REST+7 → FOV_REST
const BANK_K  = .18;     // turn-rate → roll gain (rad / (rad·s⁻¹))
const ROLL_MAX = .056;   // hard roll ceiling ≈ 3.2° — flavour, not a stunt

/* Director rest pose — MUST stay numerically identical to CameraSystem's
   'plate' base framing (its _d/_dl seeds and fov) so the release frame is
   invisible: the director's damped lerp then only has sway-scale error
   (±.3 m) left to absorb. */
const REST_POS  = new THREE.Vector3(.55, 2.62, 7.6);
const REST_LOOK = new THREE.Vector3(0, 1.3, -18.4);
const REST_FOV  = 48;

/* ---- Keyframes ---------------------------------------------------------
   Altitude discipline: every cruise key clears VSTAND.top1 (7.6 m, the
   arm-tail roofline — Constants.js) by ≥ 6 m, which also clears the fod
   corn ring (9.5 m tops, SceneManager layer table) and its bleachers.
   P2 hugs the 1B-line arm's FIELD side (inner face ≈ x 37 at z −30) and
   P3 sits beyond the bowl end-cap ray (r 97.5) at CF azimuth — neither
   keyframe shares airspace with the structure. */
const K_POS_A = [
  new THREE.Vector3(0, 64, 58),      // P0 high behind/above home — establishing
  new THREE.Vector3(7, 33, -10),     // P1 dive over the mound, starting the bank
  new THREE.Vector3(39, 20, -57),    // P2 low sweep, RF foul ground inside the bowl
  new THREE.Vector3(17, 27, -103)    // P3 deep-CF hover outside the fence — reveal
];
const K_LOOK_A = [
  new THREE.Vector3(0, 1, -24),      // straight down the pitcher–CF axis
  new THREE.Vector3(14, 0, -36),     // lead the bank toward the 1B-side bowl
  new THREE.Vector3(-20, 1, -10),    // swing the gaze across to the 3B arm/backstop
  new THREE.Vector3(0, 2, 4)         // take the whole park in, plate in fore
];
const K_POS_B = [
  K_POS_A[3],                        // B lifts off exactly where A ended
  new THREE.Vector3(6, 14, -55),     // mid-descent bulge over CF, shedding height
  REST_POS                           // land on the gameplay framing
];
const K_LOOK_B = [
  K_LOOK_A[3],
  new THREE.Vector3(0, 1.6, -8),     // gaze swings out to the mound as we drop
  REST_LOOK                          // …and locks onto the plate-shot target
];

/* ---- ORACLE bay-reel keyframes (gated in initFlyover on opts.park) -----
   Same discipline as above; every cruise key clears VSTAND.top1 + 6.
   Geography it threads (all coords audited against SceneManager/Skyline):
   Q3 crosses the RF wall corridor BETWEEN the light towers at (58,-72)
   and (84,-18) — closest abeam pass ≈ 21 m from either lamp head while
   ~3-6 m under it — and Q4 sits past the OF-bowl facade (r ≈ 111, top
   y 7.8) over the bay proper (water plane begins x > 114), framed on
   the bridge (x ≈ 372, deck y 26) with the cove boats ahead. Look keys
   let the gaze LEAD the flight: the pan out to the water completes as
   the camera exits the bowl, so the whole final glide + hover reads as
   one settled bridge-framing beat. */
const K_POS_AO = [
  new THREE.Vector3(0, 64, 58),      // Q0 high behind/above home — establishing
  new THREE.Vector3(7, 33, -10),     // Q1 dive over the mound, starting the bank
  new THREE.Vector3(39, 20, -57),    // Q2 low sweep, RF foul ground inside the bowl
  new THREE.Vector3(74, 25, -44),    // Q3 climb-out through the RF light-tower gap
  new THREE.Vector3(122, 20, -28)    // Q4 cove hover over the water — the bay reveal
];
const K_LOOK_AO = [
  new THREE.Vector3(0, 1, -24),      // straight down the pitcher–CF axis
  new THREE.Vector3(14, 0, -36),     // lead the bank toward the 1B-side bowl
  new THREE.Vector3(-20, 1, -10),    // swing the gaze across to the 3B arm/backstop
  new THREE.Vector3(170, 4, -22),    // pan eases out across the cove during the exit
  new THREE.Vector3(330, 14, 10)     // locked: bridge + downtown haze across the bay
];
const K_POS_BO = [
  K_POS_AO[4],                       // B lifts off exactly where A ended
  new THREE.Vector3(48, 13.5, -42),  // mid-descent bulge back over RF, shedding height
  REST_POS                           // land on the SAME gameplay framing
];
const K_LOOK_BO = [
  K_LOOK_AO[4],
  new THREE.Vector3(0, 1.6, -8),     // gaze swings back to the mound as we drop
  REST_LOOK                          // …and locks onto the plate-shot target
];

/* Curves are built ONCE at module eval (static data) and sampled with
   getPointAt — arc-length parameterisation, so speed depends only on the
   global ease, never on knot spacing. 'centripetal' avoids cusps/overshoot
   between unevenly spaced keys. */
const posA  = new THREE.CatmullRomCurve3(K_POS_A,  false, 'centripetal');
const lookA = new THREE.CatmullRomCurve3(K_LOOK_A, false, 'centripetal');
const posB  = new THREE.CatmullRomCurve3(K_POS_B,  false, 'centripetal');
const lookB = new THREE.CatmullRomCurve3(K_LOOK_B, false, 'centripetal');
const posAO  = new THREE.CatmullRomCurve3(K_POS_AO,  false, 'centripetal');
const lookAO = new THREE.CatmullRomCurve3(K_LOOK_AO, false, 'centripetal');
const posBO  = new THREE.CatmullRomCurve3(K_POS_BO,  false, 'centripetal');
const lookBO = new THREE.CatmullRomCurve3(K_LOOK_BO, false, 'centripetal');

/* ---- Module state ------------------------------------------------------
   phase: 0 idle · 1 grand tour · 2 settle · 3 return (post-skip ease)     */
let cam = null;
let durA = DUR_A;        // ACTIVE reel timing — stock unless the oracle bay
let durB = DUR_B;        // reel is gated in by opts.park (see initFlyover)
let totCur = TOTAL;
let curPA = posA, curLA = lookA;     // active curves — swapped with the timing
let curPB = posB, curLB = lookB;     // so the frame loop stays branch-free
let phase = 0;
let t  = 0;              // phase-local clock (s)
let gT = 0;              // whole-reel clock — drives the fov sweep only
let lastNow = 0;         // performance.now stamp for the no-dt fallback clock
let roll = 0;            // current banking roll (rad)
let pdx = 0, pdz = 0;    // previous frame's travel heading (xz) — banking input
let prevValid = false;
let bound = false;
let doneCb = null;       // one-shot completion signal — fired by release()

/* Scratch — reused every frame, zero allocation in the hot path */
const _pos = new THREE.Vector3(), _look = new THREE.Vector3();
const _skPos = new THREE.Vector3(), _skLook = new THREE.Vector3();  // skip snapshot
let skRoll = 0, skFov = REST_FOV;

const smooth = x => x * x * (3 - 2 * x);   // matches CameraSystem's ease idiom

/* Dev-time clearance audit — fails loudly in console if a key edit ever
   drops a cruise altitude into the structure. The FINAL keys are exempt:
   they land inside the apex-ring radius at the gameplay plate spot. */
for (let i = 0; i < K_POS_A.length - 1; i++)
  console.assert(K_POS_A[i].y > VSTAND.top1 + 6, '[flyover] tour key', i, 'below stand tops');
console.assert(K_POS_B[1].y > VSTAND.top1 + 4, '[flyover] descent key below stand tops');
for (let i = 0; i < K_POS_AO.length - 1; i++)
  console.assert(K_POS_AO[i].y > VSTAND.top1 + 6, '[flyover] oracle tour key', i, 'below stand tops');
console.assert(K_POS_BO[1].y > VSTAND.top1 + 4, '[flyover] oracle descent key below stand tops');

/* ---- Input (module-owned, per contract) -------------------------------- */
function onSkipInput() { skipFlyover(); }

function bindInput() {
  if (bound) return;
  bound = true;
  addEventListener('keydown', onSkipInput);
  addEventListener('pointerdown', onSkipInput);
}
function unbindInput() {
  if (!bound) return;
  bound = false;
  removeEventListener('keydown', onSkipInput);
  removeEventListener('pointerdown', onSkipInput);
}

/** Give the lens back for good. Idempotent; touches nothing on the camera —
    CameraSystem simply owns the next frame from wherever we left it. Fires
    the completion signal exactly here: the camera IS parked on the director's
    rest pose at this instant, so gameplay may begin on the next frame. */
function release() {
  phase = 0;
  roll = 0; prevValid = false; pdx = pdz = 0;
  unbindInput();
  const cb = doneCb; doneCb = null;                  // one shot — never re-fires
  if (cb) { try { cb(); } catch (e) { console.error('[flyover] onDone:', e); } }
}

/** Commit a pose to the camera. The ONLY place we touch the lens. */
function commit() {
  cam.position.copy(_pos);
  cam.lookAt(_look);
  if (roll) cam.rotateZ(roll);                    // banking, wings-level at rest
  const g = clamp(gT / totCur, 0, 1);
  cam.fov = REST_FOV + FOV_EXTRA * Math.pow(1 - g, 1.35);   // slow push to tele
  cam.updateProjectionMatrix();
}

/* Banking: estimate the signed turn rate from the frame-to-frame travel
   heading — (prev × curr).y = sin of the heading change, +left / −right —
   and roll a few degrees INTO the turn like an aircraft. Sign chosen so
   the horizon dips toward the inside of the turn; ROLL_MAX keeps it a
   suggestion even at full saturation. px/pz are the previous position's
   xz components (scalars — no vector bookkeeping needed). */
function bankStep(px, pz, nx, nz, step, targetScale) {
  let target = 0;
  const pl = Math.hypot(px, pz), nl = Math.hypot(nx, nz);
  if (prevValid && step > 1e-4 && pl > 1e-4 && nl > 1e-4) {
    const sinTurn = clamp((pz * nx - px * nz) / (pl * nl), -1, 1);
    target = clamp(Math.asin(sinTurn) / step * BANK_K * targetScale, -ROLL_MAX, ROLL_MAX);
  }
  roll += (target - roll) * dampF(5, step);
}

/* ---- Public API -------------------------------------------------------- */

/** Arm the reel. Call once the world is assembled (main.js boot tail, after
    the loading overlay hides). `opts.park` picks the choreography: oracle
    flies the bay-showcase reel (K_*_AO / K_*_BO above); fod — or any caller
    that omits park — keeps the original shared path untouched. `opts.onDone`
    fires ONCE when the lens is released (natural finish OR skip — both land
    on the rest pose); main.js gates the first at-bat on it. Re-invoking
    restarts the flight from P0/Q0 and re-arms. */
export function initFlyover(opts) {
  cam = (opts && opts.camera) || null;
  if (!cam) return;
  doneCb = (opts && opts.onDone) || null;
  const bay = (opts && opts.park) === 'oracle';
  durA = bay ? DUR_AO : DUR_A;
  durB = bay ? DUR_BO : DUR_B;
  totCur = durA + durB;
  curPA = bay ? posAO : posA; curLA = bay ? lookAO : lookA;
  curPB = bay ? posBO : posB; curLB = bay ? lookBO : lookB;
  posA.getLength(); lookA.getLength();               // warm arc-length caches
  posB.getLength(); lookB.getLength();               // OUTSIDE the frame loop
  posAO.getLength(); lookAO.getLength();             // both reels warmed — boot-
  posBO.getLength(); lookBO.getLength();             // time cost only, trivial
  phase = 1; t = 0; gT = 0; roll = 0;
  prevValid = false; pdx = pdz = 0;
  lastNow = performance.now();
  bindInput();
}

/** Called every tick AFTER updateCamera()/updateReplay(). No-op (and costs
    one branch) once finished or skipped-through, so the director below is
    undisputed from the release frame onward. */
export function updateFlyover(dt) {
  if (phase === 0 || !cam) return;

  /* Own clock: prefer the engine's delta (THREE.Clock halts with rAF when
     the tab hides, and getDelta clamps the resume spike — pause-safe), but
     fall back to a performance.now delta if no dt is passed. Either way a
     single frame can advance the reel by at most one clamped step, so a
     long freeze can never fast-forward the flight. */
  const step = Number.isFinite(dt) && dt > 0
    ? Math.min(dt, .05)
    : clamp((performance.now() - lastNow) / 1000, 0, .05);
  lastNow = performance.now();
  t += step; gT += step;

  if (phase === 1) {                                 // —— grand tour ——
    const x = clamp(t / durA, 0, 1);
    curPA.getPointAt(smooth(x), _pos);
    curLA.getPointAt(smooth(x), _look);
    bankStep(pdx, pdz, _pos.x, _pos.z, step, 1);
    pdx = _pos.x; pdz = _pos.z; prevValid = true;
    commit();
    if (t >= durA) { phase = 2; t = 0; }             // hover beat, then settle

  } else if (phase === 2) {                          // —— settle dive ——
    const x = clamp(t / durB, 0, 1);
    curPB.getPointAt(smooth(x), _pos);
    curLB.getPointAt(smooth(x), _look);
    /* targetScale fades banking out so the landing frame is wings-level */
    bankStep(pdx, pdz, _pos.x, _pos.z, step, 1 - smooth(x));
    pdx = _pos.x; pdz = _pos.z; prevValid = true;
    /* Snap EXACTLY onto the rest pose on the closing frame — spline
       endpoints can carry sub-millimetre fuzz and the handoff must be
       bit-exact against the director's rest seed. */
    if (x >= 1) {
      _pos.copy(REST_POS); _look.copy(REST_LOOK); roll = 0; gT = totCur;
    }
    commit();
    if (x >= 1) release();

  } else if (phase === 3) {                          // —— post-skip return ——
    const x = clamp(t / HANDOFF, 0, 1), e = smooth(x);
    _pos.lerpVectors(_skPos, REST_POS, e);
    _look.lerpVectors(_skLook, REST_LOOK, e);
    roll = skRoll * (1 - e);                         // unwind the bank on the way in
    cam.position.copy(_pos);
    cam.lookAt(_look);
    if (roll) cam.rotateZ(roll);
    cam.fov = lerp(skFov, REST_FOV, e);              // land on the plate lens
    cam.updateProjectionMatrix();
    if (x >= 1) release();
  }
}

/** True while the flyover owns the lens (flying OR easing home). */
export function isActiveFlyover() { return phase !== 0; }

/** End the intro NOW (any key/click — wired in bindInput; also callable).
    Snapshot the current pose and ease it home over HANDOFF seconds instead
    of releasing cold: position would survive a cold release (updateCamera
    lerps) but its bare lookAt would snap the AIM in one frame. */
export function skipFlyover() {
  if (!cam || phase === 0 || phase === 3) return;
  _skPos.copy(cam.position);
  _skLook.copy(phase === 1 || phase === 2 ? _look : REST_LOOK);
  skRoll = roll;
  skFov = cam.fov;
  phase = 3; t = 0;
}
