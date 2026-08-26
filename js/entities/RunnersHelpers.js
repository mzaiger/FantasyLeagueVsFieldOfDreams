/* =====================================================================
   RunnersHelpers.js — TEAM-AWARE FBX base-runner LENDING + legacy-driver
   POLISH KIT
   Part of the Lincoln Red Gauntlet engine · js/entities/

   Goal served here: whenever a runner is shown taking a base, the body
   doing it is a real articulated FBX rig moving through the EXISTING
   actor-job machinery (sendRunner/stepJob) — acceleration out of the
   box, braking into held bags, banked turns, cadence-synced stride, bag
   dust — never the linear easeIO pill lerp. WHICH rig is team-aware
   (owner directive): the Lincoln Fantasy League nine run as THEIR OWN
   roster FBX rigs (Hyle.fbx, Kevo.fbx, Scherz.fbx, … — matched by the
   actor's roster name), while the Field of Dreams club runs on the
   shared Player1.fbx clone pool. Two lending tiers, resolved inside
   lendFBXRunner:

   • side 'lin' → NAMED BENCH ACTORS first. The real homeActors bodies
     (spawned by spawnActor with the roster name, hot-swapped to their own
     FBX by loadFBX) are lent off the bench: never a player currently on
     the field (onDuty), at bat (G.batterIdx slot), standing on-deck
     (lineupOrder next slot / circle position), or otherwise reserved
     (hidden bodies are endPA's invisible redress zone). He VANISHES from
     his bench slot to take the leg, and retire() restores him to his
     exact placeOnBench slot (formula mirrored — Game.js owns the
     original). Falls back to the clone pool when no bench body qualifies.
   • side 'opp' → the Player1 clone pool only (Runners.runnerPool, side
     'opp'), exactly as before.

   lendFBXRunner dispatches through Runners.sendRunner with occupancy
   semantics matching every legacy _sendPill call site (stay-arrival
   swaps, plate charge-throughs, dugout peel-offs). Returns {a, job} or
   null so callers fall back to the legacy pill leg unchanged. This is
   the entry the recommended Runners.js patch calls (see that diff) —
   before it lands the lender stays dormant but fully exercisable via
   window.__RH.lend.

   • enrollRunnerBody / stepPolish — spawned CLONE-POOL bodies get a
     postDrive kit that upgrades them WHILE the legacy pill driver still
     owns them: stride frequency tracks measured ground speed (kills the
     moonwalk the fixed-rate POSE.run produces over the lerp's easeIO
     pacing) and turns bank like stepJob's lean. Ownership is arbitrated
     per frame: stepJob rewrites animState.start on every frame it
     drives, the legacy driver stamps it once at dispatch — a start value
     that differs from what we last wrote means somebody else owns the
     stride, so the kit resyncs and stands down. Named LIN actors are NOT
     enrolled at spawn (they are batters and fielders the rest of the
     engine drives); they get a janitor-only postDrive attached at lend
     time and detached at retire, so the kit can never fight their day
     job.

   Janitor duty: jobs can die WITHOUT their callbacks — clearRunners
   sweeps on a half swap, stageTop cancelRunner's the bench — which would
   strand a lent body's busy-bit forever. A live job rewrites
   animState.start at least every HOLD beat (.55 s worst case; the
   waitRace freeze is dead code — pendingRace is never set), so a tracked
   body whose start has been static >.75 s is externally cancelled: the
   janitor heals the busy-bit and re-stages him (bench slot for named
   rigs — skipped if a half-swap already redeployed him, hidden for
   clones). Separately, a tracked or ext-staged body whose lineup slot
   comes DUE mid-leg is released instantly (dueToBat guard): the PA flow
   owns the batter and his on-deck from that instant, and pickNamed
   prefers far-from-bat bodies up front so the guard rarely fires.

   IMPORT CYCLES, DELIBERATE: PlayerFactory ↔ here, and here →
   Runners.js → PlayerFactory. Safe because every touch of the other
   modules' bindings happens inside functions called after all modules
   finished evaluating (ESM live bindings) — nothing at module-eval time
   reads an imported binding. Mirrors how Game.js already breaks cycles
   with ctx injection rather than restructuring imports.

   Zero per-frame allocation: per-body state lives in the WeakMap,
   allocated once at enrollment/lend time; the step touches numbers and
   scratch fields only.
===================================================================== */
import * as THREE from 'three';
import { clamp, now } from '../utils/MathUtils.js';
import { BASE_POS, LIN, POSITIONS } from '../core/Constants.js';
import { G } from '../core/GameState.js';
import { roster, lineupOrder } from './RosterManager.js';
import { sendRunner, cancelRunner, runnerPool, isExtStaged,
         unstageExternal, stageHolder, replaceStage } from './Runners.js';
import { ACTORS } from './PlayerFactory.js';

/* ---- Tuning mirrors (keep in step with Runners.RUNNER / POSE) ----------
   Copied rather than imported so this module stays a leaf over Runners.js
   data: NAT_* are the POSE.run/jog stride frequencies (ph*11 / ph*7),
   V_* the cruise speeds those frequencies were tuned against. ---------- */
const NAT_RUN = 11, NAT_JOG = 7;
const V_RUN   = 9.3, V_JOG   = 7.0;      // RUNNER.SPRINT / RUNNER.TROT
const LEAN    = .048, LEAN_MAX = .13;    // RUNNER.LEAN / RUNNER.LEAN_MAX

/* body → per-body kit state / lent-job tracking (allocated once each) */
const polish = new WeakMap();            // clone-pool bodies, enrolled at spawn
const tracked = new WeakMap();           // LENT bodies: { job, ownDrive, ls, lt, bag }
const extStaged = new WeakMap();         // NAMED rigs holding an earned bag → their staged spot

/** Clone-pool bodies are the ones Runners.createRunners named — the only
    actor names anywhere carrying the ' Runner N' suffix. */
const runnerName = n => / Runner \d$/.test(n || '');

/** TRUE when this body's lineup slot has come DUE — he is the batter or the
    on-deck hitter RIGHT NOW. The PA flow (endPA's on-deck staging, then
    startAtBat's plate staging) owns him from that instant, so any lent leg
    or bag claim must be released immediately; otherwise Game walks him to
    the plate while a job still drives him around the basepaths and two
    owners fight over his position every frame — the "players keep changing
    at the plate" symptom. G.batterIdx is the LIN lineup slot exactly when
    LIN bats, which is the only case we ever lend in. */
function dueToBat(a) {
  if (G.half !== 'bottom') return false;
  const batName = roster[lineupOrder[G.batterIdx]];
  const odName  = roster[lineupOrder[(G.batterIdx + 1) % 9]];
  return a.name === batName || a.name === odName;
}

/* ======================================================================
   POLISH KIT — legacy-driven clone bodies (enrolled at spawn)
====================================================================== */

/** Enroll a runner-pool CLONE. Called from PlayerFactory.spawnVisitorActor
 *  at spawn time — the ONLY creation seam for the pool. Named roster
 *  actors never come through here (spawnActor path), by design. */
export function enrollRunnerBody(a, name) {
  if (!a || !a.root || !runnerName(name) || polish.has(a)) return;
  polish.set(a, {
    lastPos: a.root.position.clone(),    // ground-speed baseline
    lastYaw: 0,                          // yaw-rate baseline (banking)
    phase: 0,                            // stride-phase accumulator (rad)
    lastStart: -1,                       // animState.start as WE last saw/wrote it
    lean: 0,                             // current applied root roll (rad)
  });
  a.postDrive = dt => stepPolish(a, dt); // Actor.update calls this after channel drive
}

/** Per-frame kit for ONE body. Numbers only — see header. */
function stepPolish(a, dt) {
  if (!dt) return;

  /* -- lent bodies: due-bat guard first, then janitor only — stepJob owns
        every animation channel while a job lives -- */
  const trk = tracked.get(a);
  if (trk) {
    if (dueToBat(a)) {                   // his at-bat came due mid-leg — release NOW,
      cancelRunner(a);                   // silently (no callbacks, no vanish): the PA
      tracked.delete(a);                 // flow is about to stage him to the plate and
      a.active = false;                  // must not find a job still fighting for him
      a._lent = false;
      extStaged.delete(a);
      unstageExternal(a);                // never keep a bag claim against the lineup
      if (trk.ownDrive) a.postDrive = null;
      restoreBench(a);                   // wait home until startAtBat walks him in
      return;
    }
    const an = a.animState;
    if (an && an.start !== trk.ls) { trk.ls = an.start; trk.lt = now(); }
    else if (now() - trk.lt > .75) retire(a);   // job died without callbacks (see header)
    return;
  }

  /* -- ext-staged watcher: named rig holding an earned bag ---------------
     Runs only while reconcileStaging still lists him; the moment the bag
     vacates, the club flips, or _sendPill un-stages him to lend his next
     leg, the hook says no and this re-benches (or stands down for the
     new leg). */
  const es = extStaged.get(a);
  if (es) {
    /* Grace window: the batter-runner claims his bag in the SAME frame his
       endPA runs, but the verdict-hold paths claim him BEFORE Game advances
       the lineup — without the grace the due-guard would bench a man who is
       literally mid-arrival on HIS OWN earned bag (the "vanishing walker"). */
    if (dueToBat(a) && now() - es.t > 1.0) {     // earned bag vs due bat: the bat wins —
      unstageExternal(a);                // free the claim; the reconcile re-stages whoever belongs
      extStaged.delete(a);
      const p = a.root.position;
      if (Math.hypot(p.x - es.x, p.z - es.z) < .5 && !tracked.has(a)) {
        a.postDrive = null;              // still planted where we parked him and Game hasn't come
        restoreBench(a);                 // yet — bench him BEFORE startAtBat walks him in from home.
      }                                  // Else endPA's on-deck/plate staging already moved him:
      return;                            // hands off, Game owns the body from that instant.
    }
    if (isExtStaged(a)) return;          // still the stager — idle stance already set
    extStaged.delete(a);
    if (tracked.has(a)) return;          // re-lent — the leg owns him from here
    a.postDrive = null;                  // watcher off
    restoreBench(a);
    return;
  }

  const st = polish.get(a);
  if (!st) return;
  const an = a.animState;
  if (!an) return;
  const p = a.root.position;
  const run = an.name === 'run', jog = an.name === 'jog';

  /* -- off-duty: bleed the bank out, resync baselines -------------------- */
  if (!run && !jog) {
    if (st.lean) {
      st.lean -= st.lean * Math.min(1, dt * 7);
      if (st.lean * st.lean < 1e-5) st.lean = 0;
      a.root.rotation.z = st.lean;
    }
    st.phase = 0;
    st.lastStart = an.start;
    st.lastPos.copy(p);
    st.lastYaw = a.root.rotation.y;
    return;
  }

  /* -- ownership arbitration (see header) -------------------------------- */
  if (an.start !== st.lastStart) {       // dispatched/re-staged/re-owned this frame
    st.lastStart = an.start;
    st.lastPos.copy(p);
    st.lastYaw = a.root.rotation.y;
    st.phase = now() - an.start;         // continue his phase, don't restart the cycle
    return;
  }

  /* -- cadence sync: stride rate follows MEASURED ground speed ----------- */
  const dx = p.x - st.lastPos.x, dz = p.z - st.lastPos.z;
  const moved = Math.hypot(dx, dz);
  st.lastPos.copy(p);
  if (moved > 4) return;                 // seat/teleport, not locomotion — never convert to speed
  const nat = run ? NAT_RUN : NAT_JOG;
  const vRef = run ? V_RUN : V_JOG;
  st.phase += dt * nat * clamp(moved / Math.max(dt, 1e-3) / vRef, .25, 1.35);
  an.start = now() - st.phase;           // same rewrite trick stepJob uses
  st.lastStart = an.start;               // …and claim ownership of the value we wrote

  /* -- banking: roll into the turn from the wrap-safe yaw rate ----------- */
  let dyaw = a.root.rotation.y - st.lastYaw;
  while (dyaw > Math.PI) dyaw -= Math.PI * 2;
  while (dyaw < -Math.PI) dyaw += Math.PI * 2;
  st.lastYaw = a.root.rotation.y;
  const leanT = moved > .004 ? clamp(-dyaw / Math.max(dt, 1e-3) * LEAN, -LEAN_MAX, LEAN_MAX) : 0;
  st.lean += (leanT - st.lean) * Math.min(1, dt * 7);
  a.root.rotation.z = st.lean;
}

/* ======================================================================
   LENDER — team-aware body pick, then one sendRunner leg
====================================================================== */

/** Free CLONE pick: staged (visible) bodies win ties so the runner standing
    on the origin bag is the one who advances — the steal/force reads as
    THAT runner taking his base, exactly the identity trick getRunner uses
    for pills. Hidden bodies rank by raw distance to the origin bag. */
function pickClone(sideKey, from) {
  let body = null, best = 1e9;
  for (let i = 0; i < runnerPool.length; i++) {
    const r = runnerPool[i];
    if (r.side !== sideKey || r.active || !r.ready || tracked.has(r)) continue;
    const d = Math.hypot(r.root.position.x - from.x, r.root.position.z - from.z)
            + (r.root.visible ? 0 : 40);
    if (d < best) { best = d; body = r; }
  }
  return body;
}

/** NAMED LIN bench pick — a REAL roster rig (his own loaded FBX, matched by
    the actor name) borrowed off the bench. Eligibility, hardest exclusions
    first: on the field (onDuty — prepFielder sets it, placeOnBench clears
    it), at bat or on-deck (the live lineup slots; G.batterIdx is the LIN
    slot whenever LIN is batting, which is the only case we lend for),
    reserved-invisible (endPA redresses retired batters while hidden), or
    loitering in the on-deck circle. Only while LIN actually bats — in the
    top half these same bodies ARE the fielding nine. */
function pickNamed(from) {
  if (G.half !== 'bottom') return null;
  const batName = roster[lineupOrder[G.batterIdx]];
  const odName  = roster[lineupOrder[(G.batterIdx + 1) % 9]];
  let best = null, bestS = -1e9;
  for (let i = 0; i < ACTORS.length; i++) {
    const a = ACTORS[i];
    if (a.team !== LIN || !a.ready || a.onDuty || tracked.has(a)) continue;
    if (runnerName(a.name)) continue;                       // never lend the clone pool here
    if (a.name === batName || a.name === odName) continue;  // the hitter and his on-deck are untouchable
    if (!a.root.visible) continue;
    if (Math.hypot(a.root.position.x + 6.5, a.root.position.z - 3.5) < 1.6) continue;
    /* Prefer bodies whose turn at the plate is FARTHEST away: a lent leg can
       outlast several PAs while the lineup advances, so picking the guy due
       up next-next means yanking him off a basepath for his own at-bat (the
       dueToBat guard catches that late — this avoids needing it at all).
       Pitcher/Manager sit outside lineupOrder entirely ⇒ due 99 ⇒ ideal
       runners. Due-distance dominates; proximity to the bag breaks ties. */
    const slot = lineupOrder.indexOf(a.role);
    const due  = slot < 0 ? 99 : (slot - G.batterIdx + 9) % 9;
    const d = Math.hypot(a.root.position.x - from.x, a.root.position.z - from.z);
    const s = due * 100 - d;
    if (s > bestS) { bestS = s; best = a; }
  }
  return best;
}

/** Seat a NAMED LIN bench rig as the between-play stager of bag `i` — the
 *  reconcile's first choice whenever Lincoln bats and a bag is occupied but
 *  unclaimed (unopposed arrivals, post-sweep re-parks, boot windows). This
 *  closes the gap the retire()-side hook couldn't: most safe arrivals END
 *  their job via an external sweep rather than a swapped onDone, so without
 *  this the reconcile fell through to the clone pool and a Player1 stand-in
 *  wore Lincoln's basepath (owner rule: never while LIN hits). Claim comes
 *  first — never move a body whose slot we failed to take. The ext-staged
 *  watcher branch of stepPolish re-benches him when the reconcile later
 *  drops the claim (bag vacated, club flip, re-lend). Event-gated callers
 *  only — never per-frame.
 *  @returns true when a named rig now holds the slot; false ⇒ clone fallback */
/** Arm the ext-stage drop-watcher on `a` and settle him into an idle
 *  stager stance. Shared by every named-staging entry point. */
function extArm(a) {
  a.root.visible = true;
  a.root.rotation.z = 0;
  if (!a.animState || a.animState.name !== 'idle')
    a.animState = { name: 'idle', start: now() };
  if (!a.postDrive) a.postDrive = dt => stepPolish(a, dt);   // drop-watcher (see header)
}

/** Claim bag `i` for named rig `a` (replaceStage + watcher). Records
 *  the spot he was parked at so the due-bat guard can tell "Game already
 *  claimed and moved him" (stand down silently — Game owns the body) from
 *  "still planted where we left him" (safe to bench before startAtBat
 *  comes for him). Event-gated callers only. */
export function claimExtStage(a, i) {
  const prev = replaceStage(i, a);
  if (prev === undefined) return false;     // malformed request or a live flight owns the slot
  if (prev) {                               // evict the resting holder quietly:
    if (runnerName(prev.name)) {            // clone → straight back to the pool;
      prev.active = false;
      prev.root.visible = false;
    }                                       // named evictee: his drop-watcher notices
  }                                         // isExtStaged()==false next frame → re-benches himself
  const p = a.root.position;
  extStaged.set(a, { x: p.x, z: p.z, t: now() });   // t = grace start for the due-bat guard
  extArm(a);
  return true;
}

export function seatNamedStager(i, pos, yaw) {
  const a = pickNamed(pos);
  if (!a) return false;
  a.root.position.set(pos.x, 0, pos.z);
  a.root.rotation.set(0, yaw, 0);
  a.active = false;                      // resting stager — mirrors keepStaged's pill state
  a._lent = false;
  return claimExtStage(a, i);            // claim LAST so the recorded spot is where he stands
}

/**
 * Route one base-to-base hop through the REAL actor-job system on a
 * team-appropriate rig: LIN bats → a real bench roster rig (own FBX),
 * FOD bats → a Player1 clone; clones stay the fallback when the LIN bench
 * has no eligible body.
 * @param {'lin'|'opp'} sd  batting side (pass Runners' module `side`)
 * @param {number} fromIdx  BASE_POS index the leg starts from (may exceed 3)
 * @param {number} toIdx    BASE_POS index of the destination bag (ditto)
 * @param {boolean} jog     relaxed pace (walks/trots) vs sprint
 * @returns {{a: Actor, job: object}|null}  null ⇒ caller falls back to the
 *          legacy pill leg (no eligible body yet, or malformed request).
 *
 * Semantics mirrored from the _sendPill call sites:
 *  • scoring legs (dest home) charge THROUGH the plate (round) then peel
 *    off to the dugout inside sendRunner's own exit choreography;
 *  • safe arrivals hold stay:true so a planted arrival on an occupied bag
 *    vanishes right there into the staging pendingSwap handoff (the pool
 *    stager replaces him at his exact footprints), and a bag that went
 *    dark mid-play degrades to the classic jog-off;
 *  • the caller-visible contract (then-callbacks ride the BATTER leg, not
 *    these) is preserved because every inherited-runner dispatch passes
 *    then:null already.
 */
export function lendFBXRunner(sd, fromIdx, toIdx, jog = false, then = null) {
  const sideKey = sd === 'opp' ? 'opp' : 'lin';
  const dest = ((toIdx % 4) + 4) % 4;
  const from = BASE_POS[((fromIdx % 4) + 4) % 4];
  let named = null;
  if (sideKey === 'lin') {
    /* CONTINUITY FIRST: whoever HOLDS the origin staging slot IS that
       runner — he takes his own advance leg (owner rule: "no random one";
       the due-distance scan below would sometimes hand his leg to a farther
       bench rig, stranding his identity and his slot claim). Only a holder
       who is ineligible (on duty / hidden / mid-leg / due to bat) falls
       through to the general bench scan. */
    const cur = stageHolder(((fromIdx % 4) + 4) % 4);
    named = (cur && cur.team === LIN && cur.ready && !cur.onDuty && !tracked.has(cur) &&
             cur.root.visible && !runnerName(cur.name) && !dueToBat(cur))
          ? cur : pickNamed(from);
  }
  const body = named || pickClone(sideKey, from);
  if (!body) return null;
  const isNamed = !!named && !runnerName(body.name);

  /* Seat him at the origin bag: one relaxed step behind it on the home
     line (STAGE_SPOT's construction) — or in the RH batter's box when the
     leg STARTS at home. Bench bodies vanish from their slot to serve
     (the bench visibly loses him); buildRun runs from wherever he stands. */
  if (Math.hypot(body.root.position.x - from.x, body.root.position.z - from.z) > 2.5 ||
      !body.root.visible) {
    if (from.x === 0 && from.z === 0) body.root.position.set(1.0, 0, 1.6);
    else {
      const l = Math.hypot(from.x, from.z);
      body.root.position.set(from.x * (1 - 1.05 / l), 0, from.z * (1 - 1.05 / l));
    }
    body.root.rotation.y = Math.atan2(-from.x, -from.z);   // face up the base path
  }
  body.root.visible = true;
  body.active = true;                    // pill busy-bit: getRunner / staging reconcile /
  body._lent = true;                     // quiet-check all skip him while the job runs

  const legs = [];
  for (let j = fromIdx + 1; j <= toIdx; j++) legs.push(((j % 4) + 4) % 4);
  const scores = dest === 3;
  const job = sendRunner(body, legs.length ? legs : [((fromIdx + 1) % 4 + 4) % 4], {
    jog: !!jog,
    round: scores,
    stay: !scores,
    /* `then` rides the lent leg when the caller's callback was headed for a
       pill that we replaced (the batter-leg fallbacks pass endPA here).
       retire() parks the body FIRST so the PA flow never stages over a
       still-busy lent rig. */
    onDone: () => { retire(body); then && then(); },
  });
  if (!job) {                            // malformed request — hand him back untouched
    body.active = false;
    body._lent = false;
    body.root.visible = false;
    return null;
  }
  /* Janitor hook for named rigs (clones carry the enrolled kit already):
     attached ONLY for the leg's lifetime, animation-inert while the job
     lives (see the tracked branch of stepPolish). */
  const ownDrive = !body.postDrive;
  if (ownDrive) body.postDrive = dt => stepPolish(body, dt);
  /* bag: the arrival bag he may keep as a NAMED stager on a swapped stay-
     arrival (scoring legs and retirements never stage). */
  tracked.set(body, { job, ownDrive, ls: job.a.animState.start, lt: now(),
                      bag: scores ? null : dest });
  return { a: body, job };
}

/** Hand a finished lent body back: named roster rigs re-stage to their
    exact placeOnBench slot (formula mirrored from Game.js — Game owns the
    original; same constants, same parity), clones rest hidden. Called
    from sendRunner's onDone (after the stay-swap vanish OR the dugout
    jog-off) and by the janitor on external sweeps. */
function retire(a) {
  const trk = tracked.get(a);
  tracked.delete(a);
  a.active = false;                      // back to pill duty / bench eligibility
  a._lent = false;
  if (runnerName(a.name)) {              // clone → rest hidden
    if (trk && trk.ownDrive) a.postDrive = null;
    a.root.visible = false;
    return;
  }
  /* Named rig who reached base SAFELY on a swapped stay-arrival: keep the
     SAME roster rig on the bag he earned — he becomes the between-play
     stager (owner rule: Lincoln's runners are Lincoln's players, never
     clone stand-ins). release() has already vanished him at the bag;
     re-show him there in an idle stance. The watcher branch of
     stepPolish re-benches him when the reconcile drops him (bag vacated /
     club flip) or _sendPill un-stages him to lend his next leg. */
  if (trk && trk.bag != null && trk.job.swapped &&
      G.half === 'bottom' && !a.onDuty &&
      claimExtStage(a, trk.bag)) {
    return;                              // postDrive STAYS attached as the watcher
  }
  if (trk && trk.ownDrive) a.postDrive = null;           // detach the janitor-only hook
  restoreBench(a);
}

/** Bench restore — mirrors Game.placeOnBench exactly (Game owns the
    original; same constants, same parity). Never fights a half-swap that
    already redeployed him (top half: he IS a fielder again; onDuty says
    so) — the sweep owns his placement then. */
function restoreBench(a) {
  if (G.half !== 'bottom' || a.onDuty) return;
  const i = POSITIONS.indexOf(a.role);
  if (i < 0) { a.root.visible = false; return; }
  const sd = i % 2 ? 1 : -1, row = Math.floor(i / 2) % 3;
  a.root.position.set(sd * (14.3 + row * 1.15), 0, Math.min(-5.8, -7.6 + ((i * 2) % 3) * 1.2));
  a.root.rotation.y = -sd * 1.25;
  a.root.rotation.z = 0;
  a.onDuty = false;
  a.root.visible = true;
  a.animState = { name: 'idle', start: now() };
}

/* ---- QA affordance -----------------------------------------------------
   window.__RH lets a harness exercise the lender before the Runners.js
   patch routes production traffic through it, and inspect both fleets:
   __RH.lend('lin', 3, 1)  → a REAL bench rig (Hyle/Kevo/…) sprints home→1st
   __RH.lend('opp', 3, 1)  → a Player1 clone takes the same leg
   __RH.pool()             → clone fleet state
   __RH.named()            → LIN roster bodies with lendability flags */
if (typeof window !== 'undefined') {
  window.__RH = {
    lend: (s, f, t, j) => lendFBXRunner(s, f, t, j),
    pool: () => runnerPool.map(r => ({
      n: r.name, side: r.side, act: !!r.active, vis: !!r.root.visible,
      rig: r.rigName || null, anim: r.animState ? r.animState.name : ''
    })),
    named: () => {
      const batName = roster[lineupOrder[G.batterIdx]];
      const odName  = roster[lineupOrder[(G.batterIdx + 1) % 9]];
      return ACTORS.filter(a => a.team === LIN && !runnerName(a.name)).map(a => ({
        n: a.name, role: a.role, duty: !!a.onDuty, vis: !!a.root.visible,
        rig: !!a.bones, lent: tracked.has(a),
        why: a.name === batName ? 'bat' : a.name === odName ? 'ondeck' : null
      }));
    },
  };
}
