/* =====================================================================
   Game.js — composition root & game director: team deployment, at-bat
   flow, swing resolution, outcome choreography, innings, input.
   Part of the Lincoln Red Gauntlet engine · js/core/
===================================================================== */
import * as THREE from 'three';
import {
  LIN, POSITIONS, DEF_SPOTS, RELEASE, WINDUP_DUR, FINAL_INNINGS, MAX_INNINGS,
  FENCE_R, FIELDING, BASE_POS
} from './Constants.js';
import { G } from './GameState.js';
import { OPP, roster, lineupOrder, oppFielders, OPP_PITCHER_NAME } from '../entities/RosterManager.js';
import { spawnActor, spawnVisitorActor, attachGear, Actor } from '../entities/PlayerFactory.js';
import { initFielding, nearestDefender, dispatchFielder, setDropHook, setPickupHook } from '../entities/FieldingAI.js';
import { initRunners, createRunners, sendRunner, advanceHit, forceAdvance, trotHR, clearRunners, setRunnerSide, cancelRunner,
         startDropTheatre, dropRunnerArrival, applyDropOutcome, raceBatterArrival, hasRunningJob,
         isExtStaged } from '../entities/Runners.js';
import { camCtl, punchCam } from './CameraSystem.js';
import { ball, predictFlight, syncBall, hideBall } from '../physics/BallPhysics.js';
import { tryBeginReplay } from './ReplaySystem.js';
import { FX } from '../effects/ParticleSystem.js';
import { SND } from '../audio/AudioManager.js';
import { fxCheer } from '../animation/AnimationController.js';
import { UI, banner, toast, refreshHUD, setBtn, distPopup, buildDrawer, setBatterIdxSource } from '../ui/HUDController.js';
import * as PitchPicker from '../ui/PitchPicker.js';
import { after, now, rand, rint, pick, clamp, TAU, DEG, $ } from '../utils/MathUtils.js';

/* ======================================================================
   TEAM DEPLOYMENT
====================================================================== */
export const defense = {};
export const homeActors = {};

/* Half-swap staging tables — `defense` itself is mutated in place so every
   subsystem holding a reference (FieldingAI ctx, debug handles) stays live. */
const DEF_KEYS = Object.keys(DEF_SPOTS);
const homeFielders = {};   // position -> our actor (takes the field in the top half)
const visitorNine = {};    // position -> visiting actor (fields in the bottom half)
const oppOrder = Object.keys(oppFielders).filter(p => p !== 'Pitcher' && p !== 'Manager');
let oppBatter = null;      // dedicated visiting hitter — one actor, reused all half
let oppIdx = 0;            // visiting lineup slot (independent of G.batterIdx)

/** Stage any actor at its defensive spot — shared by BOTH clubs on a swap.
    ALWAYS re-asserts root.visible: an actor can arrive here hidden (e.g. the
    finished batter that resolveOutcome concealed on a putout), and deploying
    him invisible leaves a ghost defender nobody can see making plays. */
function prepFielder(a, pos) {
  a.role = pos;
  a.chase = null;
  a.onDuty = true;           // lets FieldingAI skip pose-restores after a swap
  a.root.visible = true;
  a.baseHome = new THREE.Vector3(DEF_SPOTS[pos][0], 0, DEF_SPOTS[pos][1]);
  a.root.position.copy(a.baseHome);
  /* Half-change softening (SEV-2 audit): incoming FIELDERS enter 3.2 m up
     the line from their spot toward their side's dugout mouth and settle-
     walk the gap during the swap toast — FieldingAI.updateFielders owns the
     walk at SETTLE_SPEED 2.4 m/s (~1.35 s), and the first pitch is gated
     ≥~2.5 s out by startAtBat's jog-in, so the gap always closes on camera.
     The battery is exempt: the pitcher's rubber reset and the catcher's
     reception geometry are both tuned around exact staging. */
  if (pos !== 'Pitcher' && pos !== 'Catcher') {
    const mx = a.baseHome.x >= 0 ? 16.5 : -15.4, mz = -7.3;    // 1B / 3B dugout mouths
    const dx = mx - a.baseHome.x, dz = mz - a.baseHome.z, dl = Math.hypot(dx, dz) || 1;
    a.root.position.x += dx / dl * 3.2;
    a.root.position.z += dz / dl * 3.2;
  }
  a.root.rotation.y = pos === 'Pitcher' ? 0 : Math.atan2(-a.baseHome.x, -6.5 - a.baseHome.z);   // face the plate
  a.animState = { name:pos === 'Catcher' ? 'catcher' : 'ready', start:now() };
  setBatVisible(a, false);   // no bats in the field
  addGlove(a, pos === 'Catcher');
  setGloveVisible(a, true);  // mitts back on for everyone taking the field
}

/* A bat is costume once a lineup hitter pulls on fielding duty */
function setBatVisible(a, on) {
  if (a._bat === undefined) {
    a._bat = null;
    a.root.traverse(o => { if (!a._bat && o.name === 'bat') a._bat = o; });
  }
  if (a._bat) a._bat.visible = on;
}

/* Same costume rule for the fielding mitt — batters hit bare-handed and
   glove up again the moment they pull on fielding duty (see prepFielder). */
function setGloveVisible(a, on) {
  if (a._glove === undefined) {
    a._glove = null;
    a.root.traverse(o => { if (!a._glove && o.name === 'mitt') a._glove = o; });
  }
  if (a._glove) a._glove.visible = on;
}

function addGlove(a, catcher) {
  if (a._gloved || a.opts.glove) { a._gloved = true; return; }
  a._gloved = true;
  a.opts.glove = true;       // so a later FBX hot-swap re-attaches it automatically
  a.opts.catcherMitt = !!catcher;
  attachGear(a, { glove:true, cap:false, bat:false, catcher:!!catcher });
}

/* Visiting clubs dress from the SHARED Mixamo rig (Player1.fbx only — user
   directive with the Field-of-Dreams roster): loaded once in PlayerFactory,
   cloned per player via skeletonClone so every visitor owns independent
   bones. HumanoidTeam.js stays on disk but is no longer imported anywhere —
   dead-code backlog. attachGear still dresses them (glove for fielders, bat
   for the hitter); FBX rigs ship their own heads, so headwear is never
   attached to them (same rule as LIN). */
function spawnVisitor(name, opts = {}) {
  return spawnVisitorActor(name, OPP, opts);
}

export function deployTeams() {
  /* Visiting nine take the field (Lincoln bats the bottom half first) */
  for (const pos of DEF_KEYS) {
    const a = spawnVisitor(oppFielders[pos],      { glove:pos !== 'Pitcher', catcherMitt:pos === 'Catcher', height:pos === 'Catcher' ? 1.78 : 1.92 });   // catcher-audit #4: 1.6 left his mitt at y≈.80 vs zone tops 1.75
    visitorNine[pos] = a;
    prepFielder(a, pos);
    defense[pos] = a;
  }

  /* Home nine on the bench */
  POSITIONS.forEach((pos, i) => {
    const a = spawnActor(roster[pos], LIN, { bat:lineupOrder.includes(pos), num:(i * 7) % 99 + 1 });
    a.role = pos;
    homeActors[roster[pos]] = a;
    homeFielders[pos] = a;
    placeOnBench(a, i);
  });

  /* Dedicated visiting hitter — lives for the whole game, bats every top half */
  oppBatter = spawnVisitor(oppFielders[oppOrder[0]],    { bat:true });
  oppBatter.root.visible = false;

  /* Their skipper watches from the 1B dugout mouth (cosmetic — no play role;
     stageTop/stageBottom only re-stage visitorNine/oppBatter, so he stays put) */
  const oppManager = spawnVisitor(oppFielders['Manager'], {});
  placeOnVisitorBench(oppManager, 9);

  createRunners();
  setBatterIdxSource(() => G.half === 'top' ? -1 : G.batterIdx);

  /* Lead-off hitter steps up */
  batter = homeActors[roster[lineupOrder[0]]];
}

/* Bench seats (SEV-2 audit fix): 11 roster actors used to collapse onto only
   6 unique coordinates (index i and i+6 shared a spot — census caught
   Doug/Hyle/Josh stacked at (-14.3,-7.6)). Each side now owns private seats
   spread ALONG its dugout band: six on the 3B side, five on the 1B side.
   Every seat is ≥0.9 m from its neighbours AND from every legacy-formula
   point — RunnersHelpers.restoreBench (frozen) still mirrors the OLD
   formula, so a lent body handed back mid-half lands NEAR the group, never
   on top of a teammate, until his next placeOnBench sweep re-seats him.
   All seats verified inside both parks' dugout builds: Oracle's carve
   (arm-frame u ≈ 12.2-16.2 of 11.5-19.3, cross -2.35..-0.75 of -3.4..1.7)
   and FOD's planks (±0.9 m of the plank centreline at (±15.5,-7.2)). */
const BENCH_SPOTS = [
  [14.78, -5.83], [16.65, -6.81], [13.75, -5.85],       // seats 1-3, both sides
  [17.23, -7.50], [16.32, -7.67], [16.94, -8.39]        // seat 6 is 3B-side only
];
export function placeOnBench(a, i) {
  const side = i % 2 ? 1 : -1, k = Math.min(Math.floor(i / 2), 5);
  const spot = BENCH_SPOTS[k];
  a.onDuty = false;
  a.root.position.set(side * spot[0], 0, spot[1]);
  a.root.rotation.y = -side * 1.25;
  a.animState = { name:'idle', start:rand(0, 9) };
}

/* Visiting nine idle INSIDE the 1B shell (it ends at x=19.3) — the old
   first-base-line staging (x up to 24.2) sat on open foul ground past the
   shell edge and stacked onto its roof line from track-cam angles */
function placeOnVisitorBench(a, i) {
  a.onDuty = false;
  a.root.position.set(17.2 + (i % 3) * 0.9, 0, -8.9 + (i % 5) * 0.55);   // inside the 1B shell, clear of home bench slots (|x|≤16.6)
  a.root.rotation.y = Math.atan2(-a.root.position.x, -a.root.position.z);
  a.animState = { name:'idle', start:rand(0, 9) };
}

let batter = null;                                     // Lincoln's current hitter
const activeBatter = () => G.half === 'top' ? oppBatter : batter;
export const getBatter = () => activeBatter();

/* ======================================================================
   HALF SWAP — stage management between innings
====================================================================== */
/** Top of an inning: our nine take the field, the visitors send up a hitter. */
function stageTop() {
  G.half = 'top';
  setRunnerSide('opp');

  /* Visiting nine vacate the field */
  DEF_KEYS.forEach((pos, i) => {
    const a = visitorNine[pos];
    a.chase = null;
    placeOnVisitorBench(a, i);
  });

  /* Our nine deploy */
  for (const pos of DEF_KEYS) {
    const a = homeFielders[pos];
    prepFielder(a, pos);
    defense[pos] = a;
  }

  /* Everybody else goes back to a bench slot — a half that ended mid-PA never
     ran endPA's walk-back, so without this sweep the retired batter (still in
     the box), his on-deck teammate and anyone frozen mid-jog by clearRunners
     would keep standing on the field while the CPU bats. */
  POSITIONS.forEach((pos, i) => {
    if (DEF_KEYS.includes(pos)) return;
    const a = homeActors[roster[pos]];
    cancelRunner(a);                    // never re-stage a body a runner job owns
    a.chase = null;
    setBatVisible(a, true);
    placeOnBench(a, i);
    a.root.visible = true;
  });

  /* Their hitter strides in (bench twin ducks out of sight) */
  setOppBatter(oppOrder[oppIdx]);

  toast(`▲ ${G.inning} — ${OPP.city.toUpperCase()} ${OPP.nick.toUpperCase()} batting`);
  refreshHUD();
  SND.chant();
  after(1.6, () => { if (G.state !== 'OVER') startAtBat(); });
}

/** Bottom of an inning: restore the boot-time stage — visitors field, we hit. */
function stageBottom() {
  G.half = 'bottom';
  setRunnerSide('lin');

  /* Their hitter heads off, bench restored to full strength */
  oppBatter.root.visible = false;
  for (const role of oppOrder) {
    const t = visitorNine[role];
    if (t) t.root.visible = true;
  }

  /* Our nine back to the benches */
  POSITIONS.forEach((pos, i) => {
    const a = homeActors[roster[pos]];
    a.chase = null;
    setBatVisible(a, true);
    placeOnBench(a, i);
    a.root.visible = true;
  });

  /* Visiting nine retake the field */
  for (const pos of DEF_KEYS) {
    const a = visitorNine[pos];
    prepFielder(a, pos);
    defense[pos] = a;
  }
}

/** Point the dedicated visiting actor at this half's current lineup name and
    park him in the on-deck circle until startAtBat walks him to the box. */
function setOppBatter(role) {
  oppBatter.name = oppFielders[role];
  const twin = visitorNine[role];
  if (twin) twin.root.visible = false;
  oppBatter.root.visible = true;
  oppBatter.root.position.set(6.5, 0, 3.5);
  /* On-deck yaw (SEV-2 audit): he was left with whatever heading his last
     play ended on — a fresh identity staring into the dugout. Face the
     plate like prepFielder does. */
  oppBatter.root.rotation.y = Math.atan2(-oppBatter.root.position.x, -oppBatter.root.position.z);
  oppBatter.animState = { name:'idle', start:now() };
}

/* ======================================================================
   RUNTIME CONTEXT INJECTION (breaks import cycles)
====================================================================== */
const ctx = { G, SND, after, now };
/* Player pitch-aim committed by the PitchPicker (top half — LIN fields) */
let manualTarget = null;
export function initSubsystems() {
  initFielding({ ...ctx, defense, ball, camCtl });
  /* getBatter lets Runners drive the real batter actor around the paths
     (actor-runner theatre) instead of the miniature pill pool */
  initRunners({ ...ctx, scoreRuns, getBatter });
  /* Task 5 #28 — FieldingAI calls this at the drop-pickup moment so the
     OUT/SAFE race is decided here, next to the PA flow it feeds */
  setDropHook(onDropPickup);
  /* Task D-1 — same contract for fielded grounders: FieldingAI calls this
     at the pickup moment, the throw race is booked and resolved HERE */
  setPickupHook(onGroundPickup);
  /* Player pitch selection: PICK SPOT → PITCH commits the target and throws */
  PitchPicker.initPitchPicker({ onCommit: t => {
    manualTarget = t;
    if (G.state === 'READY' && G.half === 'top') doPitch();
  } });
}

/* ======================================================================
   AT-BAT FLOW
====================================================================== */
export function startAtBat() {
  if (G.state === 'OVER') return;
  /* Counts reset here too — a half that ended mid-PA skipped endPA, and the
     stale balls/strikes otherwise bleed into the next half's leadoff PA
     (observed live: a batter striking out on "strike four"). */
  G.paDone = false; G.swungAt = null; G.result = null; G.hrConfirmed = false;
  G.balls = 0; G.strikes = 0;
  /* Stray-ball sweep: nothing lying on the dirt (an unfielded roller, a
     short-hopped take) may survive into a new at-bat's READY window —
     ground balls are never legitimate here and every live script owns
     the ball as 'thrown'/'held', which this leaves untouched. */
  if ((ball.mode === 'rolling' || ball.mode === 'dead') && ball.mesh.visible) hideBall();
  const b = activeBatter();
  b.root.visible = true;
  defense['Pitcher'].animState = { name:'ready', start:now() };
  defense['Pitcher'].root.position.copy(defense['Pitcher'].baseHome);
  UI.muBat.textContent = b.name.toUpperCase();
  UI.muPit.textContent = (G.half === 'top' ? roster['Pitcher'] : OPP_PITCHER_NAME).toUpperCase();
  UI.stat.style.opacity = '.35'; UI.ev.textContent = '—'; UI.la.textContent = '—'; UI.distV.textContent = '—';
  G.state = 'READY';
  refreshHUD();
  walkIn(b);
}

/* ---- Batter approach (SEV-2 audit fix): startAtBat used to teleport the
   hitter up to ~15 m into the box in one frame, then snap to batReady.
   Beyond ~2 m out he now JOGS in — animState 'jog', root eased toward the
   third-base box while facing his travel direction — and only on arrival
   does he square up (+π/2 yaw), pull the mitt off and settle into batReady.
   CRITICAL TIMING: the first pitch gates BEHIND the walk — the PitchPicker
   opens (player half) / the CPU timer is booked (CPU half) only inside the
   arrival callback, so no windup can beat the walk and nothing double-
   schedules (doPitch itself still demands G.state === 'READY'). Keeping
   G.state at 'READY' through the jog is safe on every other consumer:
   trySwing needs PITCH, judgeTake needs a live G.pitch, and the only two
   READY-gated pitch launchers are exactly the ones this gate defers. ---- */
const BOX_POS = new THREE.Vector3(-1.27, 0, .1);   // third-base box — owner ask backed .30 m off the plate (was x=-.97)

function walkIn(b) {
  const dx = BOX_POS.x - b.root.position.x, dz = BOX_POS.z - b.root.position.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 2) { arriveInBox(b); return; }
  const dur = clamp(dist / 7.5, 1, 1.25);
  b.root.rotation.y = Math.atan2(dx, dz);            // face the travel direction
  b.animState = { name:'jog', start:now(), dur };
  const from = b.root.position.clone(), t0 = now();
  const step = () => {
    /* Abort, never fight: if a newer authority owns the body (game over, a
       fresh restage), drop silently — the new staging supersedes us. */
    if (G.state !== 'READY' || G.paDone || activeBatter() !== b) return;
    const ph = clamp((now() - t0) / dur, 0, 1);
    const k = ph * ph * (3 - 2 * ph);                // smoothstep ease in/out
    b.root.position.lerpVectors(from, BOX_POS, k);
    if (ph < 1) requestAnimationFrame(step);
    else arriveInBox(b);
  };
  requestAnimationFrame(step);
}

function arriveInBox(b) {
  b.root.position.copy(BOX_POS);
  b.root.rotation.y = Math.PI / 2;                   // third-base box faces the plate
  b.animState = { name:'batReady', start:now() };
  setGloveVisible(b, false);   // bare hands at the plate — no catcher's mitt while hitting
  SND.batTick();
  if (Math.random() < .18) SND.chant();
  refreshHUD();
  if (G.half === 'top') {
    /* PLAYER pitches: open the picker and wait for a committed spot */
    setBtn('PICK', 'YOUR SPOT', true);
    PitchPicker.show();
  } else {
    /* CPU pitcher works autonomously — the player times the swing */
    setBtn('WAIT', 'CPU PITCHER', true);
    PitchPicker.hide();
    after(rand(.9, 2.4), () => { if (G.state === 'READY' && !G.paDone) doPitch(); });
  }
}

export function doPitch() {
  if (G.state !== 'READY') return;
  SND.unlock(); SND.tick();
  G.state = 'WINDUP'; setBtn('…', '', true);
  PitchPicker.hide();                                  // picker spent until the next window

  /* Pitch selection — speed bands are deliberately wide: the visitor's swing
     timer derives from the actual flight T (speed-proof), but LIN's hitter
     must READ velocity out of the hand, so a fat fastball–changeup gap
     punishes keying on the windup instead of the ball */
  const roll = Math.random();
  let pt, speed, breakV;
  if (roll < .5)     { pt = 'FASTBALL';  speed = rand(28.5, 34); breakV = new THREE.Vector3(rand(.8, 1.6), rand(-.4,.6), 0); }
  else if (roll < .75){ pt = 'CURVEBALL'; speed = rand(23, 26.5); breakV = new THREE.Vector3(rand(3.6, 5.2), rand(2, 3.2), 0); }
  else               { pt = 'CHANGEUP';  speed = rand(20, 22.5); breakV = new THREE.Vector3(rand(-2.6,-1.6), rand(-.6,.4), 0); }

  /* Location — AI pitcher: ~1/3 intentionally off-plate, but those waste
     pitches STRADDLE the zone edges (|x|≤.24, y .72–1.32) so some get called
     strikes while the rest sit just off the plate as chase bait; the other
     ~2/3 scatter around the zone center and land in-zone ~69% of the time.
     PLAYER pitcher (LINCOLN fields): the committed PitchPicker spot plus a
     few cm of aim scatter, so location is a skill rather than an aimbot. */
  let tx, ty;
  if (manualTarget && G.half === 'top') {
    tx = manualTarget.x + rand(-.045, .045);
    ty = clamp(manualTarget.y + rand(-.045, .045), .35, 1.75);
    manualTarget = null;
  } else if (Math.random() < .33) {
    tx = pick([-1,1]) * rand(.16, .42);
    ty = pick([rand(.58,.80), rand(1.26,1.48)]);
  } else {
    tx = rand(-.29, .29);
    ty = rand(.67, 1.39);
  }
  const target = new THREE.Vector3(tx, ty, .15);

  /* Ballistic solve: initial velocity that crosses plate at `speed` m/s */
  const T = RELEASE.distanceTo(target) / speed;
  const vel = target.clone().sub(RELEASE).divideScalar(T)
    .addScaledVector(new THREE.Vector3(0, -9.81, 0), -.5 * T)
    .addScaledVector(breakV, -.5 * T);

  const relT = now() + WINDUP_DUR;
  G.pitch = { type:pt, speed, T, target, breakV, crossT:relT + T, judged:false, done:false };
  defense['Pitcher'].animState = { name:'windup', start:now(), dur:WINDUP_DUR };
  showWindupBall();                                    // ball rides the hand until release

  after(WINDUP_DUR, () => {
    if (G.state !== 'WINDUP') return;
    G.state = 'PITCH';
    ball.lift = 1; ball.breakA.copy(breakV); ball.mode = 'pitched';
    ball.pos.copy(RELEASE); ball.vel.copy(vel); ball.mesh.visible = true; syncBall();
    defense['Pitcher'].animState = { name:'pitchFollow', start:now() };
    SND.whoosh();
    setBtn(G.half === 'top' ? 'AUTO' : 'SWING!', pt, false);
    /* The CPU batter reads the FINAL location (player-picked or AI-chosen) */
    scheduleCpuSwing(T, Math.abs(tx) > .24 || ty < .72 || ty > 1.32);
    after(T + .14, judgeTake);
  });
}

/* ---- Windup ball carry — the ball rides the pitcher's throwing hand from
   the first frame of the windup, so he never throws an invisible ball.
   Mode 'held' keeps BallPhysics inert; a rAF pass (same idiom as the
   catcher receive below) pins ball.pos to the handR channel, blending onto
   RELEASE over the final stretch so the handoff to the real flight at
   release is seamless. Allocation-free: scratch vectors only. ---------- */
const _windV = new THREE.Vector3();

function showWindupBall() {
  const pit = defense['Pitcher'];
  if (!pit) return;
  ball.mode = 'held'; ball.lift = 1; ball.breakA.set(0, 0, 0); ball.vel.set(0, 0, 0);
  const hand = pit.channels && pit.channels.handR;
  const t0 = now();
  const step = () => {
    if (G.state !== 'WINDUP') return;                  // release/dead owns the ball now
    ball.mesh.visible = true;                          // re-assert: stale hides never win
    if (hand) {
      hand.getWorldPosition(_windV);
      _windV.y -= .06;                                 // grip it in the fingers, not the pivot
    } else {                                           // no rig fallback: held at the chest
      const r = pit.root.position, ry = pit.root.rotation.y;
      _windV.set(r.x + Math.sin(ry) * .24, .66 * (pit.effH || 1.92), r.z + Math.cos(ry) * .24);
    }
    /* Final stretch: blend onto RELEASE so the throw leaves exactly where
       the ballistic solve begins instead of popping */
    const ph = clamp((now() - t0) / WINDUP_DUR, 0, 1);
    if (ph > .90) {
      const k = (ph - .90) / .10;
      _windV.lerp(RELEASE, k * k);
    }
    ball.pos.copy(_windV);
    syncBall();
    requestAnimationFrame(step);
  };
  step();
}

/**
 * Visiting hitter works autonomously in the top half — COUNT-AWARE plate
 * discipline: takes ~30% of strikes (~58% of balls off the plate), chases
 * hard at ball three (take rate .58 → .13 — see the LOGIC-audit note on the
 * balls>=3 line below) and protects the plate with two strikes (+20% swing).
 * Swing timestamps land around the ideal intercept instant
 * (crossT − .16s) with a |u|^1.7·.235 delta spread; the mistimed block below
 * forces late/early swings into the .10–.185 band — mostly whiffs or soft
 * ok-contact the defense can field. Monte-Carlo of this exact model lands
 * K≈23%, BB≈2%, ≈5.5 runs/game.
 */
function scheduleCpuSwing(T, offPlate) {
  if (G.half !== 'top') return;
  let pTake = offPlate ? .58 : .30;
  /* LOGIC-audit: this line's original prose promised "+45% LAY-OFF at ball
     three / eye at the plate" — the OPPOSITE of what ships. The CHASE is the
     calibrated behavior: offline Monte-Carlo of the live tables lands
     K 19.8%/BB 2.55% (advertised ≈23%/≈2%), while a true lay-off would push
     CPU walks to ~15% of PAs. Do NOT flip this sign without an owner-level
     walk-rate rebalance. */
  if (offPlate && G.balls >= 3) pTake -= .45;
  /* Sign-flip fix: the comment (and intent) says the visitor PROTECTS the
     plate with two strikes (+20% SWING), but `pTake += .20` made him TAKE
     more — live QA watched called third strikes pile up. In-zone take rate
     drops .30 → .10 with two strikes; range check: pTake ∈ {.58,.13,.30,.10}. */
  if (!offPlate && G.strikes >= 2) pTake -= .20;       // protect with two strikes
  if (Math.random() < pTake) return;
  const u = rand(-1, 1);
  let delta = Math.sign(u) * Math.pow(Math.abs(u), 1.7) * .235;
  /* ~42% of swings deliberately mistimed → whiffs and weak ok-contact the
     defense can actually convert; keeps the CPU half from turning into a
     batting practice session */
  if (Math.random() < .42) delta = (Math.random() < .5 ? -1 : 1) * rand(.11, .185);
  after(clamp(T - .16 + delta, .06, T + .06), () => trySwing(true));
}

/** `cpu` = scheduled visitor swing (player input is ignored in the top half). */
export function trySwing(cpu = false) {
  if (G.state !== 'PITCH' || !G.pitch || G.pitch.done || G.swungAt != null) return;
  if (!cpu && G.half === 'top') return;
  SND.tick();
  G.swungAt = now();
  activeBatter().animState = { name:'swing', start:now(), dur:.34 };
  setBtn('.', '', true);
  after(Math.max(0, G.pitch.crossT - now()), () => {
    if (G.pitch && !G.pitch.done && G.swungAt != null) onContact();
  });
}

/** Umpire call when the batter takes the pitch. */
function judgeTake() {
  if (!G.pitch || G.pitch.judged || G.pitch.done || G.swungAt != null) return;
  G.pitch.judged = true; G.pitch.done = true;
  const tz = G.pitch.target;
  const inZone = Math.abs(tz.x) <= .24 && tz.y >= .72 && tz.y <= 1.32;
  callPitch(inZone ? 'strike' : 'ball', false);
}

/* Timing-based contact quality: delta vs ideal intercept instant.
   Tight windows — real hitting is hard; misses must dominate. */

/** Upward-skewed uniform draw: k < 1 piles samples toward the TOP of the
    band (the old loft-heavy look), k > 1 toward the BOTTOM (down-through
    contact). resolveSwing now uses both directions per band. */
const skewUp = (lo, hi, k) => lo + (hi - lo) * Math.pow(Math.random(), k);

function resolveSwing() {
  const ideal = G.pitch.crossT - .16;
  const delta = G.swungAt - ideal;
  /* Split difficulty: the visitor's windows stay exactly as Monte-Carlo
     calibrated (scheduleCpuSwing → K≈23%, BB≈2%), while LIN's are ~30%
     tighter on every band — contact must be EARNED, not given. On top of
     timing, a REACH TAX for the human only: chasing a pitch off the call-zone
     edge eats real timing margin, so a deep dirt/high-and-away lunge can turn
     even a perfectly-timed swing into a whiff or feeble contact (the ump's
     zone in judgeTake is the zero-tax anchor: |x|≤.24, y .72–1.32). */
  const cpuHalf = G.half === 'top';
  let ad = Math.abs(delta);
  if (!cpuHalf) {
    const tz = G.pitch.target;
    ad += .3 * Math.hypot(
      Math.max(0, Math.abs(tz.x) - .26),
      tz.y < .72 ? .72 - tz.y : tz.y > 1.32 ? tz.y - 1.32 : 0);
  }
  const quality = cpuHalf
    ? (ad <= .035 ? 'perfect' : ad <= .08 ? 'good' : ad <= .13 ? 'ok' : 'miss')
    : (ad <= .025 ? 'perfect' : ad <= .055 ? 'good' : ad <= .095 ? 'ok' : 'miss');
  G.pitch.done = true;
  if (quality === 'miss') return null;
  let la, ev, h0;
  /* Owner-tuned launch mix (retuned from the first grounder-heavy pass that
     overcorrected): an even 50/50 split — half the fair balls are GROUND
     contact (infield rollers + low liners; k > 1 piles each band's DOWN
     slice low), half are AIR (outfield flies, pops, HRs). The UP slices keep
     liners-to-flies varied and top-EV perfect barrels still clear the 91 m
     fence. Monte-Carlo of these exact tables: GROUND 49.9/50.4%
     (CPU/LIN) · AIR 50.1/49.6% · HR ≈1.3–1.6/game — miss rates untouched,
     so the calibrated K%/BB% survives. EV bands unchanged: barrels must
     still EARN the fence. */
  if (quality === 'perfect') {
    ev = rand(31, 37); h0 = rand(-6, 6);
    la = Math.random() < .45 ? skewUp(-7, 14, 1.15) : skewUp(15, 36, .80);
  } else if (quality === 'good') {
    ev = rand(28, 35); h0 = rand(-10, 10);
    la = Math.random() < .60 ? skewUp(-5, 14, 1.10) : skewUp(13, 41, .95);
  } else {
    ev = rand(21, 29); h0 = rand(-13, 13);
    la = skewUp(-8, 44, 1.30);
  }
  /* Popped-up swing → can of corn. Only already-airborne contact elevates:
     a topped roller converting into a popup would tax exactly the grounder
     mix this model exists to produce. */
  if (la > 10 && Math.random() < .22) la = Math.min(64, la + rand(15, 30));
  const pull = clamp(-delta / .13, -1, 1);
  const hAng = clamp(pull * 40 + h0 * .5, -58, 58);
  const foul = Math.abs(hAng) > 45 || (quality === 'ok' && la < 5 && Math.random() < .45) ||
               (quality === 'ok' && Math.random() < .22);   // topped/sliced into the dirt or seats
  /* (la<5/.45, was la<8/.50): with grounders now the dominant fair outcome,
     the old trigger fouled off ~half of all routine rollers and starved the
     infield of live plays. Only a TRULY topped swing (under 5°) risks the
     dirt foul now; the seat-slice foul is unchanged. */
  return { la, ev, hAng, foul };
}

function callPitch(kind, swinging) {
  G.state = 'DEAD'; setBtn('.', '', true);
  /* Every unhit pitch finishes in the catcher's glove — takes AND swings
     and misses alike. stepBall has already halted it at the pocket line,
     so this reads as a clean receive instead of a ball blowing through
     the catcher toward the camera. */
  catcherReceive();
  /* Backstop: also sweep balls that finished on the dirt — a short-hopped
     take lands in 'rolling'/'dead' and used to slip past both this hide and
     the receive guard, stranding a visible ball through READY (Stage 4). */
  after(.4, () => {
    if (ball.mesh.visible &&
        (ball.mode === 'pitched' || ball.mode === 'held' ||
         ball.mode === 'rolling' || ball.mode === 'dead')) hideBall();
  });
  if (kind === 'strike') {
    G.strikes++; SND.umpCall('strike');
    banner('STRIKE ' + (swinging ? 'SWING' : 'LOOKING'), `${G.balls}–${G.strikes}`, 'strike');
    if (G.strikes >= 3) after(1.15, outK);
    else after(1.6, startNextPitch);
  } else {
    G.balls++; SND.umpCall('ball');
    banner('BALL', `${G.balls}–${G.strikes}`, 'ball');
    if (G.balls >= 4) after(1.1, walkBatter);
    else after(1.5, startNextPitch);
  }
  refreshHUD();
}

/* ---- Catcher receives a taken pitch, then flips it back to the mound ---- */
const _recvTo = new THREE.Vector3(), _recvFrom = new THREE.Vector3();
const _recvMitt = new THREE.Vector3();     // scratch: live mitt world position

function catcherReceive() {
  const c = defense['Catcher'];
  /* 'rolling'/'dead' included: a pitch that short-hopped the dirt never
     reaches the pocket line, so without this the bounced ball is never
     received, never hidden, and sits visible through the next READY. */
  if (!c || !ball.mesh.visible ||
      (ball.mode !== 'pitched' && ball.mode !== 'held' &&
       ball.mode !== 'rolling' && ball.mode !== 'dead')) return;
  ball.mode = 'thrown';                       // freeze physics integration
  _recvFrom.copy(ball.pos);
  /* Catcher-audit #1: receive into the LIVE MITT, not the root centre — the
     old (x, gy, root.z) aim slid the ball visibly through the glove into his
     chest before the pop. x/z read the handL channel (≈0.26 m proud of the
     root); the pitch height still leads but clamps to mitt.y ± .35 so a high
     fastball is caught at the reach instead of floating at chest height.
     Rig fallback keeps the measured offset with a stature-scaled mitt. */
  let mx = c.root.position.x, mz = c.root.position.z - .26, mittY = (c.effH || 1.78) * .5;
  const hand = c.channels && c.channels.handL;
  if (hand && c.bones) {
    hand.getWorldPosition(_recvMitt);
    mx = _recvMitt.x; mz = _recvMitt.z; mittY = _recvMitt.y;
  }
  const lo = Math.max(.35, mittY - .35), hi = Math.min(1.75, mittY + .35);
  const gy = G.pitch ? clamp(G.pitch.target.y, lo, hi) : clamp(1.08, lo, hi);
  _recvTo.set(mx, gy, mz);
  const t0 = now();
  const step = () => {
    if (ball.mode !== 'thrown' || G.state === 'OVER') { hideBall(); return; }
    const t = clamp((now() - t0) / .16, 0, 1);
    ball.pos.lerpVectors(_recvFrom, _recvTo, t);
    syncBall();
    if (t < 1) requestAnimationFrame(step);
    else { SND.pop(); hideBall(); returnToMound(c); }
  };
  requestAnimationFrame(step);
}

/** Optional flourish — catcher pops up and arcs the ball back to the mound. */
function returnToMound(c) {
  const pit = defense['Pitcher'];
  if (!pit || G.state !== 'DEAD') return;
  c.animState = { name:'catcherThrow', start:now(), dur:.75 };
  _recvFrom.copy(_recvTo);
  _recvTo.copy(RELEASE);
  ball.mesh.visible = true; ball.mode = 'thrown';
  const t0 = now();
  const step = () => {
    if (ball.mode !== 'thrown' || (G.state !== 'DEAD' && G.state !== 'READY')) { hideBall(); return; }
    /* Catcher-audit #2: hold the ball in the mitt through the rise-from-crouch,
       then compress the flight into POSE.catcherThrow's release snap (~.435 s
       into the .75 s pose) — it used to leave at t0+.12 while the arm was
       still coming up. The end-of-flight revert then lands on the final frame. */
    const t = clamp((now() - t0 - .45) / .30, 0, 1);
    ball.pos.lerpVectors(_recvFrom, _recvTo, t);
    syncBall();
    if (t < 1) requestAnimationFrame(step);
    else { hideBall(); c.animState = { name:'catcher', start:now() }; }
  };
  requestAnimationFrame(step);
}

function outK() {
  G.outs++; refreshHUD();
  activeBatter().animState = { name:'strikeoutCrouch', start:now(), dur:1.6 };
  banner('STRIKEOUT ⚾', '', 'out');
  G.half === 'top' ? SND.roar(.45) : SND.groan();
  after(1.7, G.outs >= 3 ? endHalf : endPA);
}

function walkBatter() {
  banner('WALK', '', 'ball');
  G.half === 'top' ? SND.groan() : SND.roar(.25);
  toast(`${activeBatter().name} draws a free pass`);
  forceAdvance(endPA);
}

function startNextPitch() {
  if (G.paDone) return;
  G.swungAt = null; G.pitch = null;
  /* Same stray-ball sweep as startAtBat: a bounced take must never sit on
     the dirt through READY while the picker (or CPU timer) is open. */
  if ((ball.mode === 'rolling' || ball.mode === 'dead') && ball.mesh.visible) hideBall();
  /* SEV-3 audit fix: only the batter was restored here — the pitcher stayed
     frozen in 'pitchFollow' through DEAD and into the next windup. Stand him
     back up on his rubber so every pitch starts from the same picture. */
  const pit = defense['Pitcher'];
  if (pit) {
    pit.animState = { name:'ready', start:now() };
    if (pit.baseHome) pit.root.position.copy(pit.baseHome);
  }
  activeBatter().animState = { name:'batReady', start:now() };
  G.state = 'READY';
  if (G.half === 'top') {
    setBtn('PICK', 'YOUR SPOT', true);
    PitchPicker.show();                                // back to the player
  } else {
    setBtn('WAIT', 'CPU PITCHER', true);
    PitchPicker.hide();
    after(rand(.9, 2.4), () => { if (G.state === 'READY' && !G.paDone) doPitch(); });
  }
}

/* ======================================================================
   CONTACT & BATTED-BALL CHOREOGRAPHY
====================================================================== */
function onContact() {
  const r = resolveSwing();
  if (r === null) { callPitch('strike', true); return; }
  G.state = 'LIVE';

  const { la, ev, hAng, foul } = r;
  UI.ev.textContent = Math.round(ev * 2.2369) + ' MPH';
  UI.la.textContent = Math.round(la) + '°';
  UI.stat.style.opacity = '1';

  /* Spark pop at the contact point */
  const contactP = new THREE.Vector3(
    clamp(G.pitch.target.x, -.3, .3), clamp(G.pitch.target.y, .5, 1.4), .12);
  for (let i = 0; i < 10; i++)
    FX.spark.spawn(contactP, { life:rand(.2,.5), size:rand(.12,.32), speed:rand(3,8), up:rand(1,4), opacity:.9 });
  FX.spark.spawn(contactP, { life:.4, size:.55, speed:4, up:2, opacity:.95 });
  SND.crack(ev);
  punchCam(.4 + Math.min(1, ev / 50) * .6);   // broadcast shake scaled by exit vel

  if (foul) {
    ball.lift = 1; ball.breakA.set(0,0,0); ball.mode = 'batted';
    ball.bounced = false;   // fresh flight: clear the previous PA's dirt flag (pairs with BallPhysics bounce writes)
    ball.pos.copy(contactP); syncBall();
    const fa = Math.sign(hAng || pick([-1,1])) * rand(48, 72);
    ball.vel.set(
      Math.sin(fa * DEG) * ev * Math.cos(la * DEG),
      Math.abs(Math.sin(la * DEG)) * ev * .8 + 2,
      -Math.cos(fa * DEG) * ev * Math.cos(la * DEG));
    G.strikes = Math.min(2, G.strikes + 1);
    banner('FOUL BALL', `${G.balls}–${G.strikes}`, 'out');
    refreshHUD();
    after(2.0, () => { hideBall(); startNextPitch(); });
    return;
  }

  /* Harder barrels fly with less effective gravity — only top-EV contact
     reaches the 91 m fence (predictFlight reads this before simulating) */
  ball.lift = la > 18 ? .94 - clamp((ev - 30) / 7, 0, 1) * .10 : 1;
  ball.breakA.set(0,0,0); ball.mode = 'batted';
  ball.bounced = false;   // fresh flight: clear the previous PA's dirt flag (pairs with BallPhysics bounce writes)
  ball.pos.copy(contactP); syncBall();
  ball.vel.set(
    Math.sin(hAng * DEG) * Math.cos(la * DEG),
    Math.sin(la * DEG),
    -Math.cos(hAng * DEG) * Math.cos(la * DEG)).multiplyScalar(ev);
  classifyAndChoreograph(predictFlight(ball.pos, ball.vel), ev, la);
}

/* Fielder recognition time: nobody breaks for the ball the instant it's hit */
const FLY_REACTION = .35;

/* ---- Outfield drop race (Task 5 #28) — documented, consistent constants.
   The whole verdict is decided from these numbers at the PICKUP moment:
   throw flight = clamp(distance / DROP_THROW_SPEED, MIN, MAX); the lead
   runner's remaining leg is estimated at his cruise pace (dropRunnerArrival).
   Ties go to the defence — the runner must beat the throw by DROP_TIE. ---- */
const DROP_THROW_SPEED = 26;    // m/s ≈ 58 mph outfield throw
const DROP_THROW_MIN  = .32;    // s — a point-blank flip can't be beaten
const DROP_THROW_MAX  = 1.5;    // s — deepest realistic arc
const DROP_TIE        = .04;    // s — runner's head-start allowance

/* Runner estimators assume constant SPRINT to the tag; real legs brake into
   the bag, arriving ~10% (+.05 s floor) later than estimated late in the leg.
   Compensate HERE (estimators live in locked Runners.js) so borderline throws
   that genuinely beat the runner aren't booked SAFE. */
const brakeSlack = t => t * .10 + .05;
const DROP_SAFETY     = 15;     // s after landing — no pickup means no play, all safe
                                // (a far drop's retrieval run alone can take 8+ s)
const GROUND_SAFETY   = 6;      // Task D-1 — same no-play contract for fielded grounders:
                                // an infield roller is corralled within ~2.5 s of landing
                                // or the play is dead; 6 s leaves generous slack
const BAG_NAMES = ['FIRST', 'SECOND', 'THIRD', 'HOME'];

/* Banner-truth contract for BOTH race verdicts (drop + grounder): a recorded
   putout at bag `bag` is legal only as a FORCE — the runner from origin
   bag−1 must be aboard with every bag behind him occupied too. Bag 0 retires
   the batter-runner, who is always forced at first. Reads the race record's
   pre-contact occupancy; a missing/short record fails CLOSED (no out) so no
   stale or forged stamp can ever print an OUT banner the eye cannot verify.
   resolveGround / resolveDrop call this at the verdict instant, after the
   pickup hooks have already derived their targets from real occupancy —
   this is the belt-and-braces backstop that keeps phantom OUT AT SECOND
   banners impossible even if a frozen upstream module regresses. */
function outAtBagLegal(race, bag) {
  if (!(bag >= 0) || bag > 3) return false;
  if (bag === 0) return true;                          // batter force at first
  const pre = race && Array.isArray(race.preBases) && race.preBases.length >= 3
            ? race.preBases : null;
  if (!pre) return false;
  const origin = bag - 1;
  if (!pre[origin]) return false;                      // nobody entitled there
  for (let j = 0; j < origin; j++) if (!pre[j]) return false;   // chain broken
  return true;
}

function classifyAndChoreograph(pred, ev, la) {
  const { landP, landT, hr, carry } = pred;
  const o = {};
  if (hr)              { o.type = 'HR';       o.label = 'HOME RUN!'; }
  else if (la >= 17) {
    /* Fly/liner path — physics-honest catch model that MATCHES the chase:
       FieldingAI paces every dispatched defender to arrive CATCH_PAD before
       the predicted landing at up to HUSTLE_MAX × base sprint, so crediting
       an out inside this reach guarantees a visible run-under catch. The
       promise stays conservative (never overpromises coverage), and balls
       landing within WALL_SAFE of the fence are never credited — rebounds
       diverge from predictFlight, so they always fall live. */
    const nd = nearestDefender(landP);
    /* Credit what the delivery promises: pace control targets arrival
       CATCH_PAD early, so budget the credited run over the shortened window
       (post-reaction time minus that pad) — otherwise max-reach bookings
       visibly fail their booked catch, the fielder still closing as the
       ball lands. */
    const reach = FIELDING.CHASE_SPEED * FIELDING.HUSTLE_MAX *
                  Math.max(0, landT - FLY_REACTION - FIELDING.CATCH_PAD) * rand(.90, .99) +
                  FIELDING.GLOVE_CATCH_R + .3;
    if (carry <= FENCE_R - FIELDING.WALL_SAFE && nd.d <= reach)
      { o.type = 'flyout'; o.wasFly = true; o.fielder = nd.a; o.label = 'CAUGHT — OUT!'; }
    else {
      /* Task 5 #28 — every predicted outfield drop is a LIVE race: the nearest
         fielder picks it up and fires at the LEAD runner's destination bag;
         OUT/SAFE is decided by documented constants at the pickup moment
         (onDropPickup). Extra-base hits on drops fold into the race (one-base
         legs) — doubles still exist on grounders through the hole. */
      o.type = 'drop'; o.wasFly = true; o.fielder = nd.a; o.label = 'IT DROPS IN!';
    }
  } else {
    /* True grounders. Balls cleanly through the hole are base hits by
       GEOMETRY — nobody has a play, so they resolve through the classic
       advanceHit flow below. Everything else is now a LIVE RACE (Task D-1):
       no coin flip at contact. The dispatched chaser pursues the actual
       ball, gloved it, plants and fires at a booked bag, and Game.js decides
       OUT/SAFE at the pickup instant from documented constants — the call
       follows what the eye can verify, exactly like the drop race above. */
    /* 'Through' means a HOLE, not just legs: a roller first-touching within
       ~7 m of an infielder is a makable play — route it to the live race like
       any fielded grounder instead of gifting a geometric single. */
    const ndG = nearestDefender(landP, true);
    const through = (carry > 26 || Math.abs(landP.x) > 17) && ndG.d > 7;
    if (through) {
      o.type = (ev > 35 && Math.abs(landP.x) > 15 && Math.random() < .45) ? 'double' : 'single';
      o.label = o.type === 'double' ? 'LINE DRIVE DOUBLE!' : 'THROUGH THE HOLE!';
    } else {
      o.type = 'ground'; o.wasFly = false; o.label = 'GROUNDER';
      /* Infield-range rollers go to the nearest INFIELDER (the catcher is
         never a chaser); a ball carrying into shallow outfield grass may be
         closer to an outfielder charging in, so widen the search there. */
      o.fielder = nearestDefender(landP, carry <= 28).a;
      /* Force-race launch: inherited runners and the batter take their
         one-base legs NOW while G.bases stays frozen for the verdict. */
      o.race = startDropTheatre([G.bases[0], G.bases[1], G.bases[2]], 'ground');
    }
  }
  G.result = o;

  /* Batter-runner: EVERY fair ball sends him down the line at contact —
     without his leg there is no race to first and no throw can read as a
     putout. The two race types skip this: startDropTheatre launches the
     batter itself under a verdict-hold (waitRace), because whether he is
     safe or out is exactly what the pending race decides. A home run's jog
     is superseded when resolveOutcome hands him trotHR's full circuit. */
  if (o.type !== 'drop' && o.type !== 'ground') {
    const bt = activeBatter();
    if (bt && bt.ready)
      sendRunner(bt, [0], o.type === 'HR' ? { stay:true, jog:true } : { stay:true });
  }

  /* Landing dust + distance popup */
  after(landT, () => {
    if (o.type !== 'HR') {
      FX.dust.spawnCluster(new THREE.Vector3(landP.x, .12, landP.z), 9);
      const ft = Math.round(carry * 3.281);
      UI.distV.textContent = ft + ' FT';
      distPopup(ft + ' FT');
    }
  });

  /* HRs clear the fence — no cosmetic sprint at a landing spot behind the wall.
     Everyone else breaks on READABLE reaction latency: the fly-reach formula
     already budgets FLY_REACTION, so delaying the visible break by exactly
     that keeps credited catches honest without shrinking real coverage. */
  if (o.type !== 'HR')
    after(FLY_REACTION, () => { if (G.state === 'LIVE')
      dispatchFielder(o.fielder || nearestDefender(landP).a, landP, o, pred); });

  if (o.type === 'drop') {
    /* Task 5 #28 — the drop race. Runners launch their one-base legs NOW
       (real running theatre while the ball is still in the air) but G.bases
       stays frozen until the pickup → throw race resolves. The "IT DROPS IN!"
       banner rides the landing beat; a safety net resolves a ball the chaser
       somehow never corrals as a no-play SAFE so the PA can never hang. */
    o.race = startDropTheatre([G.bases[0], G.bases[1], G.bases[2]]);
    after(landT + .35, () => {
      if (G.state !== 'LIVE') return;
      banner(o.label, '', 'hit');
      G.half === 'top' ? SND.groan() : SND.cheerBuild(.55);
    });
    after(landT + DROP_SAFETY, () => forceDropSafe(o));
  } else if (o.type === 'ground') {
    /* Grounder race resolution is event-driven (pickup → booked throw →
       arrival); only the safety net runs on a timer here — a roller nobody
       corrals must still end the PA (see forceGroundSafe). */
    after(landT + GROUND_SAFETY, () => forceGroundSafe(o));
  } else {
    /* Air outs & clean hits keep their fixed beats — the ball has to land
       before an honest verdict exists. */
    after(landT + .4, () => resolveOutcome(o, pred));
  }
}

/* ---- Drop race: pickup-moment decision + verdict choreography ---------- */

/** Called by FieldingAI (setDropHook) the instant a fielder picks up a
    dropped fly. Decides OUT/SAFE from the documented constants, aims the
    throw at the lead runner's destination bag, and schedules the verdict
    for the moment the throw arrives. */
function onDropPickup(f, o) {
  const race = o.race;
  if (!race || race.done) return;
  race.done = true;
  /* REAL occupancy decides the force play — never the theatre's own lead
     stamp. This mirrors the landed onGroundPickup contract: with empty
     bases startDropTheatre hands its lead leg bag 0, but that stamp is a
     frozen module's word — trusting it raw here left the drop race one
     regression away from repeating the phantom OUT AT SECOND class the
     grounder side already fixed, and TODAY it booked force semantics
     against UNFORCED runners whenever a dropped fly landed with a broken
     chain aboard ([010] fired at third against the runner from second,
     [101] fired home against the runner from third). Derive the lead FORCE
     runner from the pre-contact occupancy Game passed in and accept the
     stamp only when it agrees. */
  const pre = (Array.isArray(race.preBases) && race.preBases.length >= 3)
            ? race.preBases : [G.bases[0], G.bases[1], G.bases[2]];
  const runnersAboard = pre[0] || pre[1] || pre[2];
  let forceOrigin = -1;                        // lead FORCED runner's origin bag
  for (let i = 2; i >= 0; i--) {
    if (!pre[i]) continue;
    let chained = true;
    for (let j = 0; j < i; j++) if (!pre[j]) { chained = false; break; }
    if (chained) { forceOrigin = i; break; }   // furthest fully-forced runner
  }
  /* Accept the stamped destination only under a genuine force; anything
     else (empty bases, broken chain, missing stamp) aims first as retrieval
     theatre and books no lead out at all. */
  const claimed = race.lead && typeof race.lead.bag === 'number' ? race.lead.bag : -1;
  const leadDest = forceOrigin >= 0 && claimed === Math.min(forceOrigin + 1, 3)
                 ? Math.min(forceOrigin + 1, 3) : -1;
  const flightTo = bag => {
    const bp = BASE_POS[bag];
    return clamp(Math.hypot(bp.x - f.root.position.x, bp.z - f.root.position.z) /
                 DROP_THROW_SPEED, DROP_THROW_MIN, DROP_THROW_MAX);
  };
  const tLead   = dropRunnerArrival();         // s until the lead runner tags
  const tBatter = raceBatterArrival();         // s until the batter-runner tags 1st
  /* Ties go to the defence — the throw must BEAT the remaining leg by more
     than DROP_TIE plus braking slack (same convention as the grounder race).
     A finished leg reads t≈0, which the THROW_MIN/DROP_THROW_MIN floors can
     never beat, so an already-planted runner is never retroactively retired. */
  const outAtLead  = leadDest >= 0 &&
                     flightTo(leadDest) <= tLead + DROP_TIE + brakeSlack(tLead);
  /* Empty bases: the batter at first IS the only force in play — same
     booking rule as onGroundPickup's !runnersAboard && outAtFirst. With
     anyone aboard the retirement API targets only validated lead forces,
     so first is pure retrieval theatre and everyone plays out safe. */
  const outAtFirst = !runnersAboard &&
                     flightTo(0) <= tBatter + DROP_TIE + brakeSlack(tBatter);
  const bag = outAtLead ? leadDest : 0;        // no winning play still fires to first
  o.dropBag = bag;
  o.dropFlight = flightTo(bag);
  o.dropOut = outAtLead || outAtFirst;
  after(o.dropFlight, () => resolveDrop(o));
}

/** Verdict moment — the throw has just arrived at the bag. */
function resolveDrop(o) {
  if (G.state !== 'LIVE') return;
  G.state = 'DEAD'; setBtn('.', '', true);
  /* Banner-truth guard (belt-and-braces behind onDropPickup's derivation):
     a booked out past first must still sit on a genuine force in the
     pre-contact occupancy — demote anything else to the SAFE branch so the
     banner can never disagree with what the eye can verify. */
  if (o.dropOut && !outAtBagLegal(o.race, o.dropBag)) o.dropOut = false;
  if (o.dropOut) {
    banner(`OUT AT ${BAG_NAMES[o.dropBag]}!`, '', 'out');
    G.half === 'top' ? SND.roar(.45) : SND.groan();   // our defence recorded it
    G.outs++; refreshHUD();
    applyDropOutcome(false);                // lead runner retired; others hold/forced
    after(1.8, G.outs >= 3 ? endHalf : endPA);
  } else {
    banner('SAFE!', '', 'hit');
    const runs = applyDropOutcome(true);    // normal advancement completes
    scoreRuns(runs);
    if (runs === 0) G.half === 'top' ? SND.groan() : SND.cheerBuild(.45);
    after(1.8, endPA);
  }
}

/** Safety net: the chaser never corralled the ball (stuck, unreachable,
    rebounded away) — no play, everyone is safe, the PA moves on. */
function forceDropSafe(o) {
  if (G.state !== 'LIVE' || !o.race || o.race.done) return;
  o.race.done = true;
  banner('SAFE!', 'NO THROW', 'hit');
  G.half === 'top' ? SND.groan() : SND.cheerBuild(.55);
  const runs = applyDropOutcome(true);
  scoreRuns(runs);
  G.state = 'DEAD'; setBtn('.', '', true);
  if (ball.mode === 'rolling' || ball.mode === 'dead') hideBall();
  after(1.8, endPA);
}

/* ---- Grounder race (Task D-1): pickup-moment booking + verdict ---------- */

/** Called by FieldingAI (setPickupHook) the instant a fielder picks up a
    fielded grounder while the play is live. Books the throw exactly like
    onDropPickup books a drop, with ONE extra candidate: the batter-runner
    racing down the line. Defence logic mirrors a real infield:
      • prefer retiring the LEAD runner AT HIS DESTINATION BAG WHEN HE IS FORCED,
      • else take the sure force at first,
      • if neither throw wins, fire to first anyway — everyone is safe and
        it scores an infield hit.
    All arithmetic reads the shared FIELDING.THROW_* / RACE_TIE table, so
    FieldingAI's visible arc flies exactly the flight this verdict assumes
    (the same documented-constants contract as the drop race above). */
function onGroundPickup(f, o) {
  const race = o.race;
  if (!race || race.done) return;
  race.done = true;
  /* REAL occupancy decides the force play — never the race's own lead stamp.
     startDropTheatre counts the batter-runner as the lead leg when the bases
     are empty, so a raw `race.leadBag` read 'runner on FIRST' with nobody
     aboard: leadDest became 1 (second), the force-chain loop below ran
     VACUOUSLY at bag 0 and declared that phantom runner forced, and routine
     infield rollers printed 'OUT AT SECOND!' — with both flights beating the
     ~3.8 s batter leg, a phantom DOUBLE PLAY booked a second out on top.
     Derive the lead FORCE runner from the pre-contact occupancy Game itself
     passed in, and accept the race's stamp only when it agrees with reality
     under either convention (his origin bag or his destination bag). */
  const pre = (Array.isArray(race.preBases) && race.preBases.length >= 3)
            ? race.preBases : [G.bases[0], G.bases[1], G.bases[2]];
  const runnersAboard = pre[0] || pre[1] || pre[2];
  let forceOrigin = -1;                        // lead FORCED runner's origin bag
  for (let i = 2; i >= 0; i--) {
    if (!pre[i]) continue;
    let chained = true;
    for (let j = 0; j < i; j++) if (!pre[j]) { chained = false; break; }
    if (chained) { forceOrigin = i; break; }   // furthest fully-forced runner
  }
  const claimed = race.leadBag;
  const leadBag = forceOrigin >= 0 &&
                  (claimed === forceOrigin || claimed === forceOrigin + 1)
                ? forceOrigin : -1;
  const leadDest = leadBag >= 0 ? Math.min(leadBag + 1, 3) : -1;
  /* True force chain (Task D-1, kept): the runner from bag i is forced only
     when EVERY bag behind him is occupied (the batter forces 1st, the chain
     propagates) — no tag, no out at an uncovered bag. A stamp that disagrees
     with real occupancy (mixed lineups like 1st+3rd, where the race's lead
     leg is the UNFORCED runner from third) books no lead out at all. */
  /* Candidate flight time from the fielder's spot: gather + carry, clamped */
  const flightTo = bag => {
    const bp = BASE_POS[bag];
    return FIELDING.THROW_GATHER +
      clamp(Math.hypot(bp.x - f.root.position.x, bp.z - f.root.position.z) /
            FIELDING.THROW_SPEED, FIELDING.THROW_MIN, FIELDING.THROW_MAX);
  };
  const tBatter = raceBatterArrival();          // s until the batter-runner tags 1st
  const tLead   = dropRunnerArrival();          // s until the lead runner tags his bag
  /* Ties go to the defence — the runner must beat the ball by more than
     RACE_TIE plus his braking slack (see brakeSlack above). */
  const outAtLead  = leadDest >= 0 &&
                     flightTo(leadDest) <= tLead + FIELDING.RACE_TIE + brakeSlack(tLead);
  const outAtFirst = flightTo(0) <= tBatter + FIELDING.RACE_TIE + brakeSlack(tBatter);
  const bag = outAtLead ? leadDest : 0;         // no winning play still fires to first
  o.throwBag = bag;
  o.throwFlight = flightTo(bag);
  /* Batter-out only with the bases EMPTY: with anyone aboard, the retirement
     API (Runners.applyDropOutcome) targets the race's OWN lead stamp, which
     needn't be a forced runner — booking first would erase the wrong runner
     (retirement-target API is a deferred Runners.js ask). Empty bases have
     no such ambiguity: the only force in play IS the batter at first, and
     retiring him is exactly what applyDropOutcome(false) does with no lead.
     Otherwise fire to first as retrieval theatre and let the forced
     advancement play out legally. */
  o.throwOut = outAtLead ? true : (!runnersAboard && outAtFirst);
  /* Error model (owner ask): long throws get booted ~10%, routine ones ~4%.
     Verdict must match the picture — a wild roll forces SAFE and hands
     FieldingAI an offset aim (o.wildTarget, consumed in throwIn). */
  const throwDist = Math.hypot(BASE_POS[bag].x - f.root.position.x,
                               BASE_POS[bag].z - f.root.position.z);
  if (Math.random() < (throwDist > 32 ? .10 : .04)) {
    const wa = rand(0, Math.PI * 2);
    o.wildTarget = { x: BASE_POS[bag].x + Math.cos(wa) * rand(2, 3.5),
                     z: BASE_POS[bag].z + Math.sin(wa) * rand(2, 3.5) };
    o.throwOut = false;
  }
  /* Turning two is infield identity: both throws winning (and no boot) books
     the DP. dpFlight2 is the ONE shared number — Game times the second
     verdict on it, FieldingAI flies the visible relay on it. */
  o.doublePlay = !!(outAtLead && outAtFirst && !o.wildTarget);
  if (o.doublePlay)
    o.dpFlight2 = FIELDING.THROW_GATHER +
      clamp(Math.hypot(BASE_POS[0].x - BASE_POS[bag].x,
                       BASE_POS[0].z - BASE_POS[bag].z) /
            FIELDING.THROW_SPEED, FIELDING.THROW_MIN, FIELDING.THROW_MAX);
  after(o.throwFlight, () => resolveGround(o));
}

/** Verdict moment — the throw has just arrived at the booked bag. The PA
    resolves HERE rather than on a contact-time timer, so the banner, the
    out count and the occupancy all land on the visible catch. */
function resolveGround(o) {
  if (G.state !== 'LIVE') return;
  G.state = 'DEAD'; setBtn('.', '', true);
  const homeBatting = G.half !== 'top';
  /* Banner-truth guard (belt-and-braces behind onGroundPickup's real-
     occupancy derivation): a booked out past first must still sit on a
     genuine force in the pre-contact occupancy — demote anything else to
     the SAFE branch (and kill any DP that rode the demoted out). */
  if (o.throwOut && !outAtBagLegal(o.race, o.throwBag)) {
    o.throwOut = false; o.doublePlay = false;
  }
  if (o.throwOut) {
    banner(`OUT AT ${BAG_NAMES[o.throwBag]}!`, '', 'out');
    homeBatting ? SND.groan() : SND.roar(.45);   // our defence recorded it
    G.outs++; refreshHUD();
    applyDropOutcome(false);                // lead runner retired; forced legs complete
    if (o.doublePlay && G.outs < 3) {
      /* applyDropOutcome held the batter at 1st — the relay erases him for the
         second out, timed to o.dpFlight2 so the bookkeeping lands on the visible
         catch at first; the PA hold stretches to cover the relay. */
      after(Math.min(o.dpFlight2, 1.55), () => {
        if (G.state === 'DEAD' && G.result === o) {
          G.bases[0] = false; G.outs++; refreshHUD();
          banner('DOUBLE PLAY!', '', 'out');
          homeBatting ? SND.groan() : SND.roar(.45);
        }
      });
      /* INNING-END VERDICT DEFERRED: read G.outs INSIDE the timer, never at
         schedule time. The old ternary froze outs BEFORE the relay callback
         booked the second out, so a double play whose RELAY was the third
         out scheduled endPA instead of endHalf — endPA then bailed on its
         own outs>=3 guard without scheduling anything and the game sat in
         DEAD forever (live repro, game 1 bottom 7: bases-loaded grounder →
         OUT AT HOME! #2 → DOUBLE PLAY! #3 → 17-minute stall). On this path
         endPA has not run yet, so paDone is still false and endHalf's own
         mid-PA lineup advance moves the hitter exactly like every ordinary
         third out; non-inning-ending DPs land on endPA here unchanged. */
      after(1.8 + o.dpFlight2, () => { if (G.outs >= 3) endHalf(); else endPA(); });
    } else {
      after(1.8, G.outs >= 3 ? endHalf : endPA);
    }
  } else {
    banner('SAFE!', '', 'hit');
    toast(o.wildTarget ? `${activeBatter().name} reaches on the error`
                       : `${activeBatter().name} beats the throw`);
    homeBatting ? SND.cheerBuild(.5) : SND.groan();
    /* Result lens on the bag where the race was decided — the ball is
       hidden by now, so nothing else will move the camera for us. */
    camCtl.focus.set(BASE_POS[o.throwBag].x, 1.2, BASE_POS[o.throwBag].z);
    camCtl.mode = 'result';
    const runs = applyDropOutcome(true);    // normal advancement completes
    scoreRuns(runs);
    after(1.8, endPA);
  }
}

/** Safety net for the grounder race: nobody ever corralled the roller
    (stuck chaser, unreachable spin) — no throw, no out, everyone takes
    their forced base and the PA moves on. Mirrors forceDropSafe. */
function forceGroundSafe(o) {
  if (G.state !== 'LIVE' || !o.race || o.race.done) return;
  o.race.done = true;
  banner('SAFE!', 'NO THROW', 'hit');
  G.half === 'top' ? SND.groan() : SND.cheerBuild(.55);
  const runs = applyDropOutcome(true);
  scoreRuns(runs);
  G.state = 'DEAD'; setBtn('.', '', true);
  if (ball.mode === 'rolling' || ball.mode === 'dead') hideBall();
  after(1.8, endPA);
}

/* Gold firework pops above the wall along the ball's exit azimuth — pure
   theatre riding the pooled spark emitter, staggered like a real show. */
function hrFireworks(landP) {
  const az = Math.atan2(landP.x, -landP.z), r = FENCE_R - 4;
  [0, .5, 1.05].forEach(d => after(d, () => {
    const p = new THREE.Vector3(
      Math.sin(az + rand(-.12, .12)) * r, rand(7, 11), -Math.cos(az + rand(-.12, .12)) * r);
    for (let k = 0; k < 26; k++)
      FX.spark.spawn(p, { life:rand(.5,.9), size:rand(.14,.34), speed:rand(2,7), up:rand(-1,2), opacity:.95 });
  }));
}

function resolveOutcome(o, pred) {
  if (G.state !== 'LIVE') return;
  G.state = 'DEAD'; setBtn('.', '', true);
  const homeBatting = G.half !== 'top';
  if (o.type === 'HR') {
    G.hrConfirmed = true;
    homeBatting ? (SND.roar(1.6), SND.organ()) : SND.groan();
    banner('HOME RUN!', Math.round(pred.carry * 3.281) + ' FT', 'hr', 2.6);
    tryBeginReplay('hr');            // broadcast instant replay owns the lens through the DEAD hold
    hrFireworks(pred.landP);         // gold pops over the wall along the exit azimuth
    scoreRuns(1 + G.bases.filter(Boolean).length);
    /* Ride the trot: endPA fires when the runner-theatre circuit completes */
    trotHR(endPA);

  } else if (o.type === 'flyout' && !o.caught) {
    /* PHYSICS-HONEST CONVERSION — the pre-flight heuristic said caught, but
       the defender never physically closed on the ball and it dropped in.
       The call follows what really happened: a clean base hit. (Fielded
       grounders no longer pass through here at all — Task D-1 resolves them
       live via the pickup→throw race.) */
    o.type = 'single';
    banner('IT DROPS IN!', '', 'hit');
    homeBatting ? SND.cheerBuild(.55) : SND.groan();
    const runs = advanceHit(1, endPA);
    scoreRuns(runs);

  } else if (o.type === 'flyout') {
    G.outs++; refreshHUD();
    banner(o.label, '', 'out');
    homeBatting ? SND.groan() : SND.roar(.45);   // our defence recorded the out
    /* The launched batter-runner owns his own theatre now: leave him to
       plant at first and peel off toward the dugout once the bag reads
       empty — hiding him mid-run would read as a glitch. The guard keeps a
       legacy fallback for a batter no runner job managed to take. */
    const bt = activeBatter();
    if (bt && !hasRunningJob(bt)) bt.root.visible = false;
    after(1.8, G.outs >= 3 ? endHalf : endPA);

  } else {
    banner(o.label, '', 'hit');
    homeBatting ? SND.cheerBuild(.55) : SND.groan();
    const nb = o.type === 'triple' ? 3 : o.type === 'double' ? 2 : 1;
    const runs = advanceHit(nb, endPA);
    scoreRuns(runs);
  }
}

/* Cosmetic run-scoring theatre — our benched battery whoops it up when LIN
   crosses the plate. fxCheer sweeps EVERY quiescent Pitcher/Catcher-role
   actor, and in the bottom half that sweep would also catch the visitors'
   fielding battery ('ready'/'catcher' count as quiescent) — the club that
   just got scored on. Masking their role for the one synchronous scan keeps
   the celebration one-sided; AnimationController owns the injected pose and
   self-restores it, so nothing here touches G, timing or scoring. */
function cheerLinRuns() {
  const battery = [defense.Pitcher, defense.Catcher].filter(Boolean);
  const saved = battery.map(a => a.role);
  try {
    battery.forEach(a => { a.role = null; });   // invisible to fxCheer's role filter
    fxCheer();
  } finally {
    battery.forEach((a, i) => { a.role = saved[i]; });
  }
}

function scoreRuns(n) {
  if (n > 0) {
    if (G.half === 'top') { G.score.opp += n; SND.groan(); }
    else { G.score.lin += n; SND.roar(.5); cheerLinRuns(); }
  }
  refreshHUD();
}

/* ======================================================================
   INNINGS · GAME OVER
====================================================================== */
export function endPA() {
  G.paDone = true; G.balls = 0; G.strikes = 0;

  if (G.half === 'top') {
    /* Cycle the visiting lineup: the previous bench twin resurfaces, the next
       name steps in — same dedicated actor, fresh identity each PA */
    cancelRunner(oppBatter);   // never re-stage a body a runner job still owns
    const prevTwin = visitorNine[oppOrder[oppIdx]];
    if (prevTwin) prevTwin.root.visible = true;
    oppIdx = (oppIdx + 1) % oppOrder.length;
    setOppBatter(oppOrder[oppIdx]);

  } else {
    const prevIdx = G.batterIdx;
    const prev = homeActors[roster[lineupOrder[prevIdx]]];
    cancelRunner(prev);   // defensive: never bench a body a runner job still owns
    /* A hitter who REACHED BASE (walk / hit / race-safe) was claimed by the
       runners' staging the instant his leg completed — he IS that bag's
       between-play stager now (owner rule: the runner idles on base as
       himself). Bench-redressing him here teleported the freshly-parked
       runner off first (the "vanished walker"): his stale claim kept the
       slot, so the reconcile refused to seat anyone and the bag stood empty.
       Retired batters are never ext-staged — their redress is untouched. */
    if (!isExtStaged(prev)) {
      prev.animState = { name:'idle', start:now() };
      placeOnBench(prev, POSITIONS.indexOf(lineupOrder[prevIdx]));
      prev.root.visible = true;
    }

    G.batterIdx = (G.batterIdx + 1) % 9;
    batter = homeActors[roster[lineupOrder[G.batterIdx]]];

    /* On-deck hitter wanders near the circle */
    const od = homeActors[roster[lineupOrder[(G.batterIdx + 1) % 9]]];
    od.root.visible = true; od.root.position.set(-6.5, 0, 3.5);
    /* On-deck yaw (SEV-2 audit): face the plate (prepFielder convention),
       not a random heading. */
    od.root.rotation.y = Math.atan2(-od.root.position.x, -od.root.position.z);
    od.animState = { name:'idle', start:now() };
  }

  if (document.body.classList.contains('drawer-open')) buildDrawer();

  if (G.outs >= 3) return;
  after(1.0, () => { if (G.state !== 'OVER') startAtBat(); });
}

export function endHalf() {
  G.outs = 0; G.bases = [false, false, false];
  clearRunners();
  if (G.state === 'OVER') return;

  /* A half that ended mid-PA (strikeout / ball in play on the third out)
     never ran endPA — advance the lineup here so the next half leads off
     with the correct next hitter instead of replaying the finished one. */
  if (!G.paDone) {
    if (G.half === 'top') {
      oppIdx = (oppIdx + 1) % oppOrder.length;
    } else {
      G.batterIdx = (G.batterIdx + 1) % 9;
      batter = homeActors[roster[lineupOrder[G.batterIdx]]];
    }
  }

  if (G.half === 'bottom') {
    /* Top half plays out on the field — our nine pitch, catch and throw */
    stageTop();
  } else {
    if (G.inning >= FINAL_INNINGS && G.score.lin !== G.score.opp) return gameOver(false);
    if (G.inning >= MAX_INNINGS) return gameOver(true);
    G.inning++;
    stageBottom();
    toast(`▼ ${G.inning} — ${LIN.name.toUpperCase()} batting`);
    refreshHUD();
    after(1.4, () => { if (G.state !== 'OVER') startAtBat(); });
  }
}

export function gameOver(tie = false) {
  G.state = 'OVER'; setBtn('.', '', true);
  const win = G.score.lin > G.score.opp;
  $('f-res').textContent = (tie || G.score.lin === G.score.opp) ? 'TIE GAME'
    : win ? LIN.name.toUpperCase() + ' WINS!'
          : OPP.city.toUpperCase() + ' ' + OPP.nick.toUpperCase() + ' WIN';
  $('f-res').style.color = (tie || G.score.lin === G.score.opp) ? '#ccc' : win ? '#F2C14E' : '#ff6b5e';
  $('f-score').textContent = `${LIN.abbr} ${G.score.lin} — ${G.score.opp} ${OPP.abbr}`;
  $('final').classList.add('show');
  win ? (SND.roar(2), SND.organ()) : SND.groan();
}

/* ======================================================================
   INPUT
====================================================================== */
export function wireInput() {
  /* Player = the Lincoln Red batters only. The CPU pitches; SPACE/TAP swings. */
  UI.btn.addEventListener('pointerdown', e => {
    e.preventDefault(); SND.unlock();
    if (G.state === 'PITCH') trySwing();
  });
  addEventListener('keydown', e => {
    if (e.code === 'Space' && !e.repeat) {
      e.preventDefault(); SND.unlock();
      if (G.state === 'PITCH') trySwing();
    }
  });
  $('drawerToggle').addEventListener('click', () => {
    document.body.classList.toggle('drawer-open');
    SND.tick(); buildDrawer();
  });
  $('againBtn').addEventListener('click', () => location.reload());
}
