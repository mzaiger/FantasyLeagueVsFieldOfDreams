/* =====================================================================
   Runners.js — base-runner THEATRE: the batter himself sprinting the
   paths, plus the miniature pill pool for inherited runners
   Part of the Lincoln Red Gauntlet engine · js/entities/

   init() context: { G, SND, after, now, scoreRuns, getBatter? }

   PRESENTATION ONLY over game state: G.bases occupancy, run scoring and
   advancement arithmetic stay owned by the Game.js flow that calls
   advanceHit / forceAdvance / trotHR. This module owns WHERE RUNNING
   ACTORS physically are and what their legs look like while they get
   there — nothing else.

   Two fleets:
   • ACTOR RUNNERS — any ready actor (the batter at contact) driven along
     a bulged base path: accelerate out of the box, wide arcs a few feet
     outside the bags on turns, slow-up into a base he holds, cadence-
     synced stride (leg speed follows ground speed), banked turns, dust
     at every bag, bat "dropped" at the plate, then a jog off toward his
     dugout side before the handback callback fires.
   • PILL POOL — the four-per-club miniatures, still carrying runners who
     reached base earlier (who occupies a bag lives in G.bases, not here).

   The driver works for ANY actor shape (FBX rig, humanoid, pill): it
   only touches actor.root transform + animState, exactly what
   AnimationController.driveActor consumes.
===================================================================== */
import * as THREE from 'three';
import { BASE_POS, POSITIONS, LIN, DEF_SPOTS } from '../core/Constants.js';
import { clamp, easeIO } from '../utils/MathUtils.js';
import { FX } from '../effects/ParticleSystem.js';
import { spawnVisitorActor } from './PlayerFactory.js';
import { OPP } from './RosterManager.js';
import { lendFBXRunner, seatNamedStager, claimExtStage } from './RunnersHelpers.js';

let ctx = null;
export function initRunners(context) { ctx = context; }

/* ---- Tuning table ------------------------------------------------------ */
export const RUNNER = {
  SPRINT: 9.3,        // cruise to the bag he earns (m/s)
  TROT:   7.0,        // home-run circuit pace (real trot ≈ 4 — paced for fun)
  EXIT:   8.2,        // jog-off to the dugout after the play
  ACC:    8.2,        // explode out of the box (m/s²)
  DEC:    9.5,        // brake into a held bag (m/s²)
  START_V: 2.2,       // he is ALREADY moving when he leaves the box
  END_V:  .9,         // crawl the final step onto the bag
  ARC_R:  2.5,        // how far outside the bag turns bulge (m)
  TOUCH_R: 1.15,      // plant this far fair-side/right of a held bag (m)
  HOLD:   .38,        // planted beat on a held bag before jogging off (s)
  TURN:   9.5,        // heading slew rate (rad/s)
  LEAN:   .048,       // bank-into-the-turn gain (rad per rad/s of turn)
  LEAN_MAX: .13
};

/* ======================================================================
   ACTOR-RUNNER DRIVER
====================================================================== */
const jobs = [];                       // live actor-runner jobs

const P4 = i => BASE_POS[((i % 4) + 4) % 4];
const _evV = new THREE.Vector3();      // scratch: dust spawn point (per-frame safe)

/** Runner's-right unit vector of travel dir (dx,dz): facing +Z ⇒ right = −X.
    Baseball turns are always LEFT, so "outside the turn" = right side. */

/** Build a polyline from `from` through the bags named by `idxList`
 *  (BASE_POS indices in running order, may exceed 3 — wraps via %4).
 *  Interior bags get a two-point bulge (approach + depart, both pushed to
 *  the outside of the turn) so corners read as rounded arcs. Returns
 *  { pts, cum, total, events, bagX, bagZ }; allocation happens HERE only,
 *  never in the per-frame step. */
function buildRun(from, idxList, round) {
  const pts = [from.clone()], events = [];
  const n = idxList.length;
  let bx = from.x, bz = from.z;
  for (let k = 0; k < n; k++) {
    const bag = P4(idxList[k]);
    bx = bag.x; bz = bag.z;
    const prev = pts[pts.length - 1];
    let ix = bag.x - prev.x, iz = bag.z - prev.z;
    const il = Math.hypot(ix, iz);
    if (il < .05) continue;                          // already standing on it
    ix /= il; iz /= il;
    const interior = k < n - 1 || round;
    if (!interior) {
      /* Held bag: plant just front-right of the base, never ON it */
      pts.push(new THREE.Vector3(bag.x - ix * .3 - iz * RUNNER.TOUCH_R, 0,
                                 bag.z - iz * .3 + ix * RUNNER.TOUCH_R));
    } else {
      const nb = P4(idxList[k] + 1);
      let ox = nb.x - bag.x, oz = nb.z - bag.z;
      const ol = Math.hypot(ox, oz) || 1; ox /= ol; oz /= ol;
      const R = RUNNER.ARC_R;
      pts.push(new THREE.Vector3(bag.x - ix * 2.3 - iz * R, 0, bag.z - iz * 2.3 + ix * R));
      pts.push(new THREE.Vector3(bag.x + ox * 2.3 - oz * R, 0, bag.z + oz * 2.3 + ox * R));
      events.push({ s: 0, x: bag.x, z: bag.z, i: pts.length - 2 });
    }
  }
  const cum = [0];
  for (let i = 1; i < pts.length; i++)
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  for (const e of events) e.s = cum[e.i];
  return { pts, cum, total: cum[cum.length - 1], events, bagX: bx, bagZ: bz };
}

/** Where this runner leaves the field toward: visitors swing out to their
    1st-base-line bench, Lincoln hitters peel off to their dugout side
    (same ± parity rule placeOnBench uses for roster slots). */
function exitSpot(a) {
  if (ctx.G.half === 'top') return new THREE.Vector3(21.5, 0, -11.5);
  const sg = (POSITIONS.indexOf(a.role) % 2) ? 1 : -1;
  return new THREE.Vector3(sg * 12.8, 0, -7.2);
}

/**
 * THE HANDOFF CONTRACT — Game.js calls this at contact resolution.
 * @param {Actor} actor  any ready actor (usually activeBatter())
 * @param {number[]} bases  BASE_POS indices in running order:
 *        [0]=to 1st, [0,1]=to 2nd, [0,1,2]=triple, [0,1,2,3]=HR circuit
 * @param {object} [o]
 *        jog     relaxed pace (walks, home-run trot)
 *        round   never brake — charge through every bag (triples/HR)
 *        speed   cruise override (m/s)
 *        hold    planted seconds on the final bag (default RUNNER.HOLD, 0 skips)
 *        stay    SAFE ARRIVAL (walks, hits): once planted, if his final bag
 *                is occupied the job ends and the actor vanishes right there
 *                — the pool stager takes over that exact spot same tick. No
 *                dugout jog-off; the runner he became simply stays on base.
 *                If the bag went dark mid-play he jogs off as usual.
 *        waitRace  hold past expiry while a race verdict (dropped fly OR
 *                fielded grounder) is pending — G.bases stays frozen mid-
 *                theatre, so plant and re-decide only once it resolves.
 *        onDone  fired after the arrival hold + dugout jog-off completes
 * @returns the job (truthy), or null if the request was malformed.
 */
export function sendRunner(actor, bases, o = {}) {
  if (!actor || !actor.root || !actor.ready || !Array.isArray(bases) || !bases.length) return null;
  cancelRunner(actor);                                   // one live job per actor
  const from = actor.root.position;
  const built = buildRun(from, bases, !!o.round);
  const jog = !!o.jog;
  actor.animState = { name: jog ? 'jog' : 'run', start: ctx.now() };
  let bagIdx = -1;                                       // final-bag index, for safe-arrival swaps
  for (let b = 0; b < 3; b++)
    if (Math.hypot(built.bagX - BASE_POS[b].x, built.bagZ - BASE_POS[b].z) < .5) { bagIdx = b; break; }
  const job = {
    a: actor, pts: built.pts, cum: built.cum, total: built.total,
    bagX: built.bagX, bagZ: built.bagZ, bagIdx, events: built.events, evI: 0,
    si: 0, s: 0, v: RUNNER.START_V,
    cruise: o.speed || (jog ? RUNNER.TROT : RUNNER.SPRINT),
    brake: !o.round, jog, phase: 0, lean: 0, mode: 'run',
    hold: o.hold !== undefined ? o.hold : RUNNER.HOLD, holdT: 0,
    onDone: o.onDone || null, bat: null, batWas: true,
    stay: !!o.stay, waitRace: !!o.waitRace,
  };
  /* Bat costume goes dark — he dropped it leaving the box */
  const bat = actor.root.getObjectByName('bat');
  if (bat && bat.visible) { job.bat = bat; job.batWas = true; bat.visible = false; }
  jobs.push(job);
  FX.dust.spawnCluster(_evV.set(from.x, .12, from.z), 4);   // kick-up out of the box
  if (ctx.SND) ctx.SND.cleats();
  return job;
}

/** Stop owning this actor immediately (no callbacks). Staging calls this
 *  flavour of cleanup whenever it needs the body back. */
export function cancelRunner(actor) {
  for (let i = jobs.length - 1; i >= 0; i--)
    if (jobs[i].a === actor) { const j = jobs.splice(i, 1)[0]; release(j, false); }
}

/** Give the body back: bat restored, roll zeroed, idle stance. A swapped
 *  stay-arrival instead vanishes AT the bag — endPA redresses him onto the
 *  bench / on-deck while invisible — leaving his exact spot to the pool
 *  stager via pendingSwap. */
function release(j, fireDone) {
  const a = j.a;
  a.root.rotation.z = 0;
  if (j.bat) j.bat.visible = j.batWas;
  if (a.animState && (a.animState.name === 'run' || a.animState.name === 'jog'))
    a.animState = { name: 'idle', start: ctx.now() };
  if (j.swapped && fireDone) {
    a.root.visible = false;
    pendingSwap = { bag: j.bagIdx, spot: a.root.position.clone() };
  }
  if (fireDone && j.onDone) { try { j.onDone(); } catch (e) { console.error('[runners]', e); } }
}

/** Switch to the dugout jog: keep momentum, aim 8 m past the current
    heading first so the peel-off curves instead of snapping sideways. */
function beginExit(j) {
  const r = j.a.root.position, tgt = exitSpot(j.a);
  const hy = j.a.root.rotation.y;
  const hx = Math.sin(hy), hz = Math.cos(hy);
  j.pts = [
    r.clone(),
    new THREE.Vector3(r.x + hx * 8 + (tgt.x - r.x) * .3, 0, r.z + hz * 8 + (tgt.z - r.z) * .3),
    tgt.clone(),
  ];
  j.cum = [0];
  for (let i = 1; i < j.pts.length; i++)
    j.cum.push(j.cum[i - 1] + Math.hypot(j.pts[i].x - j.pts[i - 1].x, j.pts[i].z - j.pts[i - 1].z));
  j.total = j.cum[j.cum.length - 1];
  j.si = 0; j.s = 0; j.evI = j.events.length;            // bag dust is spent
  j.cruise = RUNNER.EXIT; j.mode = 'exit';
  j.a.animState = { name: 'run', start: ctx.now() };
  if (ctx.SND) ctx.SND.cleats();
}

/** Advance one runner. Allocation-free: numbers and scratch state only.
    Returns true when the job has finished (caller splices + releases). */
function stepJob(j, dt, tnow) {
  const a = j.a, r = a.root.position, rot = a.root.rotation;

  if (j.mode === 'hold') {                               // planted on the bag
    j.holdT -= dt;
    if (j.holdT <= 0) {
      /* Race theatre (dropped fly OR fielded grounder): G.bases is frozen
         until the pickup→throw verdict applies — keep planted, re-decide
         next frame against the updated occupancy. */
      if (j.waitRace && pendingRace) return false;
      /* Safe arrival: while his final bag is genuinely occupied, end here —
         the pool stager takes over his exact spot (release does the swap).
         If the bag went dark mid-play (retired on the exchange), fall back
         to the classic dugout jog-off. */
      if (j.stay && j.bagIdx >= 0 && ctx.G.bases[j.bagIdx]) {
        j.swapped = true;
        return true;
      }
      beginExit(j);
    }
    return false;
  }

  /* -- pacing: accelerate / cruise / kinematic brake into the endpoint -- */
  const dRem = Math.max(0, j.total - j.s);
  let tv = j.cruise;
  if (j.brake || j.mode === 'exit')
    tv = Math.min(tv, Math.sqrt(2 * RUNNER.DEC * dRem) + (j.mode === 'exit' ? 1.2 : RUNNER.END_V));
  j.v += clamp(tv - j.v, -RUNNER.DEC * dt, RUNNER.ACC * dt);
  j.s = Math.min(j.total, j.s + j.v * dt);

  /* -- position along the polyline (monotonic segment pointer) -- */
  while (j.si < j.pts.length - 2 && j.s > j.cum[j.si + 1]) j.si++;
  const A = j.pts[j.si], B = j.pts[j.si + 1];
  const sl = (j.cum[j.si + 1] - j.cum[j.si]) || 1e-4;
  const lt = clamp((j.s - j.cum[j.si]) / sl, 0, 1);
  r.x = A.x + (B.x - A.x) * lt;
  r.z = A.z + (B.z - A.z) * lt;

  /* -- heading slew + bank into the turn (root roll about local Z) -- */
  const want = Math.atan2(B.x - A.x, B.z - A.z);
  let diff = want - rot.y;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  const turn = clamp(diff, -RUNNER.TURN * dt, RUNNER.TURN * dt);
  rot.y += turn;
  const leanT = clamp(-turn / Math.max(dt, 1e-3) * RUNNER.LEAN, -RUNNER.LEAN_MAX, RUNNER.LEAN_MAX);
  j.lean += (leanT - j.lean) * Math.min(1, dt * 7);
  rot.z = j.lean;

  /* -- cadence sync: stride frequency follows ground speed so braking
        into a bag visibly shortens the steps instead of moonwalking -- */
  const wantName = j.jog ? 'jog' : 'run';
  if (!a.animState || a.animState.name !== wantName) {
    const oldNat = a.animState && a.animState.name === 'jog' ? 7 :
                   a.animState && a.animState.name === 'run' ? 11 : 0;
    if (oldNat) j.phase *= (wantName === 'jog' ? 7 : 11) / oldNat;   // seamless cycle handoff
    a.animState = { name: wantName, start: tnow };
  }
  const nat = wantName === 'jog' ? 7 : 11;
  j.phase += dt * nat * clamp(j.v / (wantName === 'jog' ? RUNNER.TROT : RUNNER.SPRINT), .25, 1.35);
  a.animState.start = tnow - j.phase;

  /* -- bag dust -- */
  while (j.evI < j.events.length && j.s >= j.events[j.evI].s) {
    const e = j.events[j.evI++];
    FX.dust.spawnCluster(_evV.set(e.x, .12, e.z), 5);
  }

  /* -- arrival -- */
  if (j.s >= j.total - 1e-4) {
    FX.dust.spawnCluster(_evV.set(j.bagX, .12, j.bagZ), 6);
    if (j.mode === 'run' && j.hold > 0) {                // plant, catch breath
      j.mode = 'hold'; j.holdT = j.hold;
      a.animState = { name: 'ready', start: tnow };
      rot.z = 0; j.lean = 0;
    } else return true;                                  // done — caller releases
  }
  return false;
}

/* ======================================================================
   PER-FRAME UPDATE — actor jobs first, then the pill pool
====================================================================== */
export function updateRunners(dt) {
  for (let i = jobs.length - 1; i >= 0; i--) {
    const j = jobs[i];
    let done = false;
    try { done = stepJob(j, dt, ctx.now()); }
    catch (e) { console.error('[runners]', e); done = true; }
    if (done) { jobs.splice(i, 1); release(j, true); }
  }

  /* Occupancy staging reconcile — event-gated: only while a play just
     resolved (stagePending) AND the side has gone quiet (no live jobs, no
     inbound pills). Allocation-free. */
  if (stagePending && !jobs.length) {
    let quiet = true;
    for (let i = 0; i < runnerPool.length; i++)
      if (runnerPool[i].active && runnerPool[i].side === side) { quiet = false; break; }
    if (quiet) { reconcileStaging(); stagePending = false; }
  }

  for (const r of runnerPool) {
    if (!r.active || !r.path) continue;
    if (r.path.length < 2) {          // degenerate path — never lerp a missing endpoint
      const done = r.then;
      r.active = false; r.path = null; r.root.visible = false;
      done && done();
      continue;
    }
    r.pt += dt / r.durPer;
    const seg = Math.min(Math.floor(r.pt), r.path.length - 2);
    const lt = clamp(r.pt - seg, 0, 1);
    const A = r.path[seg], B = r.path[seg + 1];
    r.root.position.lerpVectors(A, B, easeIO(lt));
    const dx = B.x - A.x, dz = B.z - A.z;
    if (Math.hypot(dx, dz) > .01) r.root.rotation.y = Math.atan2(dx, dz);
    if (r.pt >= r.path.length - 1) {
      const dest = r.path[r.path.length - 1];
      const done = r.then;
      r.active = false; r.path = null;
      /* Landed on an occupied base? Stay on stage there instead of vanishing
         — the arrival IS the staging handoff (no gap on the new bag). */
      let kept = false;
      if (dest !== BASE_POS[3])
        for (let b = 0; b < 3; b++)
          if (dest === BASE_POS[b] && ctx.G.bases[b] && !staged[b]) { keepStaged(r, b); kept = true; break; }
      if (!kept) r.root.visible = false;
      done && done();
    }
  }
}

/* ======================================================================
   PILL POOL — inherited runners only (occupancy lives in ctx.G.bases)
===================================================================== */
export const runnerPool = [];
let side = 'lin';                        // which club's pills are live this half

/** Game.js calls this when the half flips ('lin' | 'opp'). */
export function setRunnerSide(s) {
  side = s === 'opp' ? 'opp' : 'lin';
  /* Defensive: staging never survives a club flip (clearRunners already
     reset it on the half swap — this only guards out-of-order callers). */
  for (let i = 0; i < 3; i++)
    if (staged[i] && staged[i].side !== side) staged[i] = null;
}

/* ======================================================================
   OCCUPANCY STAGING — between plays, every occupied bag shows a live idle
   pill of the batting club (pure presentation; G.bases stays owned by the
   Game.js flow). Staging yields instantly by construction: _sendPill's
   getRunner treats staged bodies as first-choice free pills, so an
   advancement re-tasks the very runner standing on the bag (the steal
   reads as that runner taking his base), and the post-play reconcile
   re-parks whoever belongs where.
====================================================================== */
const staged = [null, null, null];       // bag index -> pill parked there
let stagePending = false;                // reconcile once the play goes quiet
let pendingSwap = null;                  // stay-arrival handoff {bag, spot}: where the
                                         // batter vanished, so the stager replaces him exactly there
const MOUND = new THREE.Vector3(DEF_SPOTS.Pitcher[0], 0, DEF_SPOTS.Pitcher[1]);
/* Lead-off spots: one relaxed step behind each bag, straight out from home */
const STAGE_SPOT = [0, 1, 2].map(i => {
  const b = BASE_POS[i], dx = b.x - BASE_POS[3].x, dz = b.z - BASE_POS[3].z;
  const l = Math.hypot(dx, dz) || 1;
  return new THREE.Vector3(b.x + dx / l * 1.05, 0, b.z + dz / l * 1.05);
});

/** Park pill `r` as the stager of bag `i`: visible, facing the mound,
    breathing idle stance. Called on landing + reconcile only — never
    per-frame. `spot` overrides the default lead-off position (used by the
    stay-arrival swap so the replacement appears exactly where the batter
    vanished). */
function keepStaged(r, i, spot) {
  for (let k = 0; k < 3; k++) if (staged[k] === r) staged[k] = null;   // a body stages ONE bag — drop its stale alias
  staged[i] = r;
  r.active = false; r.path = null;
  r.root.visible = true;
  const sp = spot || STAGE_SPOT[i];
  r.root.position.copy(sp);
  r.root.rotation.y = Math.atan2(MOUND.x - sp.x, MOUND.z - sp.z);
  r.animState = { name:'idle', start:ctx.now() };
}

/** Full reconcile — event-driven (post-play quiet), never per-frame:
    drops pointers whose pill went back to work or changed clubs, hides
    stagers on vacated bags, parks free pills on occupancy. */
function reconcileStaging() {
  for (let i = 0; i < 3; i++) {
    const r = staged[i];
    if (!r) continue;
    if (r.active || r.side !== side) { staged[i] = null; continue; }   // busy flight — leave it be
    if (!ctx.G.bases[i]) { r.root.visible = false; staged[i] = null; } // bag vacated — bench him
  }
  const swap = pendingSwap;                              // one-shot hint: replace the
  pendingSwap = null;                                    // vanished stay-arrival in place
  for (let i = 0; i < 3; i++) {
    if (!ctx.G.bases[i] || staged[i]) continue;
    /* OWNER RULE FIRST: while Lincoln bats an occupied bag wears a NAMED
       roster rig, never a Player1 clone stand-in — most safe arrivals end
       via the external sweep (no swapped onDone to hook), so this is where
       between-play identity is actually won or lost. The lender seats an
       eligible bench body on the lead-off spot through the same claim hook
       his stay-swaps use; only when NO bench body qualifies does the clone
       pool stage as before. FOD halves skip straight to clones. */
    if (side === 'lin' &&
        seatNamedStager(i, STAGE_SPOT[i], Math.atan2(MOUND.x - STAGE_SPOT[i].x,
                                                     MOUND.z - STAGE_SPOT[i].z))) {
      continue;
    }
    const free = runnerPool.find(r => r.side === side && !r.active &&
                                     staged[0] !== r && staged[1] !== r && staged[2] !== r);
    if (free) keepStaged(free, i, swap && swap.bag === i ? swap.spot : null);
  }
}

/* ---- NAMED-RIG STAGING HOOKS (RunnersHelpers lending) -------------------
   A lent bench rig who reaches base safely used to vanish into the stay-
   swap and be replaced by a clone at his footprints — the base-running
   THEATRE was his, but the between-play stager was always a clone. These
   hooks let the lender park the SAME roster rig on the bag he earned, so
   occupancy staging shows named LIN rigs while Lincoln bats (owner rule)
   with zero changes to the reconcile's own logic: a staged entry only
   needs .active/.side/.root, and every existing consumer (the quiet-gate,
   setRunnerSide's club-flip guard, clearRunners, reconcileStaging's
   vacated-bag benching) already treats them uniformly. The lender's
   watcher postDrive polls isExtStaged and re-benches the body when the
   reconcile drops him — including the re-lend path, where _sendPill's
   alias-clear is what un-stages him as he takes his next base.
   reconcileStaging above is the hook's OTHER consumer: whenever an
   occupied LIN bag sits unclaimed (unopposed arrivals, post-sweep
   re-parks), it seats a named bench rig FIRST and clones only as
   fallback. -------- */

/** Park a named-rig runner as the stager of bag `i` (0..2). Fails (false)
    when the slot is held — the caller then falls back to bench restore. */
export function stageExternalActor(i, a) {
  if (i < 0 || i > 2 || staged[i] || !a || !a.root) return false;
  a.side = side;
  staged[i] = a;
  return true;
}

/** True while `a` still holds his staged bag. */
export function isExtStaged(a) {
  return staged[0] === a || staged[1] === a || staged[2] === a;
}

/** Release `a`'s bag claim (the lender's watcher calls this when the body's
    lineup slot comes due and the PA flow needs him at the plate — the
    reconcile then stages a clone for the still-occupied bag). */
export function unstageExternal(a) {
  for (let i = 0; i < 3; i++) if (staged[i] === a) { staged[i] = null; return true; }
  return false;
}

/** Who currently holds bag `i`'s staging slot (null when free). The lender
    reads this to give the SLOT'S OCCUPANT his own advance leg — the man
    standing on first IS the guy who should run to second (owner rule: no
    random body ever wears a runner's leg). */
export function stageHolder(i) {
  return i >= 0 && i < 3 ? staged[i] : null;
}

/** Force-claim bag `i` for `a`, EVICTING any resting stager in the way.
    Returns undefined when malformed or when a live flight owns the slot
    (never steal from a running job); otherwise returns the evictee (or
    null) so the CALLER can settle him — RunnersHelpers knows how to re-hide
    clones and relies on named rigs' drop-watchers to re-bench themselves. */
export function replaceStage(i, a) {
  if (i < 0 || i > 2 || !a || !a.root) return undefined;
  const cur = staged[i];
  if (cur === a) { a.side = side; return null; }
  if (cur && cur.active) return undefined;   // busy flight — the bag changes hands elsewhere
  staged[i] = a;
  a.side = side;
  return cur || null;
}

export function createRunners() {
  /* FBX runners (user directive — "make it an FBX character"): the pool was
     mini pills; every runner is now a full-size cloned Player1 rig through
     the same humanoid-then-hot-swap spawn the visitor nine uses. Player1
     only, never Player2. Until the rig lands the humanoid stand-in serves,
     but runners start hidden so nothing is seen mid-load. */
  for (let i = 0; i < 4; i++) {
    const r = spawnVisitorActor('LIN Runner ' + i, LIN, { rigName:'Player1' });
    r.side = 'lin';
    r.root.visible = false; r.active = false; r.path = null; r.pt = 0; r.then = null;
    runnerPool.push(r);
  }
  for (let i = 0; i < 4; i++) {
    const r = spawnVisitorActor(OPP.abbr + ' Runner ' + i, OPP, { rigName:'Player1' });
    r.side = 'opp';
    r.root.visible = false; r.active = false; r.path = null; r.pt = 0; r.then = null;
    runnerPool.push(r);
  }
}

function getRunner() {
  const free = runnerPool.find(r => !r.active && r.side === side);
  if (free) return free;
  /* _lent bodies are mid-leg on a sendRunner job (RunnersHelpers) — the
     steal-fallback below would yoke a live FBX leg to the pill lerp. */
  const mine = runnerPool.filter(r => r.side === side && !r._lent);
  if (!mine.length) return null;                       // all four on lent FBX legs
  const busy = mine.find(r => r.path && r.pt >= r.path.length - 1.5) || mine[0];
  busy.active = false;
  return busy;
}

/** Internal pill dispatch (legacy path shape). `fromIdx`/`toIdx` are BASE_POS
 *  indices (0 = 1st, 1 = 2nd, 2 = 3rd, 3 = home); indices may run past 3 —
 *  they wrap via %4. `jog` = relaxed trot. */
function _sendPill(fromIdx, toIdx, dur, then, jog = false) {
  /* REAL-RIG LEGS FIRST — lend a batting-club FBX body and route the hop
     through the actor-job system (accel/brake pacing, banked turns, bag
     dust, cadence-synced stride) instead of the linear lerp below.
     Team-aware (RunnersHelpers): LIN batting lends a REAL bench roster rig
     (Hyle/Kevo/Scherz… — the player's own FBX, never while he fields,
     bats or stands on-deck), FOD lends the Player1 clone pool. Falls back
     to the legacy pill leg whenever no body is free/eligible (boot window
     before the rigs hot-swap, all four busy); no caller inspects this
     return value, so the job-for-body swap is invisible to call sites. */
  const fb = lendFBXRunner(side, fromIdx, toIdx, jog, then);
  if (fb) {
    /* Leaving the stage voids his bag claim — same rule as the legacy
       path below, so the arrival handoff never sees a stale alias. */
    for (let k = 0; k < 3; k++) if (staged[k] === fb.a) staged[k] = null;
    return fb.job;
  }
  const r = getRunner();
  if (!r) { then && then(); return null; }
  /* Leaving the stage voids his bag claim — otherwise the arrival handoff
     sees his own stale staged[] alias and benches him instead of re-staging
     (occupied bags left standing empty after walks / forced advances). */
  for (let k = 0; k < 3; k++) if (staged[k] === r) staged[k] = null;
  r.active = true; r.root.visible = true;
  r.path = [];
  for (let j = fromIdx; j <= toIdx; j++) r.path.push(BASE_POS[j % 4]);
  r.pt = 0;
  r.durPer = Math.max(.8, dur / Math.max(1, r.path.length - 1));
  r.then = then || null;
  r.animState = { name: jog ? 'jog' : 'run', start: ctx.now() };
  r.root.position.copy(r.path[0]);
  return r;
}

/** Route the BATTER leg through the real actor when the director exposed
    one (ctx.getBatter); returns the live runner job (truthy) so callers can
    track progress, or null so callers can fall back to pills. */
function runBatter(legs, opts, then) {
  const get = ctx.getBatter;
  const a = get && get();
  if (!a || !a.ready) return null;
  /* BATTER-LEG CONTINUITY (owner rule: "whoever is hitting… when they go to
     first they stay the same FBX. No random one."). The stay-arrival ends
     with release()'s vanish-at-the-bag into the staging handoff — which
     used to hand his exact footprints to whichever body the reconcile
     picked (a random bench rig, or a clone on unopposed arrivals). Instead,
     the moment HIS leg completes we claim the bag for HIM: the hitter who
     just ran is the same named rig who idles between plays, until the
     watcher re-benches him (bag vacated / club flip / his slot comes due).
     Scoring circuits never swap; verdict-pending holds stage only if the
     verdict kept his bag; a half-flip or fielding redeploy (onDuty) skips. */
  const onDone = () => {
    if (job.swapped && ctx.G.half === 'bottom' && !a.onDuty && job.bagIdx >= 0)
      claimExtStage(a, job.bagIdx);      // no-op (false) when something already claimed the slot
    then && then();
  };
  const job = sendRunner(a, legs, Object.assign({}, opts, { onDone }));
  return job;
}
const batterLegs = nb => { const L = []; for (let k = 0; k < nb; k++) L.push(k); return L; };

/* ---- Advancement rules (state semantics UNCHANGED — see header) -------- */

/** Base hit: force runners + batter advance `nb` bases; returns runs scored
 *  on the paths. `then` (optional) fires when the batter actor finishes his
 *  run-and-exit — pass endPA to ride the theatre instead of a fixed timer. */
export function advanceHit(nb, then) {
  let runs = 0;
  for (let i = 2; i >= 0; i--) {
    if (ctx.G.bases[i]) {
      ctx.G.bases[i] = false;
      const dest = Math.min(i + nb, 3);
      _sendPill(i, dest, 2.0, null);
      if (i + nb >= 3) runs++; else ctx.G.bases[dest] = true;
    }
  }
  ctx.G.bases[nb - 1] = true;
  if (!runBatter(batterLegs(nb), { stay: true }, then))           // batter: box → bag, stay on base
    _sendPill(3, 3 + nb, 1.5 * nb + .7, then);
  stagePending = true;                                            // re-stage once the play settles
  return runs;
}

/** Walk: force every runner up one base, batter to first. `then` rides the
 *  batter actor's arrival at 1st (legacy: the pill's arrival). */
export function forceAdvance(then) {
  for (let i = 2; i >= 0; i--) {
    if (ctx.G.bases[i]) {
      ctx.G.bases[i] = false;
      const dest = i + 1;
      if (dest >= 3) { ctx.scoreRuns(1); _sendPill(i, 3, 1.6, null); }
      else { ctx.G.bases[dest] = true; _sendPill(i, dest, 1.7, null); }
    }
  }
  ctx.G.bases[0] = true;
  if (!runBatter([0], { jog: true, hold: .25, stay: true }, then)) // batter: home → 1st, stay on base
    _sendPill(3, 4, 1.8, then, true);
  stagePending = true;                                            // re-stage once the play settles
}

/** Home-run trot: everyone scores. `then` (optional) fires when the batter
 *  actor completes the circuit — pass endPA to replace the fixed timer. */
export function trotHR(then) {
  for (let i = 2; i >= 0; i--)
    if (ctx.G.bases[i]) { ctx.G.bases[i] = false; _sendPill(i, 3, 4.4, null, true); }
  ctx.G.bases = [false, false, false];
  if (!runBatter([0, 1, 2, 3], { jog: true, round: true, hold: .55 }, then))
    _sendPill(3, 7, 5.2, then, true);                             // home → home circuit
  stagePending = true;                                            // reconcile benches the stagers
}

/* ======================================================================
   FORCE-RACE THEATRE (Task 5 #28, generalized by Task D-1) — launch +
   resolution for every play where occupancy stays FROZEN while a live
   race runs: an outfield fly predicted to drop AND a fielded infield
   grounder alike. Game.js calls startDropTheatre at CONTACT: every
   inherited runner and the batter begin their one-base legs immediately
   (real running theatre while the ball is still in the air / being
   fielded), but G.bases is applied only when the pickup → throw verdict
   resolves (applyDropOutcome). The LEAD runner is the most advanced
   inherited runner (highest occupied bag); with empty bases the batter
   himself is the lead. His destination bag is the bag the fielder throws
   to. Pill legs run at DROP_RUN_SPEED so the visual pace matches the race
   arithmetic; the batter-actor leg runs at his own RUNNER.SPRINT physics
   and is estimated from his live job progress.

   The grounder reuses this machinery verbatim because applyDropOutcome's
   semantics ARE force-advance semantics: SAFE = everyone moves up one,
   home crossings score; OUT = only the lead runner is retired, the rest
   still advance, and the batter takes 1st unless HE was the out (which is
   exactly a putout at first with nobody aboard). `kind` only labels the
   record for hooks/debug — the leg maths are identical.
===================================================================== */
export const DROP_RUN_SPEED = 9.6;       // m/s — race-leg pace (≈ RUNNER.SPRINT)
let pendingRace = null;                  // { kind, lead, batterJob, preBases, leadBag, done }

/** Launch the force-race theatre. `preBases` = [1st,2nd,3rd] occupancy at
    contact (Game.js owns G.bases and keeps it frozen until resolution);
    `kind` labels the race ('drop' | 'ground'). Returns the race record
    (also kept module-side for the estimators). */
export function startDropTheatre(preBases, kind = 'drop') {
  let leadBag = -1, lead = null;
  for (let i = 2; i >= 0; i--) {
    if (!preBases[i]) continue;
    const dest = Math.min(i + 1, 3);
    const d = Math.hypot(BASE_POS[dest].x - BASE_POS[i].x, BASE_POS[dest].z - BASE_POS[i].z);
    const dur = Math.max(.8, d / DROP_RUN_SPEED);
    const fb = lendFBXRunner(side, i, dest, false);
    if (fb) {
      for (let k = 0; k < 3; k++) if (staged[k] === fb.a) staged[k] = null;
    } else _sendPill(i, dest, dur, null);
    if (i > leadBag) {                   // highest occupied bag = lead runner
      leadBag = i;
      lead = fb ? { kind:'actor', bag:dest, job:fb.job }   // estimator reads live job progress
                : { kind:'pill', bag:dest, tArr: ctx.now() + dur };
    }
  }
  /* The batter ALWAYS takes his real actor leg to 1st under a verdict-hold
     (waitRace): with empty bases he IS the lead runner; otherwise he fills
     first behind whatever the race decides. His live job handle is kept on
     the record so Game.js can estimate his arrival for the out-at-first
     half of the grounder verdict (raceBatterArrival below). */
  const bjob = runBatter([0], { stay: true, waitRace: true }, null);
  if (leadBag < 0) {
    /* Empty bases: the batter himself is the lead runner — race his real
       actor leg (pill fallback if no actor is available) */
    if (bjob) lead = { kind:'actor', bag:0, job:bjob };
    else {
      const d = Math.hypot(BASE_POS[0].x, BASE_POS[0].z);
      _sendPill(3, 4, Math.max(.8, d / DROP_RUN_SPEED), null);
      lead = { kind:'pill', bag:0, tArr: ctx.now() + Math.max(.8, d / DROP_RUN_SPEED) };
    }
  }
  pendingRace = { kind, lead, batterJob:bjob, preBases: preBases.slice(), leadBag, done:false };
  return pendingRace;
}

/** Seconds from NOW until the lead runner tags his destination bag.
    Actor leads estimate from live job progress at RUNNER.SPRINT (plus a
    braking allowance into the bag); pill leads run a fixed schedule. */
export function dropRunnerArrival() {
  if (!pendingRace || !pendingRace.lead) return 1e9;
  const L = pendingRace.lead;
  if (L.kind === 'actor') {
    const j = L.job;
    if (!j) return 0;                                  // job finished — he's there
    return Math.max(0, j.total - j.s) / RUNNER.SPRINT + .12;
  }
  return Math.max(0, L.tArr - ctx.now());
}

/** Seconds from NOW until the race's BATTER-RUNNER tags first — the second
    number the grounder verdict needs when runners are already aboard (the
    lead is then a pill heading elsewhere, so dropRunnerArrival doesn't
    cover him). Same estimate contract as dropRunnerArrival; 0 once his
    job has finished (planted or released — he has effectively arrived). */
export function raceBatterArrival() {
  const j = pendingRace && pendingRace.batterJob;
  if (!j) return 0;
  for (let i = 0; i < jobs.length; i++)
    if (jobs[i] === j)
      return Math.max(0, j.total - j.s) / RUNNER.SPRINT + .12;
  return 0;                                            // no live job — he's there
}

/** True while a runner job owns `actor`'s body. Game.js checks this before
    hiding the retired batter on a caught fly — a launched runner must be
    left to his own plant-and-jog-off theatre, not vanish mid-stride. */
export function hasRunningJob(actor) {
  for (let i = 0; i < jobs.length; i++) if (jobs[i].a === actor) return true;
  return false;
}

/** Apply the race verdict to occupancy (Game.js then refreshes the HUD).
    SAFE: every runner takes his one-base leg, home crossings score.
    OUT: the lead runner is retired — no bag, no run; the other runners
    keep their forced one-base advancement and the batter takes 1st unless
    HE was the out. Returns runs scored on the paths (witnessed: the pill
    visibly crosses the plate). */
export function applyDropOutcome(safe) {
  if (!pendingRace) return 0;
  const pre = pendingRace.preBases, leadBag = pendingRace.leadBag;
  let runs = 0;
  const nb = [false, false, false];
  for (let i = 2; i >= 0; i--) {
    if (!pre[i]) continue;
    if (!safe && i === leadBag) continue;              // lead runner retired
    const dest = Math.min(i + 1, 3);
    if (dest >= 3) runs++;
    else nb[dest] = true;
  }
  if (safe || leadBag >= 0) nb[0] = true;              // batter held unless he was the out
  ctx.G.bases = nb;
  pendingRace = null;
  stagePending = true;                                 // re-stage once the play settles
  return runs;
}

export function clearRunners() {
  pendingRace = null;                                             // half swap kills any pending race
  pendingSwap = null;                                             // …and any stay-arrival handoff
  staged[0] = staged[1] = staged[2] = null; stagePending = false; // half swap: fielding team never shows runners
  for (let i = jobs.length - 1; i >= 0; i--)                      // half swap: hand every
    release(jobs.splice(i, 1)[0], false);                         // body back, no callbacks
  runnerPool.forEach(r => { r.active = false; r.path = null; r.root.visible = false; r.then = null; });
}
