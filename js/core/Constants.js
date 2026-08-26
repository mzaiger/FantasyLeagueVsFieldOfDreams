/* =====================================================================
   Constants.js — immutable game data & field geometry
   Part of the Lincoln Red Gauntlet engine · js/core/
===================================================================== */
import * as THREE from 'three';

/* ---- Roster identity ------------------------------------------------ */
export const NAMES = ['Hyle','Kevo','Doug','Dan','Paul','Ted','Scherz','Josh','Nate','Danny','Nick'];
export const POSITIONS = ['Pitcher','Catcher','1st Base','2nd Base','3rd Base','Shortstop',
  'Left Field','Center Field','Right Field','Designated Hitter','Manager'];
export const LIN = { name:'Fantasy League', abbr:'LIN', primary:'#C8102E', secondary:'#ffffff', accent:'#2b2b2b' };

/* ---- Stadium variant (picked at load, see SceneManager.buildStadium) ----
   Mutable on purpose: buildStadium stamps the chosen park here at boot, and
   every later reader (drawer subtitle, welcome toast, videoboard header)
   follows the choice. 'oracle' — the classic V-bowl park; 'fod' — Field of
   Dreams, Iowa: same field, no stadium, corn outfield, wood bleachers. */
export const STADIUM = { key:'oracle', name:'Oracle Park' };

/* ---- Field geometry (metres) ---------------------------------------- */
export const FENCE_R = 91;          // outfield wall radius
export const FENCE_H = 3.5;         // wall height
/* 1B, 2B, 3B, home */
export const BASE_POS = [
  new THREE.Vector3(19.38, 0, -19.38),
  new THREE.Vector3(0, 0, -38.78),
  new THREE.Vector3(-19.38, 0, -19.38),
  new THREE.Vector3(0, 0, 0)
];
export const RELEASE = new THREE.Vector3(.35, 2.05, -17.9);   // pitch release point
export const WINDUP_DUR = .92;                                // windup seconds

/* Defensive alignment [x, z] — regulation-ish: corners just behind the bags,
   middle infield EVEN with their bag plane, OF normal depth pushed to
   ~0.71-0.77 × fence radius in the V-bowl shape (LF/RF corners shallower
   than CF; shallow/deep classes still scale these radially via OF_DEPTH) */
export const DEF_SPOTS = {
  'Pitcher':[0,-18.44], 'Catcher':[0,1.35], '1st Base':[24.2,-26.2], '2nd Base':[6.6,-38.8],
  '3rd Base':[-24.2,-26.2], 'Shortstop':[-6.6,-38.8], 'Left Field':[-34,-55.5],
  'Center Field':[0,-70], 'Right Field':[34,-55.5]
};

/* ---- Fielding AI (shared by FieldingAI.js) --------------------------- */
export const FIELDING = {
  CHASE_SPEED: 8.5,          // sprint to the ball (m/s)
  HUSTLE_MAX: 1.22,          // hard cap on the pace-control burst (× CHASE_SPEED)
  CATCH_PAD: .5,             // arrive this many seconds before predicted landT (s)
  BAG_SPEED: 9.0,            // urgent break to cover 1st on a grounder
  BACKUP_SPEED: 7.0,         // backing fielder converging on a fly ball
  DRIFT_SPEED: 5.0,          // middle infielders shading toward 2nd (jog)
  SETTLE_SPEED: 2.4,         // walk pace onto the shifted alignment spot
  SHIFT_X: 1.5,              // per-at-bat lateral shift (± metres)
  SHIFT_Z: 1.2,              // per-at-bat depth shift (± metres)
  OF_DEPTH: [.82, 1, 1.16],  // outfield shallow / normal / deep radial scale
  CREEP_MIN: .7,             // infield creep toward home during windup (m)
  CREEP_MAX: 1.6,
  CREEP_RATE: 3,             // creep ease rate (1/s)
  FLY_CATCH_R: 2.3,          // legacy landing-window radius (compat; grabs now use GLOVE_CATCH_R)
  GLOVE_CATCH_R: 1.35,       // honest air-catch radius: ball over the fielder (m)
  SHOESTRING_R: 1.05,        // last-instant grab as the ball lands into him (m)
  PICKUP_R: 1.6,             // ground-ball pickup radius (m)
  WALL_SAFE: 6,              // no-flyout margin inside FENCE_R — wall rebounds
                             // diverge from predictFlight, so never credit them
  RELAY_SPEED: 42,           // baseline flight speed for the cosmetic relay (m/s)

  /* Grounder race throws (Task D-1). The infield grounder OUT/SAFE verdict is
     decided at the PICKUP instant from these numbers — same documented-
     constants contract as Game.js's drop race (DROP_THROW_*): flight =
     THROW_GATHER + clamp(dist / THROW_SPEED, THROW_MIN, THROW_MAX), and the
     runner must beat the ball by more than RACE_TIE or the defence records
     the out. Shared here because FieldingAI schedules the visible arc while
     Game.js owns the verdict arithmetic — both must read ONE table. */
  THROW_SPEED: 28,           // infield throw carry (m/s ≈ 63 mph)
  THROW_GATHER: .3,          // plant-and-gather beat between pickup and release (s)
  THROW_MIN: .32,            // point-blank flip can't be beaten (s)
  THROW_MAX: 2.0,            // deepest corner-to-corner arc (s)
  RACE_TIE: .04              // tie goes to the defence — runner's head-start tax (s)
};

/* ---- Game structure -------------------------------------------------- */
export const FINAL_INNINGS = 9;                    // regulation baseball
export const MAX_INNINGS = FINAL_INNINGS + 3;      // extra-innings cap

/* ---- Ball flight model (read by physics/BallPhysics.js) ---------------
   W2-A calibration notes against the 91 m / 3.5 m fence. Exit-velo (EV)
   bands themselves live in Game.resolveSwing() — perfect ≤37, good ≤35,
   ok ≤29 m/s — and are NOT defined here. Under this drag model the
   best-angle carries run: ev=33 → ~90 m (warning-track wall-ball),
   ev=35 → ~100 m (leaves), ev=37 → ~111 m (clears by ~17 m). Home runs
   therefore sit exactly on the top slice of PERFECT-timed contact only,
   which Monte-Carlo of the resolveSwing distributions puts near a quarter
   of perfect contacts and essentially never off good/ok contact.
   STEP is the fixed physics step: BOTH the live integrator (stepBall,
   substepped) and the outcome oracle (predictFlight) must share it, or
   called balls diverge from what actually flies. */
export const BALLISTICS = {
  GRAVITY: 9.81,      // m/s² — Game.doPitch's vacuum solve assumes this too
  DRAG_K: .0042,      // quadratic drag: a_drag = −DRAG_K·|v|·v (pitched+batted)
  STEP: .016          // shared fixed integration step (s)
};

/* If resolveSwing's EV bands are ever raised toward MLB-real figures,
   DRAG_K MUST rise with them or every barrel leaves the park (ev=46 at
   .0042 carries ≈148 m / 486 ft). Pairings computed offline (w2a) that
   keep top-slice best-angle carry ≈115 m — fence earned, no derby:
   ev_top 40 → .0050 · 43 → .0062 · 46 → .0074 · 48 → .0084 */

/* ---- V-bowl grandstand geometry (shared by SceneManager + Crowd) ------
   The stands form a V funnel converging at the backstop (r 9.2) and
   widening down both foul lines into the outfield bowl. Each arm is a
   STRAIGHT run whose inner (field-side) face runs from the backstop's
   corner post to the outfield bowl's radial end-cap ray; both files must
   derive seats and prisms from THESE numbers, so they live here rather
   than being mirrored. Arm frame: P0 → P1 anchors the inner face line;
   `v` is the unit outward (foul/concourse) normal; `cross` distances are
   measured along v from that face line. Niche = the dugout recess carved
   into the arm's base — its cavity spans `nicheU` along the arm and
   `nicheC0..nicheC1` in cross (negative cross = toward the field), sized
   to contain Game.js's untouched bench tables (LIN |x| 14.3-16.6 /
   z -5.8..-7.6, visitors x 17.2-19.0 / z -8.9..-6.7 on the 1B side). --- */
export const VSTAND = {
  p0x: 7.7, p0z: 5.0,            // 1B arm head — at the backstop's 1B corner post
  p1x: 69.4, p1z: -68.4,         // tail — on the OF bowl end-cap ray (θ 134.66°, r 97.5)
  width: 13.5,                   // rows depth (cross extent of the seating prism)
  rows: 12,                      // stepped rows
  yBot: 1.15,                    // front-row prism base height
  top0: 4.4, top1: 7.6,          // stand top height at head / tail
  nicheU0: 11.5, nicheU1: 19.3,  // dugout carve span along the arm (m from P0)
  nicheC0: -3.4, nicheC1: 1.7,   // cavity cross extent (C0 field side, C1 back wall)
  nicheH: 2.7,                   // carve height — rows whose top ≤ this skip the span
  nicheRail: 0.95,               // field-side railing height
  apxR0: 10.6, apxDepth: 3.6, apxRise: 1.75, apxN: 2,   // apex stand (behind the plate)
  apxTH: 80                      // apex stand half-span (deg) — ends bury in the arm heads
};

/* ---- Debug query flags (?pose=windup&char=Hyle) ---------------------- */
const QS = new URLSearchParams(location.search);
export const DEBUG_POSE = QS.get('pose');
export const DEBUG_CHAR = QS.get('char');
