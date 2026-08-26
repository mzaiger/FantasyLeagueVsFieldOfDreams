/* =====================================================================
   AnimationController.js — Mixamo bone mapping, pose library, actor driver
   Part of the Lincoln Red Gauntlet engine · js/animation/

   Pose vocabulary (channel keys) is rig-agnostic: armL/armR, foreL/foreR,
   legL/legR (upper), legLowL/legLowR, Spine, Spine1, Neck, Head, Hips.
   `calibrateSigns` auto-detects axis conventions of any Mixamo export so
   one pose library fits every character (arms, legs AND knee flexion).
   Every pose ships a Hips position offset (even zero) so sinks/strides
   ease back cleanly when the state changes.
===================================================================== */
import * as THREE from 'three';
import { clamp, lerp, easeOut, easeIn, easeIO, now, rand } from '../utils/MathUtils.js';
import { ball } from '../physics/BallPhysics.js';   // same leaf read GripIK uses — flight-mode signal only

/* ---- Bone discovery --------------------------------------------------- */
const BONE_KEYS = ['Hips','Spine','Spine1','Neck','Head','LeftArm','LeftForeArm','LeftHand',
  'RightArm','RightForeArm','RightHand','LeftUpLeg','LeftLeg','RightUpLeg','RightLeg'];

/** Find mixamorig:* bones on a model with tolerant name matching. */
export function findBones(root) {
  const bones = {}, found = {};
  root.traverse(o => { if (o.isBone) bones[o.name] = o; });
  for (const k of BONE_KEYS) {
    const suffix = ('mixamorig' + k).toLowerCase();
    const alt = new RegExp(k.replace(/([.*+?^${}()|[\]\\])/g, '\\$&') + '$', 'i');
    const hit = Object.keys(bones).find(n => {
      const ln = n.toLowerCase().replace(/[^a-z0-9]/g, '');
      return ln.endsWith(suffix) || alt.test(n.replace(/mixamorig:?/i, ''));
    });
    if (hit) found[k] = bones[hit];
  }
  return found;
}

/* Map discovered Mixamo bones onto the channel vocabulary. */
export const BONE_CHANNEL_MAP = {
  armL:'LeftArm', armR:'RightArm', foreL:'LeftForeArm', foreR:'RightForeArm',
  handL:'LeftHand', handR:'RightHand', legL:'LeftUpLeg', legR:'RightUpLeg',
  legLowL:'LeftLeg', legLowR:'RightLeg',
  Spine:'Spine', Spine1:'Spine1', Neck:'Neck', Head:'Head', Hips:'Hips'
};

/* Auto-calibrate bone axis signs so one pose library fits any Mixamo export */
export function calibrateSigns(ch) {
  const sig = {}, q = new THREE.Quaternion(), e = new THREE.Euler();
  [['armL','Z','foreL'],['armR','Z','foreR']].forEach(([nm, axis, child]) => {
    const b = ch[nm], c = ch[child]; if (!b || !c) return;
    const rest = b.quaternion.clone();
    const y0 = new THREE.Vector3(); c.getWorldPosition(y0);
    e.set(0, 0, axis === 'Z' ? .7 : 0); q.setFromEuler(e);
    b.quaternion.copy(rest).multiply(q); b.updateWorldMatrix(true, true);
    const y1 = new THREE.Vector3(); c.getWorldPosition(y1);
    sig[nm] = { [axis]: y1.y < y0.y ? 1 : -1 };
    b.quaternion.copy(rest); b.updateWorldMatrix(true, true);
  });
  /* Legs — targets apply in the PARENT (character) frame: many FBX exports
     carry a ≈π roll in the UpLeg bind quaternions (rest Euler z ≈ ∓2.98 on
     the LIN rigs), so composing targets AFTER the bind rest — the premulti-
     ply path the arms were FK-tuned under — interprets leg X/Z in a half-
     turn twisted frame. That is exactly the catcher failure where applied
     leg Z read back as target − π and the crouch rendered standing. Post-
     multiplying (euler ⊗ rest) instead rotates the limb by the target about
     the parent frame: identical math to the identity-rest humanoid referen-
     ce, and a no-op for rigs whose leg binds are clean (rest ≈ identity).
     X (flexion) is re-probed under THIS composition; Z (coronal splay) is
     derived from each thigh's side in the hips frame, because Mixamo rigs
     keep the LEFT leg at +X — opposite the humanoid fallback's −X — so a
     fixed sign would mirror one side's knee tuck. */
  [['legL','legLowL'],['legR','legLowR']].forEach(([nm, child]) => {
    const b = ch[nm], c = ch[child]; if (!b || !c) return;
    const rest = b.quaternion.clone();
    const facing = new THREE.Vector3(0, 0, 1); b.getWorldQuaternion(q); facing.applyQuaternion(q); facing.y = 0;
    if (facing.lengthSq() < 1e-6) facing.set(0, 0, 1); facing.normalize();
    const p0 = new THREE.Vector3(); c.getWorldPosition(p0);
    e.set(.7, 0, 0); q.setFromEuler(e);
    b.quaternion.copy(q).multiply(rest); b.updateWorldMatrix(true, true);
    const p1 = new THREE.Vector3(); c.getWorldPosition(p1);
    const side = b.position.x >= 0 ? 1 : -1;
    sig[nm] = { X: p1.sub(p0).dot(facing) > 0 ? 1 : -1, Z: nm === 'legL' ? -side : side, post: true };
    b.quaternion.copy(rest); b.updateWorldMatrix(true, true);
  });
  /* Knee flexion sign — probe the first child bone of each shin so
     positive legLow* targets always mean "heel toward butt", any rig.
     Probed under the same post-rest composition the thighs use (see above),
     and flagged post so Actor.update pairs each sign with its composition. */
  [['legLowL'],['legLowR']].forEach(([nm]) => {
    const b = ch[nm]; if (!b || sig[nm]) return;
    const c = b.children.find(o => o.isBone); if (!c) return;
    const rest = b.quaternion.clone();
    const facing = new THREE.Vector3(0, 0, 1); b.getWorldQuaternion(q); facing.applyQuaternion(q); facing.y = 0;
    if (facing.lengthSq() < 1e-6) facing.set(0, 0, 1); facing.normalize();
    const p0 = new THREE.Vector3(); c.getWorldPosition(p0);
    e.set(.7, 0, 0); q.setFromEuler(e);
    b.quaternion.copy(q).multiply(rest); b.updateWorldMatrix(true, true);
    const p1 = new THREE.Vector3(); c.getWorldPosition(p1);
    sig[nm] = { X: p1.sub(p0).dot(facing) < 0 ? 1 : -1, post: true };   // flexion = foot swings back
    b.quaternion.copy(rest); b.updateWorldMatrix(true, true);
  });
  return sig;
}

/* ---- Hips position offset helper — present in every pose's tgp so the
       actor always has a lerp target and crouches/strides ease back out.
       Units are WORLD METRES: Actor.update converts them into each rig's
       raw bone units via unitInv (FBX bone scales vary 0.013–2.0). */
const hp = (x = 0, y = 0, z = 0) => ({ Hips:[x, y, z] });

/* Danny flipL compensation for shared armL raws — see the census note above.
   Rigs calibrate sig.armL.Z −1 except Danny (+1); Actor.update multiplies the
   RAW Z by that sig, so flipping the raw's Z once makes Danny's FINAL euler
   identical to the majority-tuned one. X/Y pass through untouched — the same
   zR-multiplier idiom the armR system uses. (A full (−x,y,−z) conjugation
   was lab-tested and REJECTED: it matches only while armL X ≈ 0, but flips
   the twist component on poses like bench/scoop where X dominates.)
   Applied to the armL triplet only; foreL stays shared everywhere. */
const mL = (w, flipL) => flipL ? [w[0], w[1], -w[2]] : w;

/* SWING-FAMILY flipR conjugation — the zR idiom's exact-transfer upgrade.
   z-negation alone reproduces the majority FINAL EULER on Hyle/Paul, but
   their mirrored right-arm BINDS rotate that euler into a different world
   orientation once the swing leaves the hang subspace: offline FK through
   the live pipeline (damped slerp + stabiliser + GripIK, .pose-lab/swinglive)
   showed the barrel arc straying .34-.47 m mid-swing and the top hand dragged
   .10-.39 m off the bat axis while clampPull saturated. Fix: premultiply the
   majority raw's quaternion by C = rest_flipR⁻¹ · rest_Player1 — measured on
   BOTH flipR rigs and averaged (Hyle and Paul each sit within ≈3° of the
   mean, so one shared pair serves the class) — then read the XYZ euler back:
     armR  C ≈ (-.177, .062, -.213)   output Z negated (cancels sig.armR.Z=-1)
     foreR C ≈ (.227,  .001, .112)    no sig on any rig → passes un-negated
   Applied ONLY in the swing family (batReady / swing / checkswing); every
   other family keeps the QA'd zR ternary idiom untouched. Majority retunes
   keep transferring automatically — no second table to maintain. */
const _mE = new THREE.Euler(), _mQ = new THREE.Quaternion();
const FLIPR_C_ARMR = new THREE.Quaternion().setFromEuler(new THREE.Euler(-.177, .062, -.213));
const FLIPR_C_FORER = new THREE.Quaternion().setFromEuler(new THREE.Euler(.227, .001, .112));
const mR = w => { _mE.set(w[0], w[1], w[2]);
  _mQ.setFromEuler(_mE).premultiply(FLIPR_C_ARMR);
  _mE.setFromQuaternion(_mQ); return [_mE.x, _mE.y, -_mE.z]; };
const mF = w => { _mE.set(w[0], w[1], w[2]);
  _mQ.setFromEuler(_mE).premultiply(FLIPR_C_FORER);
  _mE.setFromQuaternion(_mQ); return [_mE.x, _mE.y, _mE.z]; };

/* ======================================================================
   POSE LIBRARY — every pose is [targets, positionTargets].
   Euler triplets in radians; applied with per-axis sign calibration and
   damped slerp by Actor.update().
====================================================================== */
export const POSE = {
  /* Idle: breathing arms, slow weight-shift sway, occasional smooth glance.
     flipR = rig calibrated armR Z:−1 (Hyle, Paul) — the other 9 LIN FBX rigs
     and the humanoid fallback are Z:+1 and need mirrored right-arm raws. */
  idle(t, flipR, flipL) {
    const sway = Math.sin(t * .55) * .03;
    const gp = t % 7, gl = gp < .8 ? Math.sin(gp / .8 * Math.PI) * .5 : 0;
    const s = Math.sin(t * 1.5) * .04;
    return [
      /* Arms hang at the sides, hands at hip line (FK-tuned; NOT abduction).
         See AXIS SEMANTICS note + per-rig calibration census. */
      { armL:mL([0,-1.7,1.35 + s], flipL), foreL:[0,0,-.1],
        armR: flipR ? [0,-1.7,1.7 - s] : [0,-1.3,-1.75 + s],
        foreR: flipR ? [0,0,0] : [0,0,-.05],
        Spine1:[0,sway,0], Spine:[0,sway*.4,0], Neck:[0,gl,0] },
      hp(Math.sin(t * .55) * .012)];
  },

  ready(t, flipR, flipL) { const b = Math.sin(t*2.2)*.03; return [
    /* Athletic crouch: spine pitch carries the hanging arms forward in world
       space; throwing hand presented slightly ahead (Hyle R_D / Kevo H5). */
    { Spine:[.22+b,0,0], armL:mL([0,-1.7,1.35+b], flipL), foreL:[0,0,-.1],
      armR: flipR ? [0,-1.3,1.75-b] : [0,-1.3,-1.75+b],
      foreR:[0,0, flipR ? .05 : -.05],
      legL:[.32,0,.06], legR:[.32,0,-.06] }, hp()]; },

  /* Windup: rise → leg-kick HOLD at apex (glove tucked, hips sink) → stride.
     Phase split .30/.60 gives the hold ~0.28 s — past dampF(14) convergence,
     so the apex beat reads instead of twitching (old .34/.50 gave 0.147 s).
     RELEASE-homing stride: the arm sweeps overhead-across (X is THE vertical
     lifter on these rigs — see the cheer probe note below) while Y carries
     out-front and the chest opens from the −.70 coil to +.42; offline-FK +
     staged-pipeline measurement puts handR within ≈0.10 m of RELEASE
     (.35, 2.05, −17.9) at p=1 on the Player1 clone class (Doug/Nick ≈.10,
     Kevo/Dan/Josh spread wider — rig proportions, reported). Lead knee plants
     by p≈.85 (plant=k/.62), back knee loads through rise/hold then extends
     late, and the Hips travel ≈0.42 m toward the plate across the stride.
     flipR mirrors the armR coronal raws (Z) — see the census note above. */
  windup(ph, flipR, flipL) { const p = clamp(ph, 0, 1);
    const zR = flipR ? -1 : 1;
    if (p < .3) { const k = easeOut(p / .3); return [
      { Spine:[.10, -.70*k, 0], Spine1:[.04, -.03*k, 0],
        armL:mL([-.28*k, 0, .88*k], flipL), armR:[-.30*k, 0, -2.50*k*zR],
        legL:[1.32*k, 0, .1], legLowL:[1.05*k, 0, 0],
        legR:[lerp(.06, .44, k), 0, -.06], legLowR:[lerp(.08, .48, k), 0, 0] },
      hp(0, -.10*k, 0)]; }
    if (p < .6) {                                            // apex hold — balance beat
      const b = Math.sin((p - .3) / .3 * Math.PI) * .015; return [
      { Spine:[.08, -.70 + b, 0], Spine1:[.04, -.02, 0],
        armL:mL([-.28, 0, .88], flipL), armR:[-.30, 0, -2.50*zR],
        legL:[1.36 + b, 0, .1], legLowL:[1.08, 0, 0],
        legR:[.44, 0, -.06], legLowR:[.48, 0, 0] },
      hp(0, -.105, 0)]; }
    const k = easeIO((p - .6) / .4), s = easeIn((p - .6) / .4);
    const plant = Math.min(1, k / .62);                      // lead leg planted by p≈.85
    const late = easeIO(Math.max(0, (k - .55) / .45));       // push-off extends AFTER the plant
    return [
      { Spine:[lerp(.08, .06, k), lerp(-.70, .418, k), 0],
        Spine1:[lerp(.04, .294, k), lerp(-.03, .45, k), 0],
        armL:mL([lerp(-.28, -.55, k), 0, lerp(.88, .92, k)], flipL),
        armR:[lerp(-.30, -3.081, k), lerp(0, 2.304, k), lerp(-2.50, .494, k)*zR],
        foreR:[0, 0, .122*k],
        legL:[lerp(1.36, .15, plant), 0, .1], legLowL:[lerp(1.08, .10, plant), 0, 0],
        legR:[lerp(.44, .14, late), 0, -.07], legLowR:[lerp(.48, .16, late), 0, 0] },
      hp(0, lerp(-.105, .04, k), lerp(0, .42, s))]; },

  /* Follow-through: hand decelerates OUT-FRONT-ACROSS at waist-to-chest height
     (measured front margin +0.18 m past the rubber, hip-to-chest band) instead
     of the old sling that finished 0.31 m BEHIND the rubber; chest yaw −.15
     keeps the shoulders facing the plate. The damped transit FROM the release
     pose supplies the deceleration arc — the static target only has to be the
     right place to end up. */
  pitchFollow(flipR, flipL) { return [
    { Spine:[.46, -.15, 0], Spine1:[.06, -.02, 0],
      armR:[.68, 2.0, .35*(flipR ? -1 : 1)],
      armL:mL([-.55, 0, .55], flipL), foreL:[0, 0, -.3],
      legL:[.20, 0, .12], legLowL:[.14, 0, 0],
      legR:[-.30, 0, -.12], legLowR:[.45, 0, 0] }, hp(0, .01, .21)]; },

  /* Stance: hand stack hovering OUT OVER THE PLATE (world +X of the chest
     plane by ~0.35-0.5 m), barrel cocked up-back over the shoulder — the
     modern MLB look where the hands stay visible against the sky from the
     broadcast camera.
     AXIS SEMANTICS (probed bone-locally on the Mixamo FBX rigs via isolated
     axis-angle rotations + handR world readout, then re-verified with an
     offline FK sweep that replays Actor.update's exact restQ*euler math):
       arm X  = near-pure TWIST while the arm hangs (±1.2 rad moves the hand
                <6 cm), but once Y/Z swing the arm out it becomes the
                PLANE-OF-ELEVATION control — sweeping X tilts the whole
                swing plane (this is what finally bought the last ~15 cm of
                plate reach: rX 2.0→2.55).
       arm Y  = SAGITTAL swing. armR + / armL − carries the hand stack
                toward the plate — but NON-MONOTONICALLY (it traces a
                horizontal circle about the shoulder: past ~2.5 rad the hand
                starts curling BACK toward the catcher). The old "just push
                Y higher" fix overshot into regression; 2.3→3.0 LOST 12 cm.
       arm Z  = coronal arc (side ↔ overhead ↔ down). Applied − eases the
                elbows down-and-in under the hands.
       fore Z = elbow flexion, applied + = forearm folds up toward the head.
     CALIBRATION WARNING: `sig` is deterministic per rig but DIFFERS BETWEEN
     RIGS. Census across all 11 LIN FBX rigs: armL Z:−1 on 10/11 (Danny is
     +1), armR Z:+1 on 9/11 (Kevo Doug Dan Ted Scherz Josh Nate Nick Danny);
     Hyle and Paul calibrate armR Z:−1. The humanoid fallback hardcodes
     armR Z:+1 too. Poses therefore take flipR = (sig.armR.Z === −1) and
     swap the minority-tuned right-arm raws; left-arm raws are shared.
     Final constants (second in-page solver pass, this time against the FULL
     live pipeline — real bat mount, stabilizeBat and GripIK running — with
     spatial cost: hands 0.30 m forward of the spine axis OVER THE PLATE,
     ≥0.24 m torso clearance, stack 0.08 m, left hand 0.02 m from the handle,
     elbows 69°/92°, bat cocked up. The first pass scored hand-stack only and
     put both hands INSIDE the torso — the "arms in his body" QA failure.
     MINORITY-RIG MIRROR: every armR Z raw below (and through swing,
     checkswing, windup, pitchFollow, scoop and the bench/idle family)
     multiplies by zR = flipR ? −1 : +1. Offline-FK solving on
     live Hyle/Paul showed the mirrored-Z path reproduces the majority hand
     stack within rig tolerance, while unflipped majority raws miss by
     10–19 cm per keyframe and read as a broken stance/swing (the "Hyle and
     Paul position" bug). foreR carries no sig entry on ANY rig → shared.
     (POSE.idleBench's hands-on-hips branch is the catcher()-style exception:
     its flipR set is solved whole against Hyle/Paul rather than mirrored,
     because its Y/Z trade-off doesn't survive sign-flipping alone.)
     DANNY EXCEPTION (flipL): Danny is the ONLY rig with sig.armL.Z:+1
     (census: armL Z:−1 on the other ten FBX rigs), so shared armL coronal
     raws mirror on him — his catcher mitt used to read straight out. Every
     pose that takes flipL flips its armL raw Z (mL helper; X/Y shared
     untouched, exactly the armR zR idiom) and leaves foreL UNTOUCHED:
     flipping the raw Z makes Danny's final euler identical to the majority
     tuned one. Offline FK on the real Danny rig re-formed the solved mitt
     presentation (hand separation .76 m → .12 m); a full (−x,y,−z)
     conjugation was measured and rejected — it only matches while armL X ≈ 0
     (catcher), but flips the twist on X-dominant poses (bench/scoop err grew
     to .9 m). foreL is never flipped anywhere: flexion direction is
     anatomical, not calibrated. batReady / swing / checkswing are
     owner-approved and take NO flipL. */
  batReady(t, flipR) { const b = Math.sin(t*2.4)*.04; return [
    { Spine:[.38,.25,.26], Neck:[-.1,.62,0],             // plateward tilt+yaw+bend — leans the stack out over the dish
      armL:[1.38+b, 1.13, -2.91],  foreL:[0, 0, -1.67],
      armR: flipR ? mR([2.5-b, -0.75, -2.15]) : [2.5-b, -0.75, -2.15],
      foreR: flipR ? mF([0, 0, 1.02]) : [0, 0, 1.02],       // X-plane sweep + near-straight lead elbow carry the hands to the inner half; flipR conjugates via mR/mF (see helper above)
      legL:[.32,0,.08], legR:[.3,0,-.08] }, hp(0,-.045,.40)]; },
                                                           // hips tgp Z = world +X: the lean that puts the hands OVER the plate from the deep box
                                                           // (in-page solver, live FK: hand stack x ≈ -0.10/-0.20 at box -0.97; was -0.73 tucked at the chest)

  /* 3-phase swing: load/stride → explosion → extend & follow-through.
     Arm keyframes are the second solver pass's live-pipeline solutions at the
     phase boundaries (left hand ON the handle at every key: gripDist 0.00 /
     0.12 / 0.01 m), lerped between and continuous with the solved batReady —
     so both hands track the bat through the whole arc and GripIK never has to
     bridge a stretch. */
  swing(ph, flipR) { const p = clamp(ph, 0, 1);
    if (p < .25) {                                           // LOAD — hips coil, stride knee lifts
      const k = easeOut(p / .25); return [
      { Spine:[lerp(.38,.14,k), lerp(.25,-.72,k), lerp(.26,0,k)], Spine1:[0,-.19*k,0], Hips:[0,-.2*k,0],
        Neck:[-.1,.4,0],                                     // eyes stay on the pitcher through the coil
        armR: flipR ? mR([lerp(2.5,1.86,k), lerp(-.75,-.06,k), lerp(-2.15,-2.05,k)])
                    : [lerp(2.5,1.86,k), lerp(-.75,-.06,k), lerp(-2.15,-2.05,k)],   // hands gather from the plateward stack — continuous with batReady (flipR conjugates via mR)
        foreR: flipR ? mF([0, 0, lerp(1.02,1.1,k)]) : [0, 0, lerp(1.02,1.1,k)],
        armL:[lerp(1.38,-.45,k), lerp(1.13,2.43,k), lerp(-2.91,2.31,k)],
        foreL:[0, 0, lerp(-1.67,-.09,k)],
        legL:[lerp(.32,.56,k),0,.06], legLowL:[.72*k,0,0],
        legR:[.3,0,-.06], legLowR:[.1,0,0] }, hp(0, lerp(-.045,-.035,k), lerp(.40,0,k))]; }
    if (p < .55) {                                           // EXPLOSION — hips fire, arms sweep
      const s = easeIn((p - .25) / .3); return [
      { Spine:[.2, lerp(-.72,.92,s), 0], Spine1:[.04, lerp(-.19,.23,s), 0], Hips:[0, lerp(-.2,.15,s), 0],
        Neck:[-.04, lerp(.4,-.5,s), 0],                      // eyes pinned to contact point
        armR: flipR ? mR([lerp(1.86,.55,s), lerp(-.06,1.78,s), lerp(-2.05,1.42,s)])
                    : [lerp(1.86,.55,s), lerp(-.06,1.78,s), lerp(-2.05,1.42,s)],     // X stays +: swing plane stays LEVEL through the zone (old −1.18 flipped the barrel into a ground chop)
        foreR: flipR ? mF([0, 0, lerp(1.1,1.38,s)]) : [0, 0, lerp(1.1,1.38,s)],
        armL:[lerp(-.45,-.36,s), lerp(2.43,-1.62,s), lerp(2.31,2.63,s)],
        foreL:[0, 0, lerp(-.09,-.61,s)],
        legL:[lerp(.56,.3,s),0,.06], legLowL:[lerp(.72,.22,s),0,0],
        legR:[.28, -.55*s, -lerp(.06,.32,s)], legLowR:[lerp(.1,.3,s),0,0] },
      hp(0, lerp(-.03,-.05,s), lerp(0,.07,s))]; }
    const f = easeOut((p - .55) / .45); return [             // EXTEND — full rotation, back pivot
      { Spine:[.24, .92 + .17*f, 0], Spine1:[.06, .23 + .05*f, 0], Hips:[0, .15, -.1*f],
        Neck:[-.06 + .04*f, -.5 - .08*f, 0], Head:[0,-.1*f,0],
        armR: flipR ? mR([lerp(.55,2.07,f), lerp(1.78,-1.12,f), lerp(1.42,-1.3,f)])
                    : [lerp(.55,2.07,f), lerp(1.78,-1.12,f), lerp(1.42,-1.3,f)],     // Y caps at −1.12: old −2.02 curled the bat back INSIDE past contact instead of extending through the ball
        foreR: flipR ? mF([0, 0, lerp(1.38,.41,f)]) : [0, 0, lerp(1.38,.41,f)],
        armL:[lerp(-.36,1.9,f), lerp(-1.62,-.97,f), lerp(2.63,.23,f)],
        foreL:[0, 0, lerp(-.61,-1.79,f)],
        legL:[.3 - .04*f,0,.06], legLowL:[.22 - .08*f,0,0],
        legR:[.28 + .14*f, -(.55 + .2*f), -lerp(.32,.44,f)], legLowR:[.3 + .3*f,0,0] },
      hp(0, -.05 - .01*f, .07 + .05*f)]; },

  /* Aborted swing — barrel starts, brain says no: hard brake, recoil, regather.
     Regather endpoints are the solved batReady raws so the hands land back on
     the bat stack instead of the old library stance. */
  checkswing(ph, flipR) { const p = clamp(ph, 0, 1);
    const amp = p < .3 ? .4 * easeOut(p / .3)
              : p < .62 ? .4 * (1 - easeIO((p - .3) / .32)) : 0;
    const brake = p < .3 ? 0 : Math.sin(clamp((p - .3) / .32, 0, 1) * Math.PI) * .13;
    const g = easeOut(clamp((p - .62) / .38, 0, 1));         // regather to stance
    return [
      { Spine:[lerp(.14,.38,g) + brake, lerp(-.5 - .45*amp, .25, g), lerp(0,.26,g)], Spine1:[0, lerp(-.16*amp, 0, g), 0],
        Hips:[0, lerp(-.18*amp, 0, g), 0], Neck:[-.02, lerp(.4 + .2*amp, .62, g), 0],
        armR: flipR ? mR([lerp(2.0,2.5,g), lerp(2.3 + .5*amp, -.75, g), lerp(-.55 - .2*amp, -2.15, g)])
                    : [lerp(2.0,2.5,g), lerp(2.3 + .5*amp, -.75, g), lerp(-.55 - .2*amp, -2.15, g)],
        foreR: flipR ? mF([0, 0, lerp(2.28 + .15*amp, 1.02, g)]) : [0, 0, lerp(2.28 + .15*amp, 1.02, g)],
        armL:[lerp(2.0,1.38,g), lerp(-1.9 - .5*amp, 1.13, g), lerp(.55 + .2*amp, -2.91, g)],
        foreL:[0, 0, lerp(-2.02 - .15*amp, -1.67, g)],
        legL:[lerp(.32 + .18*amp, .32, g), 0, .07], legR:[.3, 0, -.07] },
      hp(0, -.045, lerp(-.05*amp, .40, g))]; },

  /* Post-K dejection — shoulders slump, head drops, slow head-shake.
     Arms HANG at the sides (probed FK: hands at hip line ~1.1 m, elbows
     nearly straight) instead of the old near-T-pose floats. */
  strikeoutCrouch(t, flipR, flipL) { const b = Math.sin(t * 1.3) * .02, h = Math.sin(t * .8) * .06; return [
    { Spine:[.34 + b, 0, 0], Spine1:[.26 + b*.6, 0, 0], Neck:[.5 + b, h, 0], Head:[.15, 0, 0],
      armL:mL([-.25, -1.6, 1.15], flipL), foreL:[0, 0, -.35],
      armR: flipR ? [-.25, -1.25, 1.5] : [-.25, -1.25, -1.5], foreR:[0, 0, .35],
      legL:[.42, 0, .09], legLowL:[.3,0,0], legR:[.42, 0, -.09], legLowR:[.3,0,0] },
    hp(0, -.12, 0)]; },

  /* Fielder throw (dur ≈ .4s): gather & cock back, then snap over the top. */
  throw(ph, flipR, flipL) { const p = clamp(ph, 0, 1);
    if (p < .45) { const k = easeOut(p / .45); return [
      { Spine:[.12, .7*k, 0], Spine1:[0, .15*k, 0],
        armR:[-.35*k, -.3*k, (flipR ? 2.35 : -2.35)*k], armL:mL([-.3, 0, .8*k], flipL),
        legL:[.5*k, 0, .08], legLowL:[.4*k,0,0], legR:[.2, 0, -.06] },
      hp(0, -.03*k, .05*k)]; }
    const s = easeIn((p - .45) / .55); return [
      { Spine:[.3, lerp(.7,-.3,s), 0], Spine1:[.05, lerp(.15,-.08,s), 0],
        armR:[lerp(-.35,.8,s), lerp(-.3,0,s), flipR ? lerp(2.35,.4,s) : lerp(-2.35,-.4,s)],
        armL:mL([-.3, 0, lerp(.8,.45,s)], flipL),
        legL:[lerp(.5,.3,s),0,.08], legLowL:[lerp(.4,.15,s),0,0],
        legR:[lerp(.2,.45,s),0,-.06], legLowR:[lerp(0,.5,s),0,0] },
      hp(0, lerp(-.03,.01,s), lerp(.05,.16,s))]; },

  /* Catcher pop-and-throw (dur-driven): explode from crouch, gather, snap. */
  catcherThrow(ph, flipR, flipL) { const p = clamp(ph, 0, 1);
    const zR = flipR ? 1 : -1;   // armR coronal raws are tuned negative (majority rigs)
    if (p < .38) { const k = easeOut(p / .38); return [
      { Spine:[lerp(.5,.18,k), 0, 0], Neck:[lerp(.3,0,k), 0, 0],
        armL:mL([lerp(-.9,-.4,k), 0, lerp(.7,.6,k)], flipL),
        armR:[lerp(-.9,-.4,k), 0, zR*lerp(.7,.6,k)],
        legL:[lerp(.72,.4,k), 0, lerp(.28,.1,k)], legLowL:[lerp(.95,.3,k),0,0],
        legR:[lerp(.72,.4,k), 0, lerp(-.28,-.1,k)], legLowR:[lerp(.95,.3,k),0,0] },
      hp(0, lerp(-.14,-.04,k), 0)]; }
    if (p < .58) { const k = easeOut((p - .38) / .2); return [   // gather — cock the arm
      { Spine:[.14, .6*k, 0], Spine1:[0, .12*k, 0],
        armR:[-.35*k, -.25*k, zR*lerp(.6,2.3,k)], armL:mL([-.35, 0, .7], flipL),
        legL:[.45, 0, .1], legLowL:[.25,0,0], legR:[.3, 0, -.08] },
      hp(0, -.04, .04*k)]; }
    const s = easeIn((p - .58) / .42); return [                  // release
      { Spine:[.28, lerp(.6,-.3,s), 0], Spine1:[.05, lerp(.12,-.06,s), 0],
        armR:[lerp(-.35,.8,s), lerp(-.25,0,s), zR*lerp(2.3,.4,s)],
        armL:mL([-.35, 0, lerp(.7,.4,s)], flipL),
        legL:[lerp(.45,.32,s),0,.1], legLowL:[lerp(.25,.12,s),0,0],
        legR:[lerp(.3,.42,s),0,-.08], legLowR:[lerp(0,.45,s),0,0] },
      hp(0, lerp(-.04,.01,s), lerp(.04,.14,s))]; },

  /* Fly-ball tracking: glove arm extended up-forward (G_1 probe), off-hand
     relaxed at the side. GripIK.stepCatch takes over within 1.5 m of ball. */
  catchUp(flipR, flipL) { return [{ Spine:[-.12,0,0],
    armL:mL([-.042,1.507,1.21], flipL), foreL:[0,0,-.218],
    armR: flipR ? [0,-1.7,1.7] : [0,-1.3,-1.75],
    foreR: flipR ? [0,0,0] : [0,0,-.05] }, hp()]; },

  /* Ground-ball pickup — deep bend-double crouch, glove down-forward, eyes
     down (infielders were reaching skyward with overhead catchUp at rollers).
     FK-solved offline against the real rigs: the glove PIVOT bottoms out at
     ≈0.40-0.50 m once the legs start clipping ground, so the mitt leather
     (~0.15 below pivot) meets a roller at ≈shoe-top height — the deepest
     pose that stays plausible without extending GripIK's catch gating.
     Glove-side raws are majority-tuned (Danny-class rigs conjugate via mL);
     the hanging right arm reuses the catchUp flipR idiom. Mapped beside
     catchUp in driveActor ('scoop'); FieldingAI opts in separately. */
  scoop(flipR, flipL) { return [
    { Spine:[1.28, 0, 0], Neck:[.32, 0, 0],
      legL:[1.05, 0, .14], legR:[1.05, 0, -.14], legLowL:[1.42, 0, 0], legLowR:[1.42, 0, 0],
      armL:mL([1.40, -2.80, 1.90], flipL), foreL:[0, 0, 0],
      armR: flipR ? [0, -1.7, 1.7] : [0, -1.3, -1.75],
      foreR: flipR ? [0, 0, 0] : [0, 0, -.05] },
    hp(0, -.50, .10)]; },

  /* Low-fielding stance — THE grounder breakdown (owner fix: chasers held
     the arms-up catchUp through the whole roller wait because FieldingAI's
     glove window stamped 'catch' on ANY planted chase). Held while a fielder
     is planted closing on a ball whose live height is under ~waist height
     (0.7 m — BallPhysics reports world metres, ground contact line .055):
     hinged torso, eyes down, glove-side hand reaching down-FORWARD between
     the knees toward the ball's line. FK-measured offline on real rigs via
     the exact Actor.update composition (.pose-lab/grounder.mjs): handL lands
     at 0.40-0.49 m — 0.14-0.22 m BELOW the crouched hip and ~1.5 m lower
     than the old catchUp hold (1.90-1.97 m) — while staying visibly
     shallower than scoop's deeper contact gather (hips -.40 vs -.50).
     Tall hops/liners stay in the ready/catch vocabulary; catcher receive is
     untouched. GripIK deliberately does NOT drive this state ('catch'/
     'catcher' only): the pose already meets the roller, and the pickup suck
     targets the true gloveWorld either way. Glove-side raws shared from the
     solved scoop family (Danny-class conjugates via mL); hanging right arm
     reuses the ready/catchUp flipR idiom; breath sway mirrors ready(). */
  fieldLow(t, flipR, flipL) { const b = Math.sin(t*2.2)*.03; return [
    { Spine:[1.14+b*.5, 0, 0], Spine1:[.40+b*.3, 0, 0], Neck:[.28, 0, 0],
      legL:[.75, 0, .12], legR:[.75, 0, -.12], legLowL:[1.10, 0, 0], legLowR:[1.10, 0, 0],
      armL:mL([1.30, -2.80, 1.90], flipL), foreL:[0, 0, 0],
      armR: flipR ? [0,-1.7,1.7] : [0,-1.3,-1.75],
      foreR: flipR ? [0,0,0] : [0,0,-.05] },
    hp(0, -.40, .08)]; },

  /* Bench vocabulary — relaxed off-duty variants so a resting club doesn't
     read as a row of sentries. Variant A (even seeds): hands-on-hips weight
     shift — solved PER RIG CLASS exactly like catcher() above (Hyle/Paul
     calibrate differently; majority set from Kevo). Variant B: heavy slouch,
     arms hanging long, lazy look-around. `seed` is a stable per-actor hash
     (assigned in driveActor) that de-syncs clocks and picks the variant —
     the bench never breathes in unison. Rendered whenever an FBX actor's
     animState is 'idle' AND onDuty === false; on-field actors keep POSE.idle. */
  idleBench(t, seed = 0, flipR = false, flipL = false) {
    const v = seed % 2;
    const ph = t + (seed % 17) * .83;                        // de-synced phase per actor
    const w = Math.sin(ph * .37 + (seed % 10));              // slow weight shift
    const br = Math.sin(ph * 1.31) * .03;                    // breath
    const yaw = Math.sin(ph * .19 + (seed % 7)) * .16;       // lazy spine look-around
    if (v === 0) return [
      { Spine:[.13 + br * .5, yaw, -w * .05], Spine1:[.05, yaw * .35, 0],
        Neck:[.04, Math.sin(ph * .27 + (seed % 5)) * .28, 0],
        armL:mL([1.6 + br, -.975, .266 + w * .03], flipL), foreL:[0, 0, -.06],
        armR: flipR ? [1.6 + br, -1.0, .32 - w * .03] : [1.6 + br, -.862, -.499 - w * .03],
        foreR: flipR ? [0, 0, .05] : [0, 0, -.105] },
      hp(0, -.08 + Math.abs(w) * .008, 0)];
    return [
      { Spine:[.24 + br, yaw * .7, w * .04], Spine1:[.10, yaw * .3, 0],
        Neck:[.10, Math.sin(ph * .23) * .34, 0],
        armL:mL([.12, -1.55 + Math.sin(ph * .5) * .06, 1.28], flipL), foreL:[0, 0, -.22],
        armR: flipR ? [.12, -1.55, 1.62] : [.12, -1.28, -1.66],
        foreR: flipR ? [0, 0, .04] : [0, 0, -.06] },
      hp(0, -.065, 0)];
  },

  /* Arm pump probed per-axis on the live rigs: the sagittal swing lives in Y
     (left fwd at −2.7 / back at −0.8; right mirrored about its hang), elbows
     fold via fore Z — NEGATIVE on the left, POSITIVE on the right (~95–110°). */
  run(ph, flipR, flipL) { const s = Math.sin(ph*11), c = Math.cos(ph*11); return [
    { legL:[s*.85,0,.05], legLowL:[.15 + .5*Math.max(0,-s),0,0],
      legR:[-s*.85,0,-.05], legLowR:[.15 + .5*Math.max(0,s),0,0],
      armL:mL([0, -1.75 + s*.95, 1.35], flipL), foreL:[0, 0, -1.35],
      armR:[0, -1.3 - s*.8, flipR ? 1.7 : -1.75], foreR:[0, 0, 1.3],
      Spine:[.22,0,0], Spine1:[0,-s*.08,0] }, hp(0, Math.abs(c)*-.03, 0)]; },

  /* Jog — softer, slower run variant (ph*7). */
  jog(ph, flipR, flipL) { const s = Math.sin(ph*7), c = Math.cos(ph*7); return [
    { legL:[s*.6,0,.05], legLowL:[.14 + .38*Math.max(0,-s),0,0],
      legR:[-s*.6,0,-.05], legLowR:[.14 + .38*Math.max(0,s),0,0],
      armL:mL([0, -1.75 + s*.6, 1.35], flipL), foreL:[0, 0, -1.0],
      armR:[0, -1.3 - s*.55, flipR ? 1.7 : -1.75], foreR:[0, 0, 1.0],
      Spine:[.15, c*.03, 0] }, hp(0, Math.abs(c)*-.02, 0)]; },

  /* Overhead V: raw X ≈ −3 lifts EITHER arm past vertical on these rigs
     (probed — coronal Z sweeps stay at shoulder height from T-pose rest). */
  cheer(flipR, flipL) { return [{ armL:mL([-3.1,0,-.3], flipL), armR:[-3.1,0,-.3],
    foreL:[0,0,-.2], foreR:[0,0,.2], Spine:[-.12,0,0], Neck:[-.15,0,0] }, hp()]; },

  /* Crouch with the mitt presented: arms FK-solved PER RIG FAMILY against the
     crouched spine (in-page solver, hands ≤0.03 m apart, chest-high ~1.02 m,
     in front toward the pitcher). Hyle/Paul calibrate armR Z:−1 and carry
     their own solution; every other rig — including the Player clones that
     catch for the visitors — shares the majority set, EXCEPT Danny whose
     sig.armL Z:+1 conjugates the glove arm (mL; foreL shared — offline FK
     put hand separation at .12 m vs .68 m if foreL were also mirrored).
     Fixes the old right-arm-stuck-straight-out look (raws barely raised). */
  catcher(t, flipR, flipL) {
    const b = Math.sin(t*1.8)*.02;
    const A = flipR
      ? { aL:[-1.261,-1.019,2.655], fL:[0,0,-1.357], aR:[-1.094,-1.994,2.525], fR:[0,0,-1.42] }
      : { aL:mL([-.037,-2.62,1.324], flipL),
          fL:[0,0,-1.487], aR:[-1.045,-2.603,-2.993], fR:[0,0,-1.481] };
    return [
      { Spine:[.5+b,0,0], legL:[.72,0,.28], legLowL:[.95,0,0],
        legR:[.72,0,-.28], legLowR:[.95,0,0],
        armL:A.aL, foreL:A.fL, armR:A.aR, foreR:A.fR },
      /* tgp units are WORLD METRES (Actor.update converts out of raw bone
         units via unitInv — FBX exports vary 0.013–2.0 in bone scale). The
         crouch depth QA approved (hips ≈0.72, head ≈1.33) corresponds to a
         .27 m sink. */
      hp(0, -.27, 0)];
  },
};

/* ======================================================================
   COSMETIC MICRO-THEATRE — wiring for the otherwise-dead checkswing and
   cheer poses. STRICTLY cosmetic: these hooks only ever SWAP WHICH POSE
   renders by retagging a.animState. They never touch G, swing timing
   (G.swungAt), judgeTake/resolveSwing, contact, or scoring — every
   injected state is tagged `_fx` and self-restores to exactly the state
   object the director staged before us, and only while that tag is still
   live (any Game.js state change silently orphans the injection).
====================================================================== */
const FX_TAG = '_fx';
const CHECKSWING_DUR = .85;   // commit → brake → regather, one breath
const CHEER_DUR = 1.05;       // fits inside the 1.7 s strikeout DEAD hold
/* QA affordance: the ?fix=w2d gauntlet tab sees frequent checkswings so a
   0.85 s pose can actually be screenshotted; production stays rare. */
const CHECKSWING_P = typeof location !== 'undefined' && /fix=w2d/.test(location.search) ? .5 : .14;
const CHEER_OVER = new Set(['ready', 'catcher', 'idle']);   // never interrupt live work
const seenActors = new Set();                               // every actor driveActor has driven
let prevBallMode = ball.mode;
let csFireAt = null;          // scheduled checkswing instant for the pitch in flight

/** Swap `a` into a tagged cosmetic state, remembering what was there. */
function injectFx(a, name, dur, tag) {
  a.animState = { name, start: now(), dur, [FX_TAG]: tag, _prev: a.animState };
}

/**
 * Cheer the battery. Exported so a future Game.js pass can fire it on
 * moments that carry no animState signal (run-scoring, half-end) with a
 * single call — see report. Safe to call any time: only quiescent
 * defenders (ready/catcher/idle) are retagged, everyone else is skipped.
 *
 * `opts.onDuty` restricts the sweep to actors currently ON the field
 * (prepFielder sets onDuty, the bench staggers clear it). The strikeout
 * trigger passes it: only the FIELDING battery may cheer a K — the
 * batting club's benched battery shares the same role names and used to
 * celebrate its own hitter's strikeout. Game.js's cheerLinRuns keeps
 * calling the bare sweep: its role-nulling mask already scopes the
 * celebration to LIN's benched battery, and an onDuty filter would
 * exclude exactly the actors that path means to cheer.
 */
export function fxCheer(opts = {}) {
  for (const f of seenActors)
    if (f.ready && (f.role === 'Pitcher' || f.role === 'Catcher') &&
        (!opts.onDuty || f.onDuty) &&
        CHEER_OVER.has(f.animState.name) && !f.animState[FX_TAG])
      injectFx(f, 'cheer', CHEER_DUR, 'cheer');
}

/** Per-frame trigger scan — runs before the pose switch, allocates nothing
    on steady state. Both branches key off data already inside the
    animation pipeline: ball flight mode + the actor's own animState. */
function fxTriggers(a, st, time) {
  const mode = ball.mode;
  /* New pitch in flight → roll the checkswing dice once per pitch. Only a
     batter still holding `batReady` can fire, i.e. a TAKE: a real swing
     replaces the state before the scheduled instant, so contact timing is
     untouched by construction. */
  if (mode === 'pitched' && prevBallMode !== 'pitched')
    csFireAt = Math.random() < CHECKSWING_P ? time + rand(.22, .45) : null;
  else if (mode !== 'pitched') csFireAt = null;
  prevBallMode = mode;

  if (csFireAt !== null && time >= csFireAt) {
    if (mode === 'pitched' && st.name === 'batReady' && !st[FX_TAG]) {
      csFireAt = null;
      injectFx(a, 'checkswing', CHECKSWING_DUR, 'cs');
    }
    return;
  }
  /* Strikeout onset (batter enters strikeoutCrouch — the only scorebook
     event that flows through animState) → the FIELDING battery celebrates.
     onDuty keeps the hitter's own benched battery out of the sweep. Run
     scoring carries NO animState signal, so it stays a reported hook. */
  if (st.name === 'strikeoutCrouch' && !st._fxCheer) {
    st._fxCheer = true;
    fxCheer({ onDuty: true });
  }
}

/**
 * Drive an actor's animation state into concrete pose targets each frame.
 * `now()` supplies game time; state shape: {name, start, dur?}.
 */
export function driveActor(a, time) {
  if (!a.ready) return;
  /* debug handle — lets the harness reach live Actor instances (window.__A[name]) */
  const W = typeof window !== 'undefined' && window;
  if (W) (W.__A || (W.__A = {}))[a.name] = a;
  seenActors.add(a);
  /* Expire an injected cosmetic state by restoring exactly what the
     director staged before it — but only while the tag still owns the
     slot; a Game.js state change has already orphaned it. */
  if (a.animState[FX_TAG] && a.animState.dur && time - a.animState.start >= a.animState.dur &&
      a.animState._prev)
    a.animState = a.animState._prev;
  fxTriggers(a, a.animState, time);          // may retag a.animState (cosmetic only)
  /* Post-whiff hold (hitter audit #3): once the swing's dur is spent and
     Game.js still holds this animState (at-bat DEAD), relax out of the
     frozen follow-through into batReady after .45 s. Cosmetic and one-way:
     tagged FX_TAG so the checkswing dice can't fire on it, no dur/_prev so
     it never auto-expires — any Game.js restage (next pitch stages
     batReady fresh at Game.js:315/676) simply overwrites the slot.
     trySwing gates on G.swungAt/G.state, never animState, so this cannot
     re-arm batting input. */
  if (a.animState.name === 'swing' && a.animState.dur &&
      time - a.animState.start > a.animState.dur + .45)
    a.animState = { name:'batReady', start:time, [FX_TAG]:'whiff-hold' };
  const st = a.animState, ph = time - st.start, dp = st.dur ? ph / st.dur : 1;
  const flipR = !!(a.sig && a.sig.armR && a.sig.armR.Z === -1);   // per-rig right-arm branch
  const flipL = !!(a.sig && a.sig.armL && a.sig.armL.Z === 1);    // Danny-class glove arm
  /* Family facing — Mixamo FBX exports face +Z, the frame every pose raw
     was FK-tuned in; the humanoid/pill fallbacks are BUILT facing −Z
     (makeHumanoid: eyes, palm line and toes all at −Z). Conjugating the
     π Y-turn maps a raw euler (x,y,z) to (−x, y, −z), so for fallback rigs
     the TORSO chain's X/Z are negated centrally here — one wrapper instead
     of a second branch inside every pose. Y is turn-symmetric and stays;
     arms/legs keep their empirically tuned primitive sigs (hardcoded in
     Actor.use), which already read correctly on those rigs. */
  const negZ = a.bones ? 1 : -1;
  const pose = (tg, tgp) => {
    if (negZ < 0)
      for (const k of ['Spine', 'Spine1', 'Neck', 'Head']) {
        const w = tg[k];
        if (w) tg[k] = [-w[0], w[1], -w[2]];
      }
    a.setPose(tg, tgp);
  };
  switch (st.name) {
    case 'ready':           pose(...POSE.ready(time, flipR, flipL)); break;
    case 'windup':          pose(...POSE.windup(dp, flipR, flipL)); break;
    case 'pitchFollow':     pose(...POSE.pitchFollow(flipR, flipL)); break;
    case 'batReady':        pose(...POSE.batReady(time, flipR)); break;   // owner-approved: no flipL
    case 'swing':           pose(...POSE.swing(dp, flipR)); break;        // owner-approved: no flipL
    case 'checkswing':      pose(...POSE.checkswing(dp, flipR)); break;   // owner-approved: no flipL
    case 'strikeoutCrouch': pose(...POSE.strikeoutCrouch(time, flipR, flipL)); break;
    case 'throw':           pose(...POSE.throw(dp, flipR, flipL)); break;
    case 'catcherThrow':    pose(...POSE.catcherThrow(dp, flipR, flipL)); break;
    case 'run':
      pose(...POSE.run(ph, flipR, flipL));
      if (a.model) a.model.position.y = a.baseY + Math.abs(Math.sin(ph * 11)) * .05;
      break;
    case 'jog':
      pose(...POSE.jog(ph, flipR, flipL));
      if (a.model) a.model.position.y = a.baseY + Math.abs(Math.sin(ph * 7)) * .03;
      break;
    case 'catch':   pose(...POSE.catchUp(flipR, flipL)); break;
    case 'scoop':   pose(...POSE.scoop(flipR, flipL)); break;   // ground-ball pickup — FieldingAI opts in
    case 'fieldLow': pose(...POSE.fieldLow(time, flipR, flipL)); break;   // grounder breakdown — FieldingAI gates on live ball height
    case 'cheer':   pose(...POSE.cheer(flipR, flipL)); break;
    case 'catcher': pose(...POSE.catcher(time, flipR, flipL)); break;
    case 'idle':                                         // bench vocabulary: off-duty FBX actors
      if (a.onDuty === false && a.bones) {               // relax (see POSE.idleBench); on-field stays POSE.idle
        const seed = a._poseSeed || (a._poseSeed = (() => {
          let h = 7; for (const c of a.name) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h;
        })());
        pose(...POSE.idleBench(time, seed, flipR, flipL));
      } else pose(...POSE.idle(time, flipR, flipL));
      break;
    default:        pose(...POSE.idle(time, flipR, flipL));
  }
  if (st.name !== 'run' && st.name !== 'jog' && a.model)
    a.model.position.y += (a.baseY - a.model.position.y) * .2;   // settle back to ground
}
