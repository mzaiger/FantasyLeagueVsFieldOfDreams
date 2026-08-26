/* =====================================================================
   GripIK.js — two-handed bat grip + glove-reach catch assist
   Part of the Lincoln Red Gauntlet engine · js/animation/

   Integration point (chosen): Actor.postDrive hook. PlayerFactory's
   Actor.update() calls `if (!this._grip) this._grip = attachGripIK(this);`
   then `if (this.postDrive) this.postDrive(dt);` after its channel-damping
   loop, so this module's constraints run AFTER pose damping each frame and
   win over pose targets without fighting them; on release, damping restores
   the pose naturally and we ease the hand position back to rest.

   Goals served here (FBX rigs only — pills/humanoids have no bones and are
   skipped silently):
     A. batReady/swing/checkswing: LeftHand grasps the bat handle just above
        the RightHand (world anchor = the bat MOUNT group's origin carried
        one grip gap up the MOUNT's own axis — see stepGrip for why the
        mount, not the hand bone), wrapped π about the bat axis so the
        mirrored palm reads as gripping.
     B. catch / catcher: while the live ball is within CATCH_RANGE of the
        glove hand,
        ease the mitt toward it (pulled 20% back toward the shoulder, total
        displacement clamped to MAX_REACH from the unconstrained pose spot).
        Position-only on purpose — the catchUp pose already aims the palm.

   Zero per-frame allocation: every matrix/vector/quaternion below is a
   module-scope scratch reused across frames and actors.
===================================================================== */
import * as THREE from 'three';
import { dampF } from '../utils/MathUtils.js';
import { ball } from '../physics/BallPhysics.js';

/* ---- Tunables ---------------------------------------------------------- */
const BAT_STATES = new Set(['batReady', 'swing', 'checkswing']);
const GRIP_GAP = .09;          // WORLD METRES above the right hand along the bat axis
                               // (was ×model.scale ≈ 2 mm on Player rigs — hands stacked dead)
const WRAP_Z = Math.PI;        // roll of left palm about the bat axis (flip sign if palms read wrong)
const GRIP_DAMP = 18;          // slerp/lerp rate while gripping
const RELEASE_DAMP = 10;       // rate easing handL back to rest after a constraint ends
const CATCH_RANGE = 1.5;       // engage glove reach inside this distance to the live ball
const CATCH_PULLBACK = .2;     // pull target 20% back toward the shoulder (no overstretch)
const CATCH_MAX_REACH = .55;   // WORLD METRES of glove extension toward the ball
                               // (was ×model.scale ≈ 1 cm on Player rigs — reach was dead)
const MAX_IK_PULL = .16;       // WORLD METRES — hard cap on grip drag from rest (stretch guard)
                               // (.12 clamped away most of the mount-axis anchor correction —
                               // live stack measured .149 m; .16 leaves the fix headroom while
                               // staying far under the ~.86 m malformed-arm disaster)

/* ---- Scratch (module scope — NEVER allocate in the frame path) --------- */
const _pm = new THREE.Matrix4();    // parent inverse for world→local
const _dir = new THREE.Vector3();   // bat axis in world space
const _wp = new THREE.Vector3();    // right-hand world position
const _hw = new THREE.Vector3();    // left-hand world position
const _sh = new THREE.Vector3();    // shoulder proxy world position
const _dv = new THREE.Vector3();    // clamped reach displacement
const _vW = new THREE.Vector3();    // desired world position
const _vL = new THREE.Vector3();    // desired local position (out)
const _qRH = new THREE.Quaternion();// right-hand world quaternion
const _qW = new THREE.Quaternion(); // desired world quaternion
const _qp = new THREE.Quaternion(); // parent world quaternion
const _qL = new THREE.Quaternion(); // desired local quaternion (out)
const _qWrap = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, WRAP_Z));

/* World → local for a bone whose parent carries it (hand.parent is normally
   the forearm; we read hand.parent.matrixWorld generically, no assumption). */
function toLocal(bone, wPos, wQuat) {
  const par = bone.parent;
  if (!par) return false;
  _pm.copy(par.matrixWorld).invert();
  _vL.copy(wPos).applyMatrix4(_pm);
  par.getWorldQuaternion(_qp);
  _qL.copy(_qp).invert().multiply(wQuat);
  return true;
}

/* Cap a desired local hand position so the grip can never drag the hand far
   enough from its rest spot to stretch the skinned forearm — the malformed-
   arm bug: a pose whose hand sat ~0.86 m from the bat had stepGrip hauling
   lh.position across the full gap every frame with no clamp. Displacement is
   in raw bone units, so the cap converts world metres through unitInv (the
   same conversion Actor.update applies to tgp offsets). */
function clampPull(actor, vL) {
  const rp = actor.restPos && actor.restPos.get('handL');
  if (!rp) return;
  _dv.copy(vL).sub(rp);
  const maxLocal = MAX_IK_PULL * actor.unitInv;
  if (_dv.lengthSq() > maxLocal * maxLocal) {
    _dv.setLength(maxLocal);
    vL.copy(rp).add(_dv);
  }
}

/* Goal A — left hand onto the bat handle just above the right hand. */
function stepGrip(actor, ch, dt) {
  const rh = ch.handR, lh = ch.handL;
  /* attachGear nests the bat mesh inside a scale-normalising mount group, so
     the bat is a GRANDCHILD of the hand — search the subtree, direct
     children only ever missed it and the grip silently never ran. */
  const bat = rh.getObjectByName('bat');
  if (!bat) return;
  /* Anchor off the bat MOUNT's world matrix (grip-anchor bug, hitter audit
     #1): bakeBarrelVerticality + the -.1 x-tilt counter-rotate the mount
     inside the hand, so the HAND frame's +Y is not the bat axis — anchoring
     on the hand measured a .13 m knob-side gap. The mount's own world
     transform carries the live axis (+Y up the barrel, corrections from the
     stance stabiliser included) and its origin sits at the right-hand grip
     point, so anchor = mount origin + GRIP_GAP along the mount axis. */
  const mount = bat.parent;
  if (!mount) return;
  mount.updateWorldMatrix(true, false);
  _dir.set(0, 1, 0).transformDirection(mount.matrixWorld);    // bat runs +Y from its mount
  _wp.setFromMatrixPosition(mount.matrixWorld);               // grip point at the mount origin
  _vW.copy(_wp).addScaledVector(_dir, GRIP_GAP);              // world metres — rig-independent
  rh.getWorldQuaternion(_qRH);
  _qW.copy(_qRH).multiply(_qWrap);                            // mirrored palm wraps the cylinder
  if (!toLocal(lh, _vW, _qW)) return;
  clampPull(actor, _vL);                                      // never stretch the forearm
  const k = dampF(GRIP_DAMP, dt);
  lh.quaternion.slerp(_qL, k);
  lh.position.lerp(_vL, k);
}

/* Goal B — mitt meets the live ball before FieldingAI hides it. */
function stepCatch(actor, ch, dt) {
  const lh = ch.handL, armL = ch.armL;
  if (!armL || !ball.mesh || !ball.mesh.visible) return;
  lh.updateWorldMatrix(true, false);
  _hw.setFromMatrixPosition(lh.matrixWorld);
  if (_hw.distanceTo(ball.pos) > CATCH_RANGE) return;
  armL.getWorldPosition(_sh);
  _vW.copy(ball.pos).lerp(_sh, CATCH_PULLBACK);               // keep some elbow in the arm
  _dv.copy(_vW).sub(_hw);                                     // clamp total reach from pose spot
  const maxR = CATCH_MAX_REACH;                               // world metres — rig-independent
  if (_dv.lengthSq() > maxR * maxR) { _dv.setLength(maxR); _vW.copy(_hw).add(_dv); }
  if (!toLocal(lh, _vW, lh.getWorldQuaternion(_qW))) return;  // orientation unchanged (position-only)
  lh.position.lerp(_vL, dampF(GRIP_DAMP, dt));
}

/* postDrive body — `this` is the Actor. Never throws; no-ops on rigs that
   lack bones/channels (pills, humanoids, partial FBX sets). */
function gripStep(dt) {
  const actor = this, ch = actor.channels;
  if (!actor.bones || !ch.handL || !ch.handR || !actor.model) return;
  const name = actor.animState.name;
  if (BAT_STATES.has(name)) {
    stepGrip(actor, ch, dt);
    actor._gripMode = 'grip';
  } else if (name === 'catch' || name === 'catcher') {   // catcher audit: receive gate covers the presented mitt too
    stepCatch(actor, ch, dt);
    actor._gripMode = 'catch';
  } else if (actor._gripMode) {                // just released — restore hand position;
    const rp = actor.restPos.get('handL');     // quaternion recovers via pose damping
    if (rp) {
      const lh = ch.handL;
      lh.position.lerp(rp, dampF(RELEASE_DAMP, dt));
      if (lh.position.distanceToSquared(rp) < 1e-6) actor._gripMode = null;
    } else actor._gripMode = null;
  }
}

/**
 * Install the GripIK post-drive pass on an actor. No-op (returns false)
 * while the actor has no FBX bones/hand channels — pills and humanoids
 * never get a postDrive; if such an actor is later hot-swapped to an FBX
 * rig, the caller's falsy `_grip` guard retries us automatically.
 */
export function attachGripIK(actor) {
  const ch = actor.channels;
  if (!actor.bones || !ch || !ch.handL || !ch.handR) return false;
  if (!actor.postDrive) actor.postDrive = gripStep;
  return true;
}
