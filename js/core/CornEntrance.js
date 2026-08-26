/* =====================================================================
   CornEntrance.js — Field of Dreams opening choreography: the ENTIRE
   opening fielding team (nine defenders + that club's bench) waits HIDDEN
   deep in the corn beyond the fence for the whole boot flyover tour —
   zero movement while the lens flies — then streams out of the corn when
   the tour releases it and jogs/runs to their defensive and bench spots.
   The module OWNS the first at-bat: startAtBat fires from its completion
   callback only after every actor has planted, so no windup can beat the
   cast home. Part of the Lincoln Red Gauntlet engine · js/core/

   CONTRACT
     • main.js arms us in the boot tail alongside initFlyover and calls
       updateCornEntrance(dt) at the END of the tick — last transform write
       wins, so pre-game idling in FieldingAI/AnimationController can never
       fight us. While the flyover tours we are HOLD: every actor is pinned
       to his corn mark EVERY frame (zero drift). When main.js calls
       cornEntranceBegin() from the flyover's onDone — THAT is the starting
       gun — we flip to MARCH and stream the cast out on a compressed
       stagger so the last player plants ~10–14 s after the gun.
     • FIRST-PITCH GATE: opts.onStartBatting is our completion callback; it
       fires EXACTLY ONCE — either when the last actor plants naturally or,
       on the skip path, instantly at the snap. It never fires while anyone
       is still running. Parks without the theatre: init is a no-op,
       cornEntranceBegin() returns false, and main.js bats immediately at
       onDone — oracle boot timing identical to a world without us.
     • Targets are NOT re-derived from Game.js internals: at init we
       SNAPSHOT every participant's current position — which is exactly
       where deployTeams/placeOnBench staging just put them — hide them in
       the corn, then walk them back to those same coordinates. Zero edits
       to Game.js, zero coupling to its bench arithmetic.
     • SKIP: one keydown/pointerdown during ANY phase (tour or emergence)
       snaps the whole cast to their targets instantly AND unlocks the
       first pitch at once (mirrors Flyover's skippability — both listeners
       fire off the same input). cornEntranceFinish() does the same snap
       programmatically; idempotent.
     • ORACLE is untouched: init is a no-op unless opts.park === 'fod'
       (and main.js also declines to arm us under ?freeze=1 so diagnostic
       staged poses stay put).
     • Zero per-frame allocation: job table built once at init, scratch
       scalars only in the hot path.

   CAST SELECTION: `defense` (Game.js export) IS the opening fielding
   nine. The bench is every remaining ACTOR of the same team, excluding
   the runner-pool clone bodies (they belong to Runners.js theatre).
===================================================================== */
import * as THREE from 'three';
import { ACTORS } from '../entities/PlayerFactory.js';
import { DEF_SPOTS } from './Constants.js';
import { clamp, easeIO, rand, now } from '../utils/MathUtils.js';

/* ---- Tuning ---------------------------------------------------------- */
const CORN_R_MIN    = 94;      // hidden just past the fence (FENCE_R 91)
const CORN_R_SPAN   = 12;      // …to modestly deeper stands of corn
const AZ_JITTER     = .21;     // exit-azimuth scatter (rad) around each ray
const PACE_DEF      = [8.6, 10.6];  // defenders sprint out (m/s)
const PACE_BENCH    = [7.4, 9.2];   // bench sprints a step slower
const EMERGE_SPREAD = 1.2;     // departures land within ~0–1.2 s of the gun
const MARCH_MAX     = 12.5;    // single-march cap → last plant ≲14 s after gun

/* Scratch + state ------------------------------------------------------ */
const _dir = new THREE.Vector3();
const jobs = [];               // {a, sx,sz, tx,tz, t0, dur, kind}  kind: 0 def · 1 bench
let armed = false;             // fod build with a real cast table
let active = false;            // theatre in progress (HOLD or MARCH)
let phase = 'DONE';            // 'HOLD' tour live · 'MARCH' gun fired · 'DONE'
let clock = 0;                 // seconds since the gun (MARCH only)
let reported = false;          // onStartBatting fired once-and-only-once
let onStartBatting = null;
let bound = false;

const MOUND_X = DEF_SPOTS.Pitcher[0], MOUND_Z = DEF_SPOTS.Pitcher[1];

function reportArrived() {
  if (reported || !onStartBatting) return;
  reported = true;
  onStartBatting();
}

function onSkipInput() { cornEntranceFinish(); }

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

/** Plant `a` at his final spot: exact target coords, field-facing yaw,
    resting animation. The ONE place arrival poses are decided. */
function settle(j) {
  const a = j.a;
  a.root.position.set(j.tx, 0, j.tz);
  a.root.rotation.y = Math.atan2(MOUND_X - j.tx, MOUND_Z - j.tz);
  a.animState = { name: j.kind === 0 ? 'ready' : 'idle', start: now() };
}

/** Arm the theatre. Call once per boot after team deployment has staged the
    cast (main.js boot tail). No-op outside FOD or with nothing to march. */
export function initCornEntrance(opts) {
  if (!opts || opts.park !== 'fod') return;
  jobs.length = 0;
  clock = 0;
  reported = false;
  phase = 'HOLD';
  onStartBatting = typeof opts.onStartBatting === 'function' ? opts.onStartBatting : null;

  /* The nine — Game.js's defense object, whatever club it holds this boot */
  const nine = new Set();
  for (const k in opts.defense) {
    const a = opts.defense[k];
    if (a && a.root) { nine.add(a); }
  }
  if (!nine.size) return;
  const team = nine.values().next().value.team;

  /* Bench = same-team actors that are not defenders and not runner-pool
     clones (pool bodies carry side flags and live in Runners theatre) */
  const cast = [];
  nine.forEach(a => cast.push({ a, kind: 0 }));
  for (let i = 0; i < ACTORS.length; i++) {
    const a = ACTORS[i];
    if (!a.root || a.team !== team || nine.has(a)) continue;
    let pooled = false;
    if (opts.runnerPool) for (let r = 0; r < opts.runnerPool.length; r++)
      if (opts.runnerPool[r] === a) { pooled = true; break; }
    if (!pooled) cast.push({ a, kind: 1 });
  }
  if (!cast.length) return;

  /* Build the job table. Snapshot targets FIRST (boot staging truth), then
     compute each corn hide-point along the plate→spot ray, scattered. The
     whole cast hides through the tour; departures fire off the gun inside
     EMERGE_SPREAD and sprint-biased paces bring the last man home fast. */
  for (let i = 0; i < cast.length; i++) {
    const c = cast[i], a = c.a;
    const tx = a.root.position.x, tz = a.root.position.z;
    _dir.set(tx, 0, tz);
    let az;
    if (_dir.length() < 6) {                       // catcher/near-plate ray is degenerate
      az = rand(-2.5, -.65);                       // pick a corn azimuth on the OF side
      _dir.set(Math.sin(az), 0, -Math.cos(az));
    } else {
      _dir.normalize();
      az = Math.atan2(_dir.x, -_dir.z) + rand(-AZ_JITTER, AZ_JITTER);
      _dir.set(Math.sin(az), 0, -Math.cos(az));
    }
    const R = CORN_R_MIN + rand(0, CORN_R_SPAN);
    const sx = _dir.x * R, sz = _dir.z * R;
    const dist = Math.hypot(tx - sx, tz - sz);
    const paceBand = c.kind === 0 ? PACE_DEF : PACE_BENCH;
    const pace = rand(paceBand[0], paceBand[1]);
    const dur = clamp(dist / pace, 3, MARCH_MAX);
    const t0 = rand(0, EMERGE_SPREAD);
    /* Hide pose: standing in the corn, already facing the coming march */
    a.root.position.set(sx, 0, sz);
    a.root.rotation.y = Math.atan2(tx - sx, tz - sz);
    a.animState = { name: 'ready', start: now() };
    jobs.push({ a, sx, sz, tx, tz, t0, dur, kind: c.kind, done: false });
  }
  armed = true;
  active = true;
  bindInput();
}

/** Per-frame driver. Call AFTER updateFlyover in the tick — our writes are
    the last word on the cast while active. One branch when inactive. */
export function updateCornEntrance(dt) {
  if (!active) return;
  if (phase === 'HOLD') {
    /* Tour still in flight — pin every actor to his corn mark, zero drift,
       no matter what pre-game idling tries. NOBODY departs before the gun. */
    for (let i = 0; i < jobs.length; i++) {
      const j = jobs[i], a = j.a;
      a.root.position.set(j.sx, 0, j.sz);
      a.root.rotation.y = Math.atan2(j.tx - j.sx, j.tz - j.sz);
    }
    return;
  }
  /* MARCH — the gun fired; run the compressed staggered emergence. */
  clock += dt;
  const t = now();
  let pending = false;
  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i];
    if (j.done) continue;
    const u = (clock - j.t0) / j.dur;
    if (u <= 0) { pending = true; continue; }      // still planted in the corn
    if (u >= 1) { settle(j); j.done = true; continue; }
    pending = true;
    const e = easeIO(u);
    const a = j.a;
    a.root.position.set(j.sx + (j.tx - j.sx) * e, 0, j.sz + (j.tz - j.sz) * e);
    a.root.rotation.y = Math.atan2(j.tx - j.sx, j.tz - j.sz);   // face the march
    const want = j.kind === 0 ? 'run' : 'jog';
    if (!a.animState || a.animState.name !== want)
      a.animState = { name: want, start: t };
  }
  if (!pending) {                                  // whole cast arrived & settled
    active = false;
    phase = 'DONE';
    unbindInput();
    reportArrived();                               // natural completion → unlock bat
  }
}

/** The starting gun — main.js calls this from the flyover's onDone. Flips
    HOLD → MARCH so the hidden cast streams out. Returns TRUE when the
    module owns the first pitch (main must NOT call startAtBat itself — the
    completion callback will), FALSE when there is no theatre (oracle park,
    nothing armed) and batting should begin right now. Idempotent. */
export function cornEntranceBegin() {
  if (!armed) return false;
  if (active && phase === 'HOLD') { phase = 'MARCH'; clock = 0; }
  return true;
}

/** True while the theatre still owns the defensive cast (fod boots only). */
export function cornEntranceActive() { return armed && active; }

/** Diagnostics: where the choreography stands right now (probe/debug). */
export function cornEntranceStatus() {
  let planted = 0;
  for (let i = 0; i < jobs.length; i++) if (jobs[i].done) planted++;
  return {
    armed, active, phase,
    clock: Math.round(clock * 100) / 100,
    planted, total: jobs.length
  };
}

/** Snap EVERYONE to their target instantly and stand down — the skip path
    (any phase) shares this. Unlocks the first pitch immediately. Idempotent. */
export function cornEntranceFinish() {
  if (!armed || !active) return;
  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i];
    if (!j.done) { settle(j); j.done = true; }
  }
  active = false;
  phase = 'DONE';
  unbindInput();
  reportArrived();                                 // skip → instant bat unlock
}
