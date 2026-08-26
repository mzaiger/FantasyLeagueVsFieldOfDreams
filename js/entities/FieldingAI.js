/* =====================================================================
   FieldingAI.js — living alignment, unit reaction, chase behaviour,
   catches, relay throws & visible outs at the bags
   Part of the Lincoln Red Gauntlet engine · js/entities/

   init() receives the shared runtime context so this module stays free
   of circular imports: { defense, ball, G, camCtl, SND, after, now }
===================================================================== */
import * as THREE from 'three';
import { BASE_POS, FIELDING, FENCE_R } from '../core/Constants.js';
import { clamp, easeOut, rand, pick, TAU } from '../utils/MathUtils.js';

let ctx = null;
export function initFielding(context) { ctx = context; }

/* Task 5 #28 — outfield drop race. Game.js (which owns the PA flow and the
   OUT/SAFE arithmetic) registers a hook here at boot; chaseStep calls it at
   the PICKUP moment of a 'drop' outcome so the throw target, flight time and
   verdict are decided where the game state lives. Module-level hook breaks
   the Game.js ↔ FieldingAI import cycle. */
let dropHook = null;
export function setDropHook(fn) { dropHook = fn; }

/* Task D-1 — infield grounder race. Identical contract, second flavour:
   chaseStep calls it at the PICKUP moment of a 'ground' outcome so Game.js
   books the target bag, flight time and OUT/SAFE verdict there (it needs
   the runner estimators, which live across the import cycle in Runners.js).
   Two registrations rather than one polymorphic hook keeps each race's
   contract explicit at both ends. */
let pickupHook = null;
export function setPickupHook(fn) { pickupHook = fn; }

const INFIELD = ['1st Base','2nd Base','3rd Base','Shortstop','Pitcher'];
const CREENERS = ['1st Base','2nd Base','3rd Base','Shortstop'];   // creep in the windup
const OF_ROLES = ['Left Field','Center Field','Right Field'];
const MIDDLE   = ['2nd Base','Shortstop'];

/* Bag-coverage spots: one stride in front of each bag, on the home-plate
   side — the covering fielder presents a target ON the throwing lane
   instead of waiting behind the bag. */
const _bagR = Math.hypot(BASE_POS[0].x, BASE_POS[0].z);
const COVER_1B_X = BASE_POS[0].x * (1 - .85 / _bagR);
const COVER_1B_Z = BASE_POS[0].z * (1 - .85 / _bagR);
const _bag2R = Math.hypot(BASE_POS[1].x, BASE_POS[1].z);
const COVER_2B_X = BASE_POS[1].x * (1 - .85 / _bag2R);
const COVER_2B_Z = BASE_POS[1].z * (1 - .85 / _bag2R);

/* Alignment bookkeeping — regenerated per half / per at-bat.
   Per-frame work below touches only numbers: no allocations in updateFielders. */
let _half = '', _inning = -1, _paOpen = false;
const _focus = new THREE.Vector3();
const _gloveW = new THREE.Vector3();   // scratch: glove world position at catch time

/** Closest defender to point p; optionally infielders only. */
export function nearestDefender(p, infieldOnly = false) {
  let best = null, bd = 1e9;
  for (const pos in ctx.defense) {
    if (infieldOnly && !INFIELD.includes(pos)) continue;
    const d = Math.hypot(ctx.defense[pos].root.position.x - p.x, ctx.defense[pos].root.position.z - p.z);
    if (d < bd) { bd = d; best = ctx.defense[pos]; }
  }
  return { a:best, d:bd };
}

/** Send a fielder running toward the predicted landing spot, and wake the
    rest of the unit: bag coverage on grounders, a converging backup on air balls. */
export function dispatchFielder(f, landP, o, pred) {
  /* Task #68 — landT must live on the SAME clock chaseStep compares against
     (ctx.now() = CLOCK.elapsedTime). predictFlight returns a RELATIVE duration
     (~2-6 s), so storing it raw made `remain` hugely negative on frame one:
     the janitor nulled every chase after ~14 cm and the pace-control / glove
     windows were dead comparisons — no catch or pickup could EVER fire and
     every ball in play resolved SAFE. All chase.landT consumers are internal
     to chaseStep; Game.js keeps its own relative after(landT…) scheduling. */
  f.chase = { target:landP.clone(), landT:ctx.now() + pred.landT, outcome:o, fly:o.type === 'flyout' };
  setAnim(f, 'run');   // route through setAnim like every other pose swap — direct writes bypass the no-thrash guard
  ctx.SND.cleats();
  assignSupport(f, landP, o);
}

/* ---- UNIT REACTION ----------------------------------------------------- */

/** Current hold position of a fielder (alignment spot + shift + OF depth). */
function holdX(f) { const x = f.baseHome.x + f.offX; return f.depthK !== 1 ? x * f.depthK : x; }
function holdZ(f) { const z = f.baseHome.z + f.offZ; return f.depthK !== 1 ? z * f.depthK : z; }

/** Give everyone but the chaser a job the moment a ball is put in play. */
function assignSupport(chaser, landP, o) {
  for (const pos in ctx.defense) ctx.defense[pos].duty = null;   // clear stale jobs
  const until = ctx.now() + 14;

  /* Ground plays — ANY grounder the unit can still make a play on, not just
     pre-decided outs (Task D-1): the race throws to a bag AFTER the pickup,
     so the receiver has to be en route from the moment of contact or the
     ball arrives to nobody. Dropped flies (wasFly singles) stay air-ball
     backups — their race throws from deep, not from the infield. */
  const groundPlay = o.type === 'groundout' || o.type === 'ground' ||
                     ((o.type === 'single' || o.type === 'double') && !o.wasFly);
  if (groundPlay) {
    /* 1st baseman breaks for the bag to take the throw (the pitcher covers
       when the 1st baseman fields it himself). The 2nd baseman takes REAL
       bag coverage on second so a force throw there lands to a receiver
       standing on it; the shortstop only shades halfway — he is the most
       likely chaser for balls hit up the middle. */
    let cover = ctx.defense['1st Base'];
    if (!cover || cover === chaser || cover.onDuty === false) cover = ctx.defense['Pitcher'];
    if (cover && cover !== chaser && cover.onDuty !== false)
      cover.duty = { kind:'bag', x:COVER_1B_X, z:COVER_1B_Z,
                     spd:FIELDING.BAG_SPEED, arrived:false, until };

    for (const role of MIDDLE) {
      const m = ctx.defense[role];
      if (!m || m === chaser || m.onDuty === false) continue;
      if (role === '2nd Base') {
        m.duty = { kind:'bag', x:COVER_2B_X, z:COVER_2B_Z,
                   spd:FIELDING.BAG_SPEED, arrived:false, until };
      } else {
        const hx = holdX(m), hz = holdZ(m);
        m.duty = { kind:'drift', x:hx + (BASE_POS[1].x - hx) * .5, z:hz + (BASE_POS[1].z - hz) * .5,
                   spd:FIELDING.DRIFT_SPEED, arrived:false, until };
      }
    }
  } else {
    /* Air ball: nearest backup converges on the flight path */
    let best = null, bd = 1e9;
    for (const pos in ctx.defense) {
      if (pos === 'Pitcher' || pos === 'Catcher') continue;
      const a = ctx.defense[pos];
      if (a === chaser || a.onDuty === false) continue;
      const d = Math.hypot(a.root.position.x - landP.x, a.root.position.z - landP.z);
      if (d < bd) { bd = d; best = a; }
    }
    if (best) {
      const hx = holdX(best), hz = holdZ(best);
      best.duty = { kind:'backup', x:hx + (landP.x - hx) * .55, z:hz + (landP.z - hz) * .55,
                    spd:FIELDING.BACKUP_SPEED, arrived:false, until };
    }
  }
}

/* ---- ALIGNMENT VARIETY -------------------------------------------------- */

/** Fresh per-at-bat shifts off DEF_SPOTS; outfield depth class re-rolled.
    `resetSettle` also restarts the ~1 s ease (used when actors are re-staged). */
function refreshShifts(resetSettle) {
  for (const pos in ctx.defense) {
    const f = ctx.defense[pos];
    f.duty = null;
    if (pos === 'Pitcher' || pos === 'Catcher') {         // choreographed by Game.js
      f.offX = 0; f.offZ = 0; f.depthK = 1; f.creepA = 0; f.creepCur = 0;
      continue;
    }
    f.offX = rand(-FIELDING.SHIFT_X, FIELDING.SHIFT_X);   // ±1.5 m lateral
    f.offZ = rand(-FIELDING.SHIFT_Z, FIELDING.SHIFT_Z);   // ±1.2 m depth
    f.depthK = OF_ROLES.includes(pos) ? pick(FIELDING.OF_DEPTH) : 1;   // shallow/normal/deep
    f.creepA = CREENERS.includes(pos) ? rand(FIELDING.CREEP_MIN, FIELDING.CREEP_MAX) : 0;
    f.creepCur = 0;
    if (resetSettle || f.settle === undefined) f.settle = 0;
  }
}

/* ---- PER-FRAME UPDATE --------------------------------------------------- */

export function updateFielders(dt) {
  const g = ctx.G;

  /* New half (actors re-staged on the swap) or new at-bat → roll fresh spots */
  const swap = g.half !== _half || g.inning !== _inning;
  if (swap || (_paOpen && !g.paDone)) refreshShifts(swap);
  _half = g.half; _inning = g.inning; _paOpen = !!g.paDone;

  const windup = g.state === 'WINDUP';
  const tnow = ctx.now();

  for (const pos in ctx.defense) {
    const f = ctx.defense[pos];

    /* -- support duty: break for the bag / shade to 2nd / back up the flight -- */
    const du = f.duty;
    if (du && (f.onDuty === false || tnow > du.until)) f.duty = null;
    else if (du) {
      const dx = du.x - f.root.position.x, dz = du.z - f.root.position.z;
      const d = Math.hypot(dx, dz);
      if (d > .3) {
        const sp = Math.min(du.spd * dt, d);
        f.root.position.x += dx / d * sp;
        f.root.position.z += dz / d * sp;
        f.root.rotation.y = Math.atan2(dx, dz);        // face the move
        setAnim(f, du.kind === 'drift' ? 'jog' : 'run');
        du.arrived = false;
      } else {
        if (!du.arrived) { du.arrived = true; setAnim(f, 'ready'); }
        turnToward(f, 0, -6.5, dt);                    // settled: eyes on the plate
      }
      continue;
    }

    /* -- batted-ball chase -- */
    const c = f.chase;
    if (c) { chaseStep(f, c, dt, tnow); continue; }

    /* -- idle life: settle onto the shifted spot; infield creeps in the windup -- */
    if (pos === 'Pitcher' || pos === 'Catcher' || f.onDuty === false) continue;
    if (f.settle < 1) f.settle = Math.min(1, f.settle + dt);
    const es = easeOut(f.settle);
    let hx = f.baseHome.x + f.offX * es, hz = f.baseHome.z + f.offZ * es;
    if (f.depthK !== 1) { hx *= f.depthK; hz *= f.depthK; }          // radial OF depth
    if (f.creepA) {
      f.creepCur += ((windup ? f.creepA : 0) - f.creepCur) *
                    Math.min(1, dt * FIELDING.CREEP_RATE);
      if (f.creepCur > .02) {                          // step toward the plate
        const k = f.creepCur / Math.max(1e-4, Math.hypot(hx, hz));
        hx -= hx * k; hz -= hz * k;
      }
    }
    const dx = hx - f.root.position.x, dz = hz - f.root.position.z;
    const d = Math.hypot(dx, dz);
    /* Glide-walk fix: the settle walk used to play in whatever pose the actor
       had (usually 'idle'), gliding across every at-bat break; owning the pose
       here each frame also recovers fielders whose duty expired mid-travel
       while stuck in 'run'. */
    if (d > .04) {                                     // walk onto the spot, no snap
      const st = Math.min(d, Math.min(FIELDING.SETTLE_SPEED, d * 2.6) * dt);
      f.root.position.x += dx / d * st;
      f.root.position.z += dz / d * st;
      setAnim(f, 'jog');
    } else if (f.animState && f.animState.name !== 'ready') setAnim(f, 'ready');
    turnToward(f, 0, -6.5, dt);
  }
}

/** Low-ball gate for the grounder breakdown ('fieldLow' in
    AnimationController). True only for non-fly chases whose ball is
    demonstrably LOW: rollers and dead balls sit on BallPhysics's .055 ground
    contact line, and a hopping/descending batted ball under ~waist height
    (0.7 m, world metres) gets the same breakdown — so the glove reaches
    DOWN to meet it instead of holding the arms-up catchUp receive. Tall
    hops and liners keep the upright ready/catch vocabulary; flyout chases
    (c.fly) never break down. Live per-frame read: a hop above .7 m stands
    the fielder back up until the ball comes down again. */
function lowChase(b, c) {
  return !c.fly && !c.picked &&
         (b.mode === 'rolling' || b.mode === 'dead' || b.pos.y < .7);
}

/** Chase mechanics + catch & pickup theatre. PACE CONTROL is the heart of
    it: a defender runs at exactly the speed that puts her on the spot
    CATCH_PAD before the predicted landing (bounded by HUSTLE_MAX × base
    sprint), so every out Game.js credits actually ARRIVES — visibly — and
    sets its feet under the descending ball. The grab itself only fires when
    the live ball physically passes over/into the fielder's glove band. */
function chaseStep(f, c, dt, tnow) {
  const b = ctx.ball;

  /* Grounders that get past the spot are chased where the BALL actually is,
     not where prediction said it would land — rollers must be run down.
     Roller-INTERCEPT pursuit (owner ask: grounder chain boring-reliable):
     a tail chase never catches a decaying roller that already broke past the
     fielder — the old point-chase streamed infielders after it until the
     GROUND_SAFETY net booked a no-throw SAFE. Aim AHEAD of the ball instead:
     sample its rolling path (linear 4.4 m/s² decel — the same table
     BallPhysics integrates) for the earliest meeting time this defender can
     make at CHASE_SPEED, and run to THAT spot. Dead/static balls fall back
     to plain point-chase. */
  const ballChased = !c.fly && !c.caught && !c.picked &&
                     (b.mode === 'rolling' || b.mode === 'dead');
  if (ballChased) {
    c.target.x = b.pos.x; c.target.z = b.pos.z;
    if (b.mode === 'rolling' && b.vel.lengthSq() > .04) {
      const v0 = b.vel.length(), ux = b.vel.x / v0, uz = b.vel.z / v0;
      const tStop = v0 / 4.4;
      for (let t = .1; t <= tStop + .1; t += .1) {     // ≤ ~26 samples, arithmetic only
        const s = Math.max(0, v0 * t - 2.2 * t * t);
        const bx = b.pos.x + ux * s, bz = b.pos.z + uz * s;
        const need = Math.hypot(bx - f.root.position.x, bz - f.root.position.z) /
                     FIELDING.CHASE_SPEED;
        /* Feasible meet (.12 pad = plant a beat early), or the ball dies
           before any feasible meet — take the far end of the roll either way */
        if (need <= t + .12 || t >= tStop - .05) { c.target.x = bx; c.target.z = bz; break; }
      }
    }
  }
  const dx = c.target.x - f.root.position.x, dz = c.target.z - f.root.position.z;
  const d = Math.hypot(dx, dz);
  const remain = c.landT - tnow;

  /* Pace control: cover the remaining distance CATCH_PAD ahead of landT.
     need ≤ CHASE_SPEED → normal sprint; up to HUSTLE_MAX when the credit
     was marginal. Never applied to already-decided plays. */
  let top = FIELDING.CHASE_SPEED;
  if (c.fly && !c.caught && remain > FIELDING.CATCH_PAD * .5) {
    const need = d / Math.max(.12, remain - FIELDING.CATCH_PAD);
    if (need > top) top = Math.min(need, FIELDING.CHASE_SPEED * FIELDING.HUSTLE_MAX);
  } else if (ballChased && b.mode === 'rolling' && b.vel.lengthSq() > .04) {
    /* Roller hustle — the ground-ball mirror of fly pace-control: when even
       the intercept point barely closes before the ball gets there, burst to
       HUSTLE_MAX so hard rollers are cut off inside Game.js's GROUND_SAFETY
       window instead of stranding the no-throw SAFE net. tMeet solves
       s(t) = v0·t − 2.2·t² over the ball's run to the intercept point. */
    const along = Math.hypot(c.target.x - b.pos.x, c.target.z - b.pos.z);
    const v0 = b.vel.length();
    const disc = v0 * v0 - 8.8 * along;
    const tMeet = disc > 0 ? (v0 - Math.sqrt(disc)) / 4.4 : v0 / 4.4;
    const need = d / Math.max(.25, tMeet);
    if (need > top) top = Math.min(need, FIELDING.CHASE_SPEED * FIELDING.HUSTLE_MAX);
  }

  if (d > .35) {
    const st = Math.min(top * dt, d);
    f.root.position.x += dx / d * st;
    f.root.position.z += dz / d * st;
    f.root.rotation.y = Math.atan2(dx, dz);   // face the run direction
  } else {
    turnToward(f, b.pos.x, b.pos.z, dt);      // settled: eyes on the ball
    /* Planted but outside the catch window: break the leg pump into the
       athletic crouch — he otherwise sprints IN PLACE for 2+ s on exactly
       the easy fly-outs the owner watches. Window logic below swaps to
       'catch' once his window opens. */
    const winOpen = (c.fly && tnow > c.landT - 1.0) || tnow > c.landT - .5;
    if (!winOpen && !c.caught && !c.picked)
      setAnim(f, lowChase(b, c) ? 'fieldLow' : 'ready');   // breakdown on rollers, crouch for the rest
  }

  /* Glove goes up well before the descent so GripIK can meet the ball in
     the air instead of the ball arriving on a standing figure.
     Grounder fix (owner: "fbx's are raising their hands"): this window used
     to stamp 'catch' — the arms-up catchUp receive — on ANY planted chaser,
     so infielders waited for ROLLERS glove-high and the pickup sucked the
     ball UP into a raised mitt. Non-fly chases now break down into
     POSE.fieldLow whenever the ball is demonstrably low (lowChase below);
     only chest-high receives keep 'catch'. */
  /* !c.picked — once possession is taken these stamps must stop: chaseStep
     keeps running until the janitor stands the chaser down (~.9 s), and an
     unguarded restamp thrashed the pickup plant (and even throwArc's 'throw')
     back to 'catch' every frame. */
  if (c.fly && !c.caught && !c.picked && tnow > c.landT - 1.0 && d < 1.2) setAnim(f, 'catch');
  else if (!c.picked && d <= .35 && tnow > c.landT - .5)
    setAnim(f, lowChase(b, c) ? 'fieldLow' : 'catch');

  /* Fly-catch grabs — strictly physics-honest: the DESCENDING batted ball
     itself must pass over the fielder (glove band), inside the fence. If
     it never does, the drop is real and resolveOutcome will call it that.
     LIVE gate mirrors the pickup guard — a grab after resolveOutcome has
     converted the play at landT+0.4 must read as retrieval, not a
     retroactive OUT under an 'IT DROPS IN!' banner. !b.bounced — a ball
     that already touched dirt is not a clean fly (BallPhysics stamps
     ball.bounced on first batted ground contact; undefined passes
     harmlessly until Package C lands). */
  if (c.fly && !c.caught && ctx.G.state === 'LIVE' && b.mode === 'batted' &&
      b.mesh.visible && !b.bounced &&
      b.vel && b.vel.y < .4 && Math.hypot(b.pos.x, b.pos.z) <= FENCE_R - 1) {
    const bd = Math.hypot(b.pos.x - f.root.position.x, b.pos.z - f.root.position.z);
    if (bd < FIELDING.GLOVE_CATCH_R && b.pos.y > .5 && b.pos.y < 2.8)
      makeCatch(f, c);              // clean catch over the glove
    else if (tnow >= c.landT - .1 && bd < FIELDING.SHOESTRING_R &&
             b.pos.y > .25 && b.pos.y < 1.2)
      makeCatch(f, c);              // shoestring — landing right into him
  }

  /* Ground pickup → throw to the bag. Keyed to the BALL's actual position,
     and gated to a LIVE play or the DEAD aftermath of one — a stale chaser
     from a finished at-bat must never scoop a ball during the next PA's
     READY/WINDUP/PITCH windows (stray-ball race, Stage 4 s4-36/s4-42).
     LIVE + booked outcome = the grounder race (Task D-1): Game.js decides
     target bag / flight / verdict at this instant via pickupHook.
     Task 6 legacy path survives for unbooked balls: a grounder that got
     through resolved DEAD while the ball kept rolling, so the retrieval
     happens in the DEAD window — scoop and flip to the nearest bag, pure
     theatre, no outs (the PA result was already decided). */
  if ((ctx.G.state === 'LIVE' || ctx.G.state === 'DEAD') &&
      !c.caught && !c.picked &&
      (b.mode === 'rolling' || b.mode === 'dead') &&
      Math.hypot(b.pos.x - f.root.position.x, b.pos.z - f.root.position.z) <
        /* Speed-sweep guard: a hard roller crosses the static radius between
           frames when rAF stutters and tunnels PAST a planted fielder. Sweep
           the radius by one frame of ball travel (capped, so a laser hop is
           not vacuum-scooped from metres away). */
        FIELDING.PICKUP_R +
        (b.mode === 'rolling' ? Math.min(1.2, b.vel.length() * dt) : 0)) {
    const live = ctx.G.state === 'LIVE';
    /* Capture BEFORE possession zeroes the ball: a CLEAN gather — roller dead
       or crawling (< 1 m/s, moves < 2 cm/frame inside PICKUP_R) — earns the
       POSE.scoop plant below; hard rollers taken through the speed-sweep keep
       the plain stand-up. */
    const cleanGather = b.mode === 'dead' || b.vel.lengthSq() < 1;
    c.picked = true;
    if (live && c.outcome) c.outcome.picked = true;   // physics-honest: the grounder was actually fielded
    ctx.ball.mode = 'hidden';                          // integration stands down immediately
    ctx.ball.vel.set(0, 0, 0);
    /* Visible possession — the same suck-the-ball-into-the-mitt idiom
       makeCatch uses, so a ground pickup reads as gloved, not teleported:
       the mesh eases into the glove over ~3 frames while the game-side
       hooks already own the (now inert, hidden-mode) ball. */
    gloveWorld(f, _gloveW);
    const gPos = _gloveW.clone();                      // one small alloc per pickup — fine
    const mesh = ctx.ball.mesh, t0 = ctx.now(), dur = .09;
    const suck = () => {
      if (ctx.ball.mode !== 'hidden') return;          // superseded by a new play
      const t = clamp((ctx.now() - t0) / dur, 0, 1);
      mesh.position.lerpVectors(mesh.position, gPos, .45);
      if (t < 1) requestAnimationFrame(suck);
      else { mesh.visible = false; ctx.ball.pos.copy(gPos); }
    };
    requestAnimationFrame(suck);
    ctx.SND.pop();
    if (live) {
      /* Races hand the decision to Game.js at this exact moment (target
         bag, flight time, OUT/SAFE); throwIn then fires whatever the hook
         booked onto the outcome record. */
      if (c.outcome && c.outcome.type === 'drop' && dropHook) dropHook(f, c.outcome);
      else if (c.outcome && c.outcome.type === 'ground' && pickupHook) pickupHook(f, c.outcome);
      /* Plant beat: a booked ground throw leaves only after the gather —
         stand the chaser up out of his run so the plant reads on camera
         before the arm comes over (throwIn delays the arc to match). */
      if (c.outcome && c.outcome.throwBag != null) {
        /* Plant beat, owner scoop opt-in ('scoop' mapped in AnimationController
           driveActor beside catchUp): clean close gathers lean into the ball
           (bent-double POSE.scoop, .6 s) instead of standing straight up;
           throwIn's THROW_GATHER delay shows the first half of the lean before
           the arm comes over. Difficult rollers keep the old read. */
        if (cleanGather) setAnim(f, 'scoop', .6);
        else setAnim(f, 'ready');
      }
      throwIn(f, c.outcome);
    } else {
      throwNearest(f);
    }
    ctx.after(.9, () => {
      f.chase = null;
      if (f.onDuty !== false) setAnim(f, 'ready');
    });
  }

  /* Stray-chase janitor. Drop races live longer: the ball landed where nobody
     could reach it in the air, so the retrieval run itself can take 8+ s —
     drop chases get 16 s before the janitor stands them down (Game.js's
     forceDropSafe no-play net fires at 15 s, just ahead of this). */
  /* Ghost-chase kill: a HIDDEN ball can never be picked up (the pickup block
     requires rolling/dead mode), so chasing one is pure ghosting — e.g. after
     forceGroundSafe hides a roller mid-pursuit. Stand the fielder down the
     instant the ball vanishes. */
  if (!b.mesh.visible || tnow > c.landT + (c.outcome && c.outcome.type === 'drop' ? 16 : 8)) {
    f.chase = null;
    if (f.onDuty !== false) setAnim(f, 'ready');
  }
}

/** Convert the chase into an out: suck the live ball INTO the mitt over a
    few frames (visible possession, no teleport), then hide it and hand the
    result lens to the fielder holding the spot. */
function makeCatch(f, c) {
  c.caught = true;
  if (c.outcome) c.outcome.caught = true;   // physics-honest: the out actually happened
  gloveWorld(f, _gloveW);
  const g = _gloveW.clone();                // one small alloc per caught fly — fine
  ctx.ball.mode = 'hidden';                 // integration stands down immediately
  ctx.ball.vel.set(0, 0, 0);
  const mesh = ctx.ball.mesh;
  const t0 = ctx.now(), dur = .09;
  const suck = () => {
    if (ctx.ball.mode !== 'hidden') { return; }          // superseded by a live play
    const t = clamp((ctx.now() - t0) / dur, 0, 1);
    mesh.position.lerpVectors(mesh.position, g, .45);    // ease toward the pocket
    if (t < 1) requestAnimationFrame(suck);
    else {
      mesh.visible = false; ctx.ball.pos.copy(g);
      /* Result shot lingers on the fielder holding the spot — asserted HERE,
         once the ball is hidden, because main.js forces 'track' every frame
         while the state is LIVE and the ball is visible. */
      _focus.set(f.root.position.x, 1.2, f.root.position.z);
      ctx.camCtl.focus.copy(_focus);
      ctx.camCtl.mode = 'result';
    }
  };
  requestAnimationFrame(suck);
  ctx.SND.pop();
  /* Crowd reacts to WHOSE fielder made the play */
  ctx.G.half === 'top' ? ctx.SND.roar(.45) : ctx.SND.groan();
  relayAfterCatch(f, c);
}

/** Glove anchor in world space — left hand on rigs that have one, chest
    height otherwise. Writes into `out`; chaseStep must stay allocation-free. */
function gloveWorld(f, out) {
  const hand = f.channels && f.channels.handL;
  if (f.bones && hand) return hand.getWorldPosition(out);
  return out.set(f.root.position.x, f.root.position.y + 1.4, f.root.position.z);
}

/* ---- THROWS ------------------------------------------------------------ */

/** After a fly catch: short gather beat, then arc the ball back toward 2nd;
    the covering fielder receives with a visible 'catch'. */
function relayAfterCatch(f, c) {
  const dist = Math.hypot(BASE_POS[1].x - f.root.position.x, BASE_POS[1].z - f.root.position.z);
  const dur = clamp(dist / FIELDING.RELAY_SPEED, .55, 1.5);

  /* Stranded-pose reset: a new PA opening mid-theatre otherwise strands the
     actor in 'run'/'catch' indefinitely — stand him down whenever a guard
     kills the relay. */
  ctx.after(.38, () => {
    if (ctx.ball.mode !== 'hidden') { f.chase = null; setAnim(f, 'ready'); return; }   // a new play started
    /* Same race guard: if the next PA has already opened (READY/WINDUP/
       PITCH), skip the relay re-show entirely — the ball stays hidden. */
    if (ctx.G.state !== 'LIVE' && ctx.G.state !== 'DEAD') { f.chase = null; setAnim(f, 'ready'); return; }
    throwArc(f, BASE_POS[1], dur, () => receive(ctx.defense['2nd Base']));
  });
  ctx.after(.38 + dur + .15, () => {
    f.chase = null;
    if (f.onDuty !== false) setAnim(f, 'ready');
  });
}

/** Ground-ball throw from the fielder's hand to the relevant base.
    Task 5 #28 — dropped-fly races book the LEAD runner's destination bag
    (outcome.dropBag/dropFlight/dropOut). Task D-1 — fielded grounders book
    theirs the same way (outcome.throwBag/throwFlight/throwOut, decided by
    Game.js at the pickup instant from the FIELDING.THROW_* constants);
    their arc leaves after a THROW_GATHER plant beat, which the verdict
    timer already includes. Unbooked throws — clean hits picked up in the
    LIVE window before resolveOutcome converts them ('through the hole'
    singles/doubles carry no race booking) — flip to FIRST: with nobody
    entitled beyond first there is no force and no tag situation at second,
    so firing there read as the owner-reported "throw to second on a base
    hit" oddity. Whoever took the
    nearest bag-cover duty — or the bag's own defender — shows the catch as
    the ball arrives, and a recorded out hands him the result lens. */
function throwIn(f, outcome) {
  const isDrop = !!(outcome && outcome.type === 'drop');
  const booked = !!(outcome && outcome.throwBag != null);
  /* Default of bag 0 (first): the static 'groundout' mapping is legacy-dead
     and the old bag-1 fallback put a live throw to second on every unbooked
     base hit; DEAD-window retrieval keeps throwNearest. */
  const base = isDrop ? outcome.dropBag
             : booked ? outcome.throwBag : 0;
  const dur = isDrop ? outcome.dropFlight
            : booked ? Math.max(.18, outcome.throwFlight - FIELDING.THROW_GATHER)
            : .5;
  const delay = booked && !isDrop ? FIELDING.THROW_GATHER : 0;

  /* Receiver: among fielders with a live BAG duty, the one nearest THIS
     target bag takes it (a ground play covers both corner bags at once);
     otherwise the bag's own defender — and if that happens to be the
     chaser himself, the nearest other defender covers so the receive
     never plays on the thrower. */
  let recv = null, rd = 1e9;
  for (const pos in ctx.defense) {
    const a = ctx.defense[pos];
    if (a === f || !a.duty || a.duty.kind !== 'bag' || a.onDuty === false) continue;
    const d = Math.hypot(BASE_POS[base].x - a.root.position.x,
                         BASE_POS[base].z - a.root.position.z);
    if (d < rd) { rd = d; recv = a; }
  }
  if (!recv) {
    const own = ctx.defense[['1st Base', '2nd Base', '3rd Base', 'Catcher'][base]];
    if (own && own !== f && own.onDuty !== false) recv = own;
    else {
      let bd = 1e9;
      for (const pos in ctx.defense) {
        const a = ctx.defense[pos];
        if (a === f || a.onDuty === false) continue;
        const d = Math.hypot(BASE_POS[base].x - a.root.position.x,
                             BASE_POS[base].z - a.root.position.z);
        if (d < bd) { bd = d; recv = a; }
      }
    }
  }
  /* Aim at the RECEIVER's live spot — bag-centred arcs visibly miss the cover
     (COVER_* spots sit ~0.85-1.2 m closer to the plate than BASE_POS). A
     Game-booked wild roll (o.wildTarget) overrides the aim so the errant
     picture matches the booked error. */
  const aim = outcome && outcome.wildTarget ? outcome.wildTarget
            : recv ? recv.root.position : BASE_POS[base];
  const showOut = (isDrop && outcome.dropOut) || !!(booked && outcome.throwOut);
  const fire = () => {
    /* Same orphan guards as relayAfterCatch: never resurrect the ball into
       another play's window between the booking and the delayed release. */
    if (ctx.ball.mode !== 'hidden') { setAnim(f, 'ready'); return; }   // stranded-pose reset
    if (ctx.G.state !== 'LIVE' && ctx.G.state !== 'DEAD') { setAnim(f, 'ready'); return; }
    throwArc(f, aim, dur, () => {
      receive(recv, showOut);
      /* Turn-two: receiver relays to first for the booked second out; Game.js
         times its DOUBLE PLAY! verdict off the SAME o.dpFlight2 (±.3 s sync,
         arcade-acceptable). Defensive on outcome.doublePlay — inert until
         Package B books it. */
      if (outcome && outcome.doublePlay && recv) {
        const r1 = ctx.defense['1st Base'];
        const a1 = (r1 && r1 !== recv && r1.onDuty !== false) ? r1.root.position : BASE_POS[0];
        ctx.after(.25, () => throwArc(recv, a1,
          Math.max(FIELDING.THROW_MIN, (outcome.dpFlight2 || .8) - .25),
          () => receive(r1 && r1 !== recv ? r1 : ctx.defense['1st Base'], true)));
      }
    });
  };
  delay ? ctx.after(delay, fire) : fire();
}

/** Receiver plays 'catch', then settles back to 'ready' (onDuty-gated).
    Recorded outs hand the result lens to the receiver at the bag. */
function receive(r, showOut) {
  if (!r || r.onDuty === false) return;
  setAnim(r, 'catch');
  if (showOut) {
    _focus.set(r.root.position.x, 1.2, r.root.position.z);
    ctx.camCtl.focus.copy(_focus);
    ctx.camCtl.mode = 'result';
  }
  /* Catcher-audit #3: the Catcher's rest pose is his crouch ('catcher'), not
     'ready' — the blanket restore left him standing for the rest of the half
     after any plate play. Role-aware restore, plus one eased face-the-plate
     beat so he settles looking back at the mound. */
  ctx.after(.55, () => {
    if (r.onDuty === false) return;
    setAnim(r, r.role === 'Catcher' ? 'catcher' : 'ready');
    if (r.role === 'Catcher') turnToward(r, 0, -6.5, .05);
  });
}

/** Post-play (DEAD) retrieval theatre: the stranded ball is scooped and
    flipped to the nearest bag; that bag's defender shows the catch. No
    outcome — the PA result was already decided while the ball rolled. */
function throwNearest(f) {
  let best = 0, bd = 1e9;
  for (let i = 0; i < 3; i++) {
    const d = Math.hypot(BASE_POS[i].x - f.root.position.x, BASE_POS[i].z - f.root.position.z);
    if (d < bd) { bd = d; best = i; }
  }
  const recv = ctx.defense[['1st Base', '2nd Base', '3rd Base'][best]];
  throwArc(f, BASE_POS[best], .55, () => receive(recv, false));
}

/** Shared arced throw: squares the fielder up, plays 'throw', flies the ball
    from hand height to a base over `dur`, glove-snap pop, then `onArrive`. */
function throwArc(f, toBase, dur, onArrive) {
  /* Never re-show the ball into another play's window: a throw that
     outlives its at-bat would otherwise resurrect the ball during the
     next READY/WINDUP/PITCH and strand it mid-flight (Stage 4 race). */
  if (ctx.G.state !== 'LIVE' && ctx.G.state !== 'DEAD') return;
  const from = new THREE.Vector3(f.root.position.x, 1.5, f.root.position.z);
  const to = new THREE.Vector3(toBase.x, 1.2, toBase.z);
  const apex = clamp(from.distanceTo(to) * .04, 1.4, 4.0);
  f.root.rotation.y = Math.atan2(to.x - from.x, to.z - from.z);   // square up to the bag
  f.animState = { name:'throw', start:ctx.now(), dur:.45 };
  ctx.ball.mesh.visible = true; ctx.ball.mode = 'thrown';
  const t0 = ctx.now();
  const HOLD = .20;  // POSE.throw cocks the arm BACK ~.2 s — park the ball on
                     // the hand that long, then compress the arc into the tail
                     // so the ARRIVAL instant (verdicts key off it) never moves.
  const anim = () => {
    if (ctx.ball.mode !== 'thrown') return;            // superseded by a live play
    if (ctx.G.state !== 'LIVE' && ctx.G.state !== 'DEAD') {          // orphaned mid-arc
      ctx.ball.mesh.visible = false; ctx.ball.mode = 'hidden'; return;
    }
    const el = ctx.now() - t0;
    /* Release-desync fix: while the pose is still cocking BACK (el < HOLD)
       glue the ball to the throwing hand instead of flying it — it used to
       leave mid-windup on every relay and booked grounder throw. */
    if (el < HOLD) {
      gloveWorld(f, ctx.ball.pos);                     // park on the hand
      ctx.ball.mesh.position.copy(ctx.ball.pos);
      requestAnimationFrame(anim);
      return;
    }
    const t = clamp((el - HOLD) / Math.max(.06, dur - HOLD), 0, 1);   // compressed tail
    ctx.ball.pos.lerpVectors(from, to, easeOut(t));
    ctx.ball.pos.y += Math.sin(t * Math.PI) * apex;
    ctx.ball.mesh.position.copy(ctx.ball.pos);
    if (el < dur) requestAnimationFrame(anim);
    else {
      ctx.ball.mesh.visible = false; ctx.ball.mode = 'hidden'; ctx.SND.pop();
      if (onArrive) onArrive();
    }
  };
  requestAnimationFrame(anim);
}

/* ---- POSE / FACING HELPERS ---------------------------------------------- */

/** Swap animState only on an actual change so we never thrash pose timers. */
function setAnim(f, name, dur) {
  if (!f.animState || f.animState.name !== name)
    f.animState = dur ? { name, start:ctx.now(), dur } : { name, start:ctx.now() };
}

/** Ease rotation toward facing point (tx,tz) — shortest arc, no snapping. */
function turnToward(f, tx, tz, dt) {
  const want = Math.atan2(tx - f.root.position.x, tz - f.root.position.z);
  let diff = want - f.root.rotation.y;
  while (diff > Math.PI) diff -= TAU;
  while (diff < -Math.PI) diff += TAU;
  f.root.rotation.y += clamp(diff, -6 * dt, 6 * dt);
}
