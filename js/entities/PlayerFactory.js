/* =====================================================================
   PlayerFactory.js — character construction: FBX w/ pre-check, humanoid
   & pill fallbacks, foot grounding, gear attachment, the Actor rig wrapper.
   Part of the Lincoln Red Gauntlet engine · js/entities/
===================================================================== */
import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { scene } from '../core/SceneManager.js';
import { canvasTex } from '../utils/MathUtils.js';
import { rand, rint, pick, dampF } from '../utils/MathUtils.js';
import { findBones, BONE_CHANNEL_MAP, calibrateSigns } from '../animation/AnimationController.js';
import { attachGripIK } from '../animation/GripIK.js';
import { enrollRunnerBody } from './RunnersHelpers.js';
import { LIN } from '../core/Constants.js';

/* ---- Shared geometry & materials -------------------------------------- */
const SKIN = [0xf1c7a3, 0xd9a06b, 0xa9714b, 0x7c4a2d, 0x5b3620];
let lastSkin = -1;
const nextSkin = () => {                                         // per-actor tone variety: adjacent spawns never repeat
  if (SKIN.length < 2) return 0;
  let i; do { i = rint(0, SKIN.length - 1); } while (i === lastSkin);
  lastSkin = i; return i;
};
const GEO = {
  caps:new THREE.CapsuleGeometry(.34,.62,6,14), head:new THREE.SphereGeometry(.215,18,14),
  cap:new THREE.SphereGeometry(.225,18,10,0,Math.PI*2,0,Math.PI/2), brim:new THREE.BoxGeometry(.2,.035,.16),
  arm:new THREE.CapsuleGeometry(.09,.34,4,10), hand:new THREE.SphereGeometry(.095,10,8),
  leg:new THREE.CapsuleGeometry(.115,.34,4,10),
  hshell:new THREE.SphereGeometry(.225,20,12,0,Math.PI*2,0,2.0),   // deep batting-helmet shell (114° from crown)
  flap:new THREE.SphereGeometry(1,10,8),                           // unit sphere, sized per-instance for the ear flap
  mittPalm:new THREE.SphereGeometry(.15,14,12),                    // mitt pocket slab (flattened per-instance)
  mittThumb:new THREE.CapsuleGeometry(.045,.09,4,8),
  mittCuff:null,                                                   // built below: torus re-axled onto Y
  hairDome:new THREE.SphereGeometry(1,16,12,0,Math.PI*2,0,1.95),   // unit partial sphere, sized per-instance
  fringe:new THREE.BoxGeometry(1,1,1),                             // unit box, scaled to a brow-line tuft
  bat:null
};
{ const c = new THREE.TorusGeometry(.10,.034,8,18); c.rotateX(Math.PI / 2); GEO.mittCuff = c; }   // hole axis → Y (wrist)
/* Bat — lathe profile, knob at y=0 (the grip end, where both mounts pivot),
   1.07u overall. Rounded knob Ø.059 → waisted handle Ø.027 → smooth taper →
   barrel Ø.073 with a gentle mid-barrel swell → domed tip. Handle:barrel
   diameter ratio ≈ 1:2.6, matching a real -3 adult bat. */
{
  const P = [[0,0],[.021,0],[.0285,.0045],[.0295,.011],[.0245,.019],[.016,.027],
             [.0142,.05],[.0136,.12],[.0139,.20],[.0149,.285],[.0162,.365],
             [.0192,.445],[.0234,.52],[.0283,.595],[.0323,.67],[.035,.745],
             [.0363,.82],[.0366,.885],[.036,.95],[.0344,1.002],[.0298,1.04],
             [.0205,1.061],[0,1.07]];
  GEO.bat = new THREE.LatheGeometry(P.map(p => new THREE.Vector2(p[0], p[1])), 18);
}

const matCache = new Map();
export const teamMat = (hex, rough = .8) => {
  const k = hex + '|' + rough;
  if (!matCache.has(k)) matCache.set(k, new THREE.MeshStandardMaterial({ color:new THREE.Color(hex), roughness:rough }));
  return matCache.get(k);
};

/* ---- Cap builder — dome + short brim sized to a skull radius `r`.
       Shell ≈ 1.08× skull radius, equator just above the eye line so the
       crown sits ON TOP of the head instead of swallowing the face.
       `fz` = facing sign of the wearer: +1 brim toward +Z (FBX/Mixamo
       rigs), −1 brim toward −Z (pill & humanoid primitives). ------------- */
export function makeCap(mat, r = .11, fz = 1) {
  const g = new THREE.Group();
  const dome = new THREE.Mesh(GEO.cap, mat);
  dome.scale.setScalar(r * 1.08 / .225);
  dome.position.set(0, r * .05, -fz * r * .03);                 // eased back off the brow
  g.add(dome);
  const brim = new THREE.Mesh(GEO.brim, mat);
  brim.scale.set(r * 11, .85, r * 5);                           // short: ≈2.2r wide, .8r deep
  brim.position.set(0, r * .1, fz * r * .98);
  brim.rotation.x = fz * .12;                                   // front edge dips slightly
  g.add(brim);
  return g;
}

/* ---- Batting helmet — deeper than the cap so the shell reads as a
       helmet, not a skull cap. The 114° shell is tilted forward ≈12°:
       the brow-side rim lifts clear of the eyes while the rear rim drops
       to the occiput and the side rims cross the ear line; a squashed-Y
       ellipsoid keeps the crown just proud of the skull. Short front
       brim rides the brow line, and an ear-flap bump covers the wearer's
       LEFT ear (the one a RH batter presents to the pitcher — flap x-sign
       follows the same handedness as `fz`). Same facing convention as
       makeCap: +1 brim toward +Z (FBX/Mixamo), −1 toward −Z (humanoid). */
export function makeHelmet(mat, r = .11, fz = 1) {
  const g = new THREE.Group(), k = r * 1.15 / .225;
  const dome = new THREE.Mesh(GEO.hshell, mat);
  dome.scale.set(k * 1.03, k * .78, k);                         // a touch wide over the ears, flatter crown
  dome.position.set(0, r * .80, -fz * r * .02);                 // eased back off the brow
  dome.rotation.x = -fz * .21;                                  // brow rim up, rear rim down past the ears
  g.add(dome);
  const brim = new THREE.Mesh(GEO.brim, mat);
  brim.scale.set(r * 10, .6, r * 4.2);                          // short: ≈2r wide, .7r deep
  brim.position.set(0, r * .78, -fz * r * 1.02);
  brim.rotation.x = fz * .10;                                   // front edge dips over the view
  g.add(brim);
  const flap = new THREE.Mesh(GEO.flap, mat);
  flap.scale.set(r * .16, r * .34, r * .27);
  flap.position.set(fz * r * .99, r * .26, -fz * r * .03);      // jaw-level bump under the left rim
  g.add(flap);
  return g;
}

/* ---- Catcher's mitt — a real leather shape, not a brown ball.
       Canonical frame: pocket opens toward −Z, wrist cuff up (+Y), thumb
       on the +X edge (worn on the LEFT hand). Callers orient the wrapper
       per rig — humanoid handL hangs it as-is; FBX LeftHand spins it π
       about Z so the cuff lands on the wrist side of the bone.
       Fielder version: cupped palm slab + darker web inset + triangle web
       strip bridging the thumb side to the top edge, four finger ridges
       along the far edge, two lace crosses on the rim, angled thumb stall
       + slimmed torus cuff; two-tone leather; roughness is jittered per
       mitt by the callers' cached material picks.
       Catcher version (catcher:true): the big round target — a deep bowl
       shell with a rolled rim, crossed web bands over the mouth, thumb
       stall + index loop on the edges, padded wrist roll. --------------- */
function makeMitt(leather = teamMat('#7a4f28', .82), web = teamMat('#5c3b1d', .9), catcher = false) {
  const g = new THREE.Group();
  if (catcher) {
    const R = .17;
    const bowl = new THREE.Mesh(                                  // deep pocket: sphere shell,
      new THREE.SphereGeometry(R, 20, 12, 0, Math.PI * 2,         // equator → south pole
        Math.PI * .5, Math.PI * .56), leather);
    bowl.rotation.x = -Math.PI / 2;                               // mouth → −Z, depth → wrist
    g.add(bowl);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(R * .99, .024, 10, 28), leather);
    rim.position.z = -.004;                                       // rolled leather lip on the mouth
    g.add(rim);
    const pocket = new THREE.Mesh(new THREE.CircleGeometry(R * .8, 20),
      new THREE.MeshStandardMaterial({ color:'#4a2f16', roughness:.95 }));
    pocket.position.z = .01;                                      // dark hollow just inside the mouth
    pocket.rotation.y = Math.PI;                                  // face −Z (out toward the pitcher)
    g.add(pocket);
    for (const a of [-.62, 0, .62]) {                             // crossed web bands over the mouth
      const band = new THREE.Mesh(new THREE.BoxGeometry(R * 1.92, .024, .012), web);
      band.rotation.z = a; band.position.z = -.022;
      g.add(band);
    }
    const thumb = new THREE.Mesh(new THREE.CapsuleGeometry(.034, .1, 4, 8), web);
    thumb.position.set(R * .8, .02, -.02);
    thumb.rotation.set(-.15, 0, -.52);                            // thumb stall off the +X edge
    g.add(thumb);
    const loop = new THREE.Mesh(new THREE.TorusGeometry(.048, .015, 8, 16), leather);
    loop.position.set(-R * .78, .02, -.02);
    loop.rotation.y = Math.PI / 2;                                // index-finger loop, −X edge
    g.add(loop);
    const cuff = new THREE.Mesh(GEO.mittCuff, leather);
    cuff.position.set(0, .105, -.01);                             // wrist ring at the forearm end
    g.add(cuff);
    const roll = new THREE.Mesh(new THREE.CapsuleGeometry(.03, .12, 4, 8), leather);
    roll.rotation.z = Math.PI / 2;                                // padded roll across the cuff
    roll.position.set(0, .14, -.01);
    g.add(roll);
    return g;
  }
  const palm = new THREE.Mesh(GEO.mittPalm, leather);
  palm.scale.set(1, .95, .55);                                  // flattened pocket slab
  palm.rotation.x = .12;                                        // slight cup — finger edge tips toward the pocket mouth
  g.add(palm);
  const inset = new THREE.Mesh(GEO.mittPalm, web);
  inset.scale.set(.6, .56, .16);                                // darker web circle on the pocket floor
  inset.position.set(0, .015, -.075);
  g.add(inset);
  const webStrip = new THREE.Mesh(new THREE.BoxGeometry(.12, .018, .05), web);
  webStrip.position.set(.05, -.07, -.085);                      // classic web: runs thumb side → top edge
  webStrip.rotation.z = -.55;
  g.add(webStrip);
  for (let i = 0; i < 4; i++) {                                 // finger ridges along the far edge
    const f = new THREE.Mesh(GEO.mittThumb, leather);
    f.scale.setScalar(.62);
    f.rotation.z = Math.PI / 2;                                 // lay the capsule along X
    f.position.set(-.084 + i * .056, -.122, -.045);
    g.add(f);
  }
  for (let i = 0; i < 4; i++) {                                 // finger stalls on the BACK face —
    const b = new THREE.Mesh(GEO.mittThumb, leather);           // the side the camera actually sees
    b.scale.set(.62, .85, .62);
    b.position.set(-.084 + i * .056, .005, .06);
    g.add(b);
  }
  const thumb = new THREE.Mesh(GEO.mittThumb, web);
  thumb.position.set(.115, .05, -.05);
  thumb.rotation.set(-.18, 0, -.61);                            // stall angled ≈35° off the index edge
  g.add(thumb);
  for (const s of [-1, 1]) {                                    // lace crosses straddling the far rim
    const lace = new THREE.Mesh(new THREE.BoxGeometry(.016, .03, .05), web);
    lace.position.set(s * .05, -.125, -.025);
    lace.rotation.z = s * .45;
    g.add(lace);
  }
  const cuff = new THREE.Mesh(GEO.mittCuff, leather);
  cuff.position.y = .125;                                       // wrist ring at the forearm end
  cuff.scale.setScalar(.82);                                    // slimmed — full size read as a toss ring
  g.add(cuff);
  return g;
}

/* ---- Hair — for hatless heads (Lincoln's street-ball look). A dark
       partial-sphere shell slightly proud of the skull, tilted so the
       front rim lifts clear of the eyes while the rear rim drops to the
       nape, plus a small brow-line fringe. Same facing convention as
       makeCap: fz +1 face toward +Z (FBX), −1 toward −Z (humanoid). --- */
const HAIR = ['#15120e', '#231a10', '#33241a', '#0d0d11', '#4d3822'];
function makeHair(r, fz = -1, hex = '#231a10') {
  const mat = teamMat(hex, .92), g = new THREE.Group();
  const dome = new THREE.Mesh(GEO.hairDome, mat);
  dome.scale.set(r * 1.07, r * 1.12, r * 1.09);                 // shell sits just proud of the skull
  dome.position.set(0, r * .03, -fz * r * .03);                 // eased back off the brow
  dome.rotation.x = -fz * .55;
  g.add(dome);
  const fringe = new THREE.Mesh(GEO.fringe, mat);
  fringe.scale.set(r * 1.5, r * .18, r * .16);
  fringe.position.set(0, r * .26, fz * r * .92);                // tiny tuft at the hairline
  fringe.rotation.x = -fz * .3;
  g.add(fringe);
  return g;
}

/* ======================================================================
   PILL FALLBACK — miniature capsule athlete (base-runner pool) with
   pivot "channels" (armL/armR/legL/legR) so the same pose code drives it.
====================================================================== */
/* Clubs come in two shapes: LIN uses `primary`, MLB clubs use `pri`. */
const teamPri = t => t.pri || t.primary || '#cccccc';
/* Trim colour — LIN has `secondary`, MLB clubs carry `sec`. */
const teamSec = t => t.sec || t.secondary || '#ffffff';

export function makePill(team, opts = {}) {
  const mini = !!opts.mini, M = mini ? .78 : 1, skin = new THREE.Color(SKIN[nextSkin()]);
  const root = new THREE.Group(); const channels = {};
  const jersey = teamMat(teamPri(team), .8), pants = teamMat('#e8e6e0', .9);

  const torso = new THREE.Mesh(GEO.caps, jersey); torso.position.y = .98 * M; torso.scale.setScalar(M); root.add(torso);
  const head = new THREE.Mesh(GEO.head, new THREE.MeshStandardMaterial({ color:skin, roughness:.65 }));
  head.position.y = 1.66 * M; head.scale.setScalar(M * .95); root.add(head);
  if (team !== LIN) {                                            // street-ball rule: Lincoln runs bareheaded
    const cap = makeCap(teamMat(teamPri(team), .7), .215 * .95 * M, -1); cap.position.y = 1.67 * M; root.add(cap);
  } else {
    const hair = makeHair(.215 * .95 * M, -1, pick(HAIR)); hair.position.y = 1.66 * M; root.add(hair);
  }

  const mkArm = side => {
    const pivot = new THREE.Group(); pivot.position.set(side * .43 * M, 1.34 * M, 0); root.add(pivot);
    const up = new THREE.Mesh(GEO.arm, jersey); up.position.y = -.26 * M; up.scale.setScalar(M); pivot.add(up);
    if (opts.glove && side < 0) {                                // mini mitt replaces the old glove ball
      const mw = new THREE.Group(); mw.scale.setScalar(.8 * M); mw.position.y = -.5 * M;
      mw.add(makeMitt(teamMat('#7a4f28', pick([.78, .85, .9]))));
      pivot.add(mw);
      upgradeMitt(mw, false);                // owner ask: real RegularMit.fbx swaps in once loaded
    } else {
      const hand = new THREE.Mesh(GEO.hand, new THREE.MeshStandardMaterial({ color:skin, roughness:.65 }));
      hand.position.y = -.5 * M; pivot.add(hand);
    }
    channels[side < 0 ? 'armL' : 'armR'] = pivot;
  };
  mkArm(-1); mkArm(1);

  const mkLeg = side => {
    const pivot = new THREE.Group(); pivot.position.set(side * .17 * M, .62 * M, 0); root.add(pivot);
    const leg = new THREE.Mesh(GEO.leg, pants); leg.position.y = -.31 * M; leg.scale.setScalar(M); pivot.add(leg);
    channels[side < 0 ? 'legL' : 'legR'] = pivot;
  };
  mkLeg(-1); mkLeg(1);

  if (opts.num != null) {
    const nt = canvasTex(128, 128, g => {
      g.clearRect(0, 0, 128, 128);
      g.font = "800 86px 'Arial Black',sans-serif"; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = '#fff'; g.fillText(opts.num, 64, 70);
    });
    [1, -1].forEach(fz => {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(.3, .3), new THREE.MeshBasicMaterial({ map:nt, transparent:true }));
      p.position.set(0, 1.05 * M, fz * .345); p.rotation.y = fz > 0 ? 0 : Math.PI; root.add(p);
    });
  }

  const blob = new THREE.Mesh(new THREE.CircleGeometry(.5, 18),
    new THREE.MeshBasicMaterial({ color:0x000000, transparent:true, opacity:.15, depthWrite:false }));
  blob.rotation.x = -Math.PI / 2; blob.position.y = .012; blob.scale.setScalar(mini ? .75 : 1); root.add(blob);
  root.traverse(o => { if (o.isMesh && o !== blob) o.castShadow = true; });
  return { type:'pill', root, channels };
}

/* ======================================================================
   HUMANOID FALLBACK — stylised low-poly ballplayer assembled from
   primitives (~1.92u at the new default height). Exposes the FULL
   channel vocabulary as nested pivots — Hips→Spine→Spine1→Neck→Head,
   arm→fore→hand, leg→legLow→foot — with the pill's exact conventions
   (limbs hanging −Y, face/trim toward −Z, left limbs at −X), so POSE
   targets and Actor's damped-slerp drive work unchanged. Realism pass:
   broader shoulders + thicker torso, per-actor skin tones, club-colour
   trim (belt, sleeve cuffs, chest placket), thumb'd hands. Arm pivots
   carry a small resting z-splay (rounded shoulders) that rides along in
   their captured rest quaternions. Geometries/materials shared
   module-side; ~28 meshes per player before gear.
====================================================================== */
const HGEO = {
  pelvis:new THREE.CapsuleGeometry(.124,.05,4,10), torso:new THREE.CapsuleGeometry(.166,.19,4,12),
  neck:new THREE.CylinderGeometry(.05,.055,.09,8), head:new THREE.SphereGeometry(.118,18,14),
  eye:new THREE.SphereGeometry(.017,6,6), brow:new THREE.BoxGeometry(.102,.016,.02),
  shoulder:new THREE.SphereGeometry(.07,10,8),
  upArm:new THREE.CapsuleGeometry(.054,.205,4,8),
  foreArm:new THREE.CapsuleGeometry(.043,.175,4,8), hand:new THREE.CapsuleGeometry(.05,.055,4,8),
  thumb:new THREE.CapsuleGeometry(.021,.05,4,8),
  belt:new THREE.CylinderGeometry(.147,.147,.04,14), trim:new THREE.BoxGeometry(.032,.26,.014),
  sleeve:new THREE.CylinderGeometry(.058,.058,.03,10),
  upLeg:new THREE.CapsuleGeometry(.072,.32,4,10), loLeg:new THREE.CapsuleGeometry(.054,.30,4,10),
  num:new THREE.PlaneGeometry(.24,.24), blob:new THREE.CircleGeometry(.34,18), foot:null
};
{ const fg = new THREE.CapsuleGeometry(.042,.13,4,10); fg.rotateX(Math.PI / 2); HGEO.foot = fg; }   // lies along Z: rounded heel↔toe
const eyeMat = new THREE.MeshStandardMaterial({ color:0x202020, roughness:.35 });
const shoeMat = new THREE.MeshStandardMaterial({ color:0x2c2d33, roughness:.85 });
const blobMat = new THREE.MeshBasicMaterial({ color:0x000000, transparent:true, opacity:.15, depthWrite:false });
const skinMats = new Map();
const skinMat = (hex, rough = .65) => {                          // roughness keyed so players vary subtly
  const k = hex + '|' + rough;
  if (!skinMats.has(k)) skinMats.set(k, new THREE.MeshStandardMaterial({ color:new THREE.Color(hex), roughness:rough }));
  return skinMats.get(k);
};
const browMats = new Map();
const browMat = hex => {                                         // socket-shading tone for the brow line
  if (!browMats.has(hex)) browMats.set(hex, new THREE.MeshStandardMaterial({ color:new THREE.Color(hex).multiplyScalar(.62), roughness:.75 }));
  return browMats.get(hex);
};

export function makeHumanoid(team, opts = {}) {
  const root = new THREE.Group(); const channels = {};
  /* Per-player roughness jitter (cached by hex|rough) so athletes don't
     all read as the same plastic; cloth rougher than skin, shoes roughest. */
  const jersey = teamMat(teamPri(team), pick([.74, .82, .9])), pants = teamMat('#e8e6e0', pick([.86, .92]));
  const trimMat = teamMat(teamSec(team), pick([.7, .78])), beltMat = teamMat(teamPri(team), .6);
  const skinHex = SKIN[nextSkin()], skin = skinMat(skinHex, pick([.56, .64, .72]));
  const pivot = (parent, x, y, z) => { const p = new THREE.Group(); p.position.set(x, y, z); parent.add(p); return p; };

  /* Core chain — Hips → Spine → Spine1 → Neck → Head (Mixamo nesting).
     Pivot layout is CONTRACT (the pose library drives it) — only meshes
     hang off it; proportions are tuned through mesh sizes/offsets. */
  const hips = pivot(root, 0, .94, 0); channels.Hips = hips;
  const pelvis = new THREE.Mesh(HGEO.pelvis, pants); pelvis.position.y = -.02; hips.add(pelvis);
  const belt = new THREE.Mesh(HGEO.belt, beltMat); belt.position.y = .105; hips.add(belt);   // club-colour waistband
  const spine = pivot(hips, 0, .1, 0); channels.Spine = spine;
  const spine1 = pivot(spine, 0, .12, 0); channels.Spine1 = spine1;
  const torso = new THREE.Mesh(HGEO.torso, jersey); torso.position.y = .07; spine1.add(torso);
  const trap = new THREE.Mesh(HGEO.shoulder, jersey);             // trapezius bar rounds the neck↔shoulder line
  trap.scale.set(2.5, .45, .8); trap.position.set(0, .285, 0); spine1.add(trap);
  const placket = new THREE.Mesh(HGEO.trim, trimMat);             // modest chest trim down the button line
  placket.position.set(0, .08, -.162); spine1.add(placket);
  const neck = pivot(spine1, 0, .315, 0); channels.Neck = neck;
  const neckM = new THREE.Mesh(HGEO.neck, skin); neckM.position.y = .04; neck.add(neckM);
  const head = pivot(neck, 0, .1, 0); channels.Head = head;
  const skull = new THREE.Mesh(HGEO.head, skin); skull.position.y = .05; head.add(skull);
  [-1, 1].forEach(s => {
    const eye = new THREE.Mesh(HGEO.eye, eyeMat); eye.position.set(s * .045, .062, -.104); head.add(eye);
  });
  const brow = new THREE.Mesh(HGEO.brow, browMat(skinHex));       // subtle socket shade above the eyes
  brow.position.set(0, .073, -.109); head.add(brow);

  /* Arms — shoulder → elbow → wrist; deltoid cap fills the (widened)
     shoulder gap, sleeved upper with a cuff ring, bare tapered forearm +
     refined hand: flattened palm, angled thumb stub toward −Z.
     Nested under Spine1 so spine twist carries them, as on the FBX rigs. */
  const mkArm = side => {
    const L = side < 0;
    const arm = pivot(spine1, side * .215, .26, 0); channels[L ? 'armL' : 'armR'] = arm;
    arm.rotation.z = side * .09;                                  // resting splay — rounded shoulders (rides in restQ)
    const delt = new THREE.Mesh(HGEO.shoulder, jersey); delt.position.y = -.01; arm.add(delt);
    const up = new THREE.Mesh(HGEO.upArm, jersey); up.position.y = -.15; arm.add(up);
    const fore = pivot(arm, 0, -.295, 0); channels[L ? 'foreL' : 'foreR'] = fore;
    const cuff = new THREE.Mesh(HGEO.sleeve, trimMat); cuff.position.y = .012; fore.add(cuff);
    const fm = new THREE.Mesh(HGEO.foreArm, skin); fm.position.y = -.135; fore.add(fm);
    const hand = pivot(fore, 0, -.27, 0); channels[L ? 'handL' : 'handR'] = hand;
    const palm = new THREE.Mesh(HGEO.hand, skin);
    palm.scale.set(.74, .9, 1.3); palm.position.y = -.025;        // fingers implied toward −Z
    hand.add(palm);
    const thumb = new THREE.Mesh(HGEO.thumb, skin);
    thumb.position.set(-side * .024, -.045, -.028);               // inner edge, tip angling forward
    thumb.rotation.set(-.2, 0, side * .65);
    hand.add(thumb);
  };
  mkArm(-1); mkArm(1);

  /* Bat mount socket on the right wrist (mirrors HumanoidTeam's handle) —
     recorded in root.userData so attachGear can seat the bat here and
     register Actor._batMount, letting channel rigs share the FBX rigs'
     per-frame batReady stance stabilisation. */
  const batMount = new THREE.Group();
  batMount.name = 'batMount';
  channels.handR.add(batMount);

  /* Legs — hip → knee → ankle → foot (toes toward −Z, the facing dir).
     Longer/leaner than the torso stack for athletic proportions. */
  const mkLeg = side => {
    const L = side < 0;
    const leg = pivot(hips, side * .095, -.03, 0); channels[L ? 'legL' : 'legR'] = leg;
    const up = new THREE.Mesh(HGEO.upLeg, pants); up.position.y = -.235; leg.add(up);
    const low = pivot(leg, 0, -.41, 0); channels[L ? 'legLowL' : 'legLowR'] = low;
    const lm = new THREE.Mesh(HGEO.loLeg, pants); lm.position.y = -.215; low.add(lm);
    const foot = new THREE.Mesh(HGEO.foot, shoeMat);
    foot.scale.set(1.15, .6, 1); foot.position.set(0, -.44, -.025);
    low.add(foot);
  };
  mkLeg(-1); mkLeg(1);

  if (opts.num != null) {
    const nt = canvasTex(128, 128, g => {
      g.clearRect(0, 0, 128, 128);
      g.font = "800 86px 'Arial Black',sans-serif"; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = '#fff'; g.fillText(opts.num, 64, 70);
    });
    const nm = new THREE.MeshBasicMaterial({ map:nt, transparent:true });
    [1, -1].forEach(fz => {
      const p = new THREE.Mesh(HGEO.num, nm);
      p.position.set(0, .14, fz * .174); p.rotation.y = fz > 0 ? 0 : Math.PI; spine1.add(p);
    });
  }

  const blob = new THREE.Mesh(HGEO.blob, blobMat);
  blob.rotation.x = -Math.PI / 2; blob.position.y = .012; root.add(blob);

  root.userData.headR = .118;                    // skull radius in model units, for gear sizing
  root.userData.batMount = batMount;             // wrist socket for attachGear's bat + stance stabiliser
  return { type:'humanoid', root, channels, headR:.118, batMount };
}

/* ======================================================================
   FBX LOADING — manifest pre-check + HEAD probe before FBXLoader runs,
   so missing files never surface as console 404s.
===================================================================== */
const fbxLoader = new FBXLoader();
const fbxCache = new Map();
/* The textured visitor rigs (Player1/Player2) ship embedded ShininessExponent
   / ReflectionFactor maps. FBXLoader deliberately DISCARDS those two slots and
   announces each discard with console.warn — two benign notices per file, four
   per boot, forever. Nothing is wrong with the load, so narrow-filter exactly
   that notice out (everything else still warns normally) and the console
   returns to its 0-error/0-warning baseline. */
{
  const rawWarn = console.warn.bind(console);
  console.warn = (...a) => {
    if (typeof a[0] === 'string' && a[0].startsWith('THREE.FBXLoader:') && a[0].includes('skipping texture')) return;
    rawWarn(...a);
  };
}
/* asset manifest — mirrors the .fbx files present in the project directory
   ('Player1'/'Player2' are the two SHARED visitor rigs — instanced per
   CPU player via skeletonClone, see VISITOR RIGS below — never hot-swapped
   by name, so no roster name must ever collide with them). */
const FBX_MANIFEST = new Set(['Hyle','Kevo','Doug','Dan','Paul','Ted','Scherz','Josh','Nate','Danny','Nick','Player1','Player2']);

export function loadFBX(name) {
  if (fbxCache.has(name)) return fbxCache.get(name);
  const url = `./${encodeURIComponent(name)}.fbx`;
  const p = (async () => {
    if (!FBX_MANIFEST.has(name)) {
      console.info(`[assets] ${name}.fbx not in manifest — stylized fallback will serve.`);
      return null;
    }
    try {
      const r = await fetch(url, { method:'HEAD' });
      if (!r.ok) { console.info(`[assets] ${name}.fbx unreachable — stylized fallback will serve.`); return null; }
    } catch (e) { return null; }
    return new Promise(res => {
      let done = false; const finish = v => { if (!done) { done = true; res(v); } };
      /* Generous ceiling: under heavy CPU contention (many tabs / parallel
         agents) parsing a multi-MB FBX can far exceed a few seconds — a
         short timer here silently demoted EVERY actor to pill fallback.
         Failures are not cached, so a later spawn retries the load. */
      const to = setTimeout(() => finish(null), 45000);
      try {
        fbxLoader.load(url, obj => { clearTimeout(to); finish(obj); }, undefined, () => { clearTimeout(to); finish(null); });
      } catch (e) { clearTimeout(to); finish(null); }
    });
  })();
  p.then(v => { if (!v) fbxCache.delete(name); });   // failed load → retryable
  fbxCache.set(name, p);
  return p;
}

/* ---- Foot grounding: Box3 → normalise height → offset by −minY --------- */
export function groundModel(obj, targetH = 1.92) {
  obj.updateWorldMatrix(true, true);
  let box = new THREE.Box3().setFromObject(obj);
  if (!isFinite(box.min.y)) return;
  const h = box.max.y - box.min.y;
  if (h > .01 && targetH) {
    obj.scale.multiplyScalar(targetH / h);
    obj.updateWorldMatrix(true, true);
    box = new THREE.Box3().setFromObject(obj);
  }
  obj.position.y -= box.min.y;
  obj.updateWorldMatrix(true, true);
}

/* ---- FBX MITTS (owner ask) — CatcherMit.fbx / RegularMit.fbx replace the
   procedural makeMitt leather once the assets land. attachGear still seats
   the instant procedural mitt FIRST (gear must exist at spawn, before any
   network load resolves), then upgradeMitt swaps the wrapper's children in
   place — same 'mitt' wrapper, same hand seat — so every downstream
   consumer (Game.setGloveVisible's visibility toggle, GripIK's catch
   reach) is untouched. Templates are fitted by LIVE WORLD BBOX at attach
   time: rescale + recentre happen inside the rig itself, so the exports'
   unit convention and every accumulated ancestor transform (model inv ×
   wrapper scalar × bone chain) are compensated exactly — the mit lands at
   real-mitt size centred on the hand. A failed/missing asset degrades
   silently: the procedural leather simply stays. ----------------------- */
for (const m of ['CatcherMit', 'RegularMit']) FBX_MANIFEST.add(m);
const MITT_SPEC = { CatcherMit:{ w:.32 }, RegularMit:{ w:.27 } };   // span targets, world metres
const mittTemplates = new Map();             // name -> Promise<source Group|null>
function mittTemplate(catcher) {
  const name = catcher ? 'CatcherMit' : 'RegularMit';
  let p = mittTemplates.get(name);
  if (!p) {
    p = loadFBX(name).then(obj => {
      if (!obj) { mittTemplates.delete(name); return null; }   // failed → retryable, like loadFBX
      obj.traverse(o => { if (o.isMesh) { o.castShadow = true; } });
      return obj;
    });
    mittTemplates.set(name, p);
  }
  return p;
}
/** Swap the procedural placeholder inside a live 'mitt' wrapper for the
    loaded FBX mit (clone per actor — visibility toggles stay independent). */
function upgradeMitt(wrapper, catcher) {
  mittTemplate(catcher).then(tpl => {
    /* Wrapper must still be live on its hand — a re-dress or sweep may have
       detached it while the asset was in flight. */
    if (!tpl || !wrapper.parent) return;
    while (wrapper.children.length) wrapper.remove(wrapper.children[0]);
    const mit = tpl.clone(true);
    wrapper.add(mit);
    wrapper.updateWorldMatrix(true, true);
    mit.updateWorldMatrix(true, true);
    let box = new THREE.Box3().setFromObject(mit);
    if (isFinite(box.min.x)) {
      const size = box.getSize(new THREE.Vector3());
      const flat = Math.max(size.x, size.z) || size.y || 1;   // widest horizontal span
      mit.scale.multiplyScalar(MITT_SPEC[catcher ? 'CatcherMit' : 'RegularMit'].w / flat);
      wrapper.updateWorldMatrix(true, true);
      mit.updateWorldMatrix(true, true);
      box = new THREE.Box3().setFromObject(mit);
      const c = box.getCenter(new THREE.Vector3());
      mit.position.sub(wrapper.worldToLocal(c.clone()));      // centre on the seat origin
    }
  }).catch(() => {});                          // loader failure → procedural mitt stays
}

/* ---- Skinned-rig cloning (SkeletonUtils.clone algorithm) ----------------
   The visiting nine are instanced from only TWO base FBX rigs (Player1 /
   Player2), each loaded once through loadFBX. A plain Object3D.clone()
   would leave every copy's SkinnedMesh pointing at the SOURCE Bone objects,
   so posing one visitor would visibly deform the whole team; this deep
   clone mirrors three.js examples' SkeletonUtils.clone (MIT): it walks the
   source and its plain clone in parallel, then rebuilds every SkinnedMesh's
   skeleton from the PER-CLONE bones. boneInverses stay valid untouched
   (every clone shares the source bind pose), and in r160 Skeleton.clone()
   hands out a fresh boneMatrices/boneTexture=null pair — the renderer then
   lazily allocates one texture per clone, so no skinned state is shared.
   Materials & geometries stay shared with the source (skinning uniforms
   live on mesh.skeleton, not the material), keeping ten visitors cheap. */
function parallelTraverse(a, b, cb) {
  cb(a, b);
  for (let i = 0; i < a.children.length; i++) parallelTraverse(a.children[i], b.children[i], cb);
}
export function skeletonClone(source) {
  const sourceLookup = new Map(), cloneLookup = new Map();
  const clone = source.clone(true);
  parallelTraverse(source, clone, (s, c) => { sourceLookup.set(c, s); cloneLookup.set(s, c); });
  clone.traverse(node => {
    if (!node.isSkinnedMesh) return;
    const src = sourceLookup.get(node);
    if (!src || !src.isSkinnedMesh || !src.skeleton) return;
    node.skeleton = src.skeleton.clone();
    /* Re-seat the bones array with THIS branch's cloned bones — index order
       matches boneInverses because it maps over the original order. */
    node.skeleton.bones = src.skeleton.bones.map(b => cloneLookup.get(b));
    /* bindMatrix/bindMatrixInverse were value-copied by SkinnedMesh.copy(). */
  });
  return clone;
}

/* ---- Analytic ground height — the pitcher's mound -----------------------
   Mirrors the mound mesh built in SceneManager (CylinderGeometry, top r 1.4
   → bottom r 2.9, h .24, centred at x 0 / z −18.44): flat .24 apex inside
   r 1.4, linear falloff to 0 at the footprint edge r 2.9, 0 beyond. Actors
   sample it every frame in Actor.update so the grounding baseY rides the
   slope; allocation-free. ---------------------------------------------- */
const MOUND = { x:0, z:-18.44, r0:1.4, r1:2.9, h:.24 };
function groundHeight(x, z) {
  const dx = x - MOUND.x, dz = z - MOUND.z, d2 = dx*dx + dz*dz;
  if (d2 >= MOUND.r1*MOUND.r1) return 0;
  if (d2 <= MOUND.r0*MOUND.r0) return MOUND.h;
  return MOUND.h * (MOUND.r1 - Math.sqrt(d2)) / (MOUND.r1 - MOUND.r0);
}

/* ======================================================================
   ACTOR — scene-graph wrapper driving channels toward pose targets with
   damped slerp (frame-rate independent). Works for FBX rigs, humanoids
   and pills.
====================================================================== */
const _eu = new THREE.Euler(), _qt = new THREE.Quaternion(), _tv = new THREE.Vector3();

/* ---- Bat stance stabiliser ---------------------------------------------
   The static barrel-verticality bake in attachGear runs once, in the rig's
   bind pose — it cannot know how the batReady POSE will roll the right
   hand at runtime, which is exactly why some rigs (Hyle, several visitors)
   read a flat bat while others stand up. This per-frame pass closes that
   gap: while an actor is in `batReady` it eases the bat mount toward the
   root-local "up & back over the shoulder" direction, whatever the rig's
   export convention. Corrections stop the moment the state changes, so
   swing/checkswing sweep freely with the hands (the mount keeps its last
   offset, exactly like a bat held in the hands). Zero per-frame alloc. */
const BAT_STANCE_DIR = new THREE.Vector3(0, .93, -.36).normalize();
const _sbQ1 = new THREE.Quaternion(), _sbQ2 = new THREE.Quaternion(),
      _sbQ3 = new THREE.Quaternion(), _sbD = new THREE.Vector3(),
      _sbW = new THREE.Vector3();                 // wanted-axis scratch (world)

function stabilizeBat(actor, dt) {
  const m = actor._batMount;
  if (!m || !m.parent) return;
  const st = actor.animState;
  if (!st || st.name !== 'batReady') { actor._batStabQ = null; return; }
  const hand = m.parent;                       // mount lives directly on handR
  hand.updateWorldMatrix(true, false);
  m.updateWorldMatrix(true, false);
  _sbD.set(0, 1, 0).transformDirection(m.matrixWorld);          // bat axis now
  actor.root.getWorldQuaternion(_sbQ1);
  /* Express the root-local stance direction in WORLD space — that is a
     VECTOR rotated by a quaternion (Vector3#applyQuaternion), exactly as in
     bakeBarrelVerticality below. The old chain called it on the _sbQ2
     Quaternion, which has no such method: the pass threw TypeError on its
     first body frame and was eaten by update()'s cosmetic catch, so the
     stabiliser never ran on any rig. */
  _sbW.copy(BAT_STANCE_DIR).applyQuaternion(_sbQ1);             // bat axis wanted
  _sbQ3.setFromUnitVectors(_sbD, _sbW.normalize());             // correction (world)
  hand.getWorldQuaternion(_sbQ1);
  _sbQ2.copy(_sbQ1).invert().multiply(_sbQ3).multiply(_sbQ1);   // same, hand-local
  if (!actor._batStabQ) actor._batStabQ = new THREE.Quaternion();
  actor._batStabQ.slerp(_sbQ2, dampF(7, dt));                   // ease, never snap
  m.quaternion.premultiply(actor._batStabQ);
  window.__w2f = (window.__w2f || 0) + 1;      // QA affordance: stabiliser completions
}

/* ---- One-time verticality bake (both mount paths) -----------------------
   Counter-rotates a freshly built bat mount ONCE, in `hand` space, so the
   barrel leaves the hand pointing up-and-back along BAT_STANCE_DIR in root
   space — whatever the rig's export convention. The per-frame stabiliser
   above then only has to trim during batReady, not rescue. Runs at gear-
   attach time only (spawn / FBX hot-swap); allocation here is fine. ----- */
function bakeBarrelVerticality(actor, hand, mount) {
  try {
    hand.updateWorldMatrix(true, false);
    const cur = new THREE.Vector3(0, 1, 0).transformDirection(hand.matrixWorld);
    const rq = new THREE.Quaternion(); actor.root.getWorldQuaternion(rq);
    const want = BAT_STANCE_DIR.clone().applyQuaternion(rq).normalize();
    const qw = new THREE.Quaternion().setFromUnitVectors(cur.normalize(), want);
    const qh = new THREE.Quaternion(); hand.getWorldQuaternion(qh);
    mount.quaternion.premultiply(qh.clone().invert().multiply(qw).multiply(qh));
  } catch (e) { /* cosmetic bake only — never block the swap */ }
}

export class Actor {
  constructor(charObj, name, team, opts = {}) {
    this.name = name; this.team = team; this.opts = opts;
    this.root = new THREE.Group(); this.model = null; this.channels = {}; this.sig = {};
    this.rest = new Map(); this.restPos = new Map(); this.baseY = 0; this.baseY0 = 0;
    this.unitInv = 1;                             // world-metre → bone-local (set in use())
    this.bones = null; this.ready = false; this.tg = {}; this.tgp = {};
    this.animState = { name:'idle', start:0 }; this.speedMul = 1;
    /* ±4% stature variance, drawn once and fixed for the actor's life so
       FBX hot-swaps don't change height. Minis (runner pool) stay uniform. */
    this.hvar = opts.mini ? 1 : 1 + rand(-.04, .04);
    this.effH = 0;
    scene.add(this.root);
    this.use(charObj);
    ACTORS.push(this);
  }

  use(charObj) {
    if (this.model) this.root.remove(this.model);
    this.model = charObj.root;
    this.model.traverse(o => { if (o.isMesh) o.castShadow = true; });
    this.root.add(this.model);
    this.effH = (this.opts.height || 1.92) * this.hvar;   // new default stature 1.92
    groundModel(this.model, this.effH);
    /* FBX exports vary wildly in bone units (measured model scales 0.013–2.0
       across the LIN rigs — some files are authored in centimeter-scale
       units, groundModel renormalizes the mesh but bone-local translations
       stay in raw units). Pose position targets (tgp) are authored in world
       metres, so cache 1/scale to convert at drive time; same convention
       attachGripIK/attachGear already use. Uniform scale ⇒ one scalar. */
    this.unitInv = 1 / (this.model.scale.x || 1);
    this.baseY = this.model.position.y;
    this.baseY0 = this.baseY;                     // grounding offset off-mound

    this.channels = charObj.channels || {};
    if (charObj.type === 'fbx') {
      this.bones = findBones(this.model);
      const ch = {};
      for (const k in BONE_CHANNEL_MAP)
        if (this.bones[BONE_CHANNEL_MAP[k]]) ch[k] = this.bones[BONE_CHANNEL_MAP[k]];
      this.channels = ch;
      this.sig = calibrateSigns(ch);
      this.model.traverse(o => { if (o.isSkinnedMesh) o.frustumCulled = false; });
    } else {
      this.sig = { armL:{Z:-1}, armR:{Z:1}, legL:{X:1}, legR:{X:1} };
    }

    this.rest.clear(); this.restPos.clear();
    for (const k in this.channels) {
      this.rest.set(k, this.channels[k].quaternion.clone());
      this.restPos.set(k, this.channels[k].position.clone());
    }
    this.ready = true; this.tg = {}; this.tgp = {};
    return this;
  }

  setPose(tg, tgp = {}) { this.tg = tg; this.tgp = tgp; }

  update(dt) {
    if (!this.ready) return;
    /* Mound grounding — baseY rides the analytic mound profile under the
       actor's XZ (in practice only the pitcher samples non-zero); it feeds
       the run/jog bounce and the settle-back ease in driveActor. */
    this.baseY = this.baseY0 + groundHeight(this.root.position.x, this.root.position.z);
    const k = dampF(14 * this.speedMul, dt);
    for (const kk in this.channels) {
      const o = this.channels[kk], want = this.tg[kk], restQ = this.rest.get(kk);
      if (want) {                                   // null-safe bone drive
        const s = this.sig[kk] || {};
        _eu.set((want[0]||0)*(s.X||1), (want[1]||0)*(s.Y||1), (want[2]||0)*(s.Z||1));
        _qt.setFromEuler(_eu);
        /* post channels (legs — see calibrateSigns) apply the euler about the
           PARENT frame (euler ⊗ rest); everything else keeps the bind-frame
           premultiply path the arm poses were FK-tuned under. */
        if (s.post) _qt.multiply(restQ); else _qt.premultiply(restQ);
        o.quaternion.slerp(_qt, k);
      } else o.quaternion.slerp(restQ, k);
      const wp = this.tgp[kk];
      if (wp) {
        const rp = this.restPos.get(kk);
        /* tgp offsets are world metres (see unitInv in use()) — convert out
           of raw bone units so the hips sink is identical on every export. */
        _tv.set(rp.x + wp[0]*this.unitInv, rp.y + wp[1]*this.unitInv, rp.z + wp[2]*this.unitInv);
        o.position.lerp(_tv, k);
      }
    }
    try { stabilizeBat(this, dt); } catch (e) { /* cosmetic — never block the drive */ }
    if (!this._grip) this._grip = attachGripIK(this);   // GripIK: bat grip + catch reach
    if (this.postDrive) this.postDrive(dt);
  }
}

export const ACTORS = [];

/* ---- Gear sized in world metres regardless of model normalisation ------
       Headwear rules: FBX rigs get NOTHING added to their heads — the given
       models ship their own hair/heads, so no cap, no helmet, no hair shell
       is ever attached (user directive: "just use the given fbx"). The
       procedural cap/helmet/hair builders still dress the primitive
       fallbacks (humanoid/pill), which have no modeled heads.
       Gloves are real mitts (see makeMitt) on both paths. ---------------- */
export function attachGear(actor, { cap = true, glove = false, bat = false, catcher = false } = {}) {
  const lid = bat ? makeHelmet : makeCap;
  if (actor.bones) {
    const inv = 1 / (actor.model.scale.x || 1);
    const lh = actor.bones.LeftHand;
    if (lh && glove) {
      /* Catchers hang a REAL-SIZE round target mitt (.61× — owner call:
         1.22× read as a beach ball against the strike zone); everyone else
         the standard fielder's glove, untouched. makeMitt's catcher branch
         is proportional to R throughout, so halving the wrapper scalar
         halves the whole leather uniformly. */
      const s = new THREE.Group(); s.scale.setScalar(inv * (catcher ? .61 : 1)); s.name = 'mitt';
      const h = new THREE.Group(); h.position.y = .02;
      h.rotation.z = Math.PI;                  // cuff → wrist side of the bone, pocket → palm side
      h.add(makeMitt(teamMat('#7a4f28', pick([.76, .84, .9])), teamMat('#5c3b1d', .9), catcher));
      upgradeMitt(h, catcher);               // owner ask: real FBX leather swaps in once loaded
      s.add(h);
      lh.add(s);
      actor._glove = undefined;                // stale cache: re-resolve on next toggle
    }
    const rh = actor.bones.RightHand;
    if (rh && bat) {
      const s = new THREE.Group(); s.scale.setScalar(inv); s.rotation.x = -.1;
      const b = new THREE.Mesh(GEO.bat, teamMat('#c89b6a', .6)); b.castShadow = true; b.name = 'bat'; s.add(b);
      /* Bake per-rig barrel verticality (shared helper — see above): the
         barrel always leaves the hand pointing up and back over the
         shoulder, whatever the export convention (Hyle read flat, others
         upright before this existed). */
      bakeBarrelVerticality(actor, rh, s);
      rh.add(s);
      actor._batMount = s;                     // live ref for the stance stabiliser
      actor._batStabQ = null;                  // reset the eased-correction state
      actor._bat = undefined;                  // stale cache: re-resolve on next toggle
    }
  } else {
    const ch = actor.channels;
    const bareHead = actor.team === LIN;         // primitive fallbacks only: LIN gets hair, visitors caps
    if (cap && ch.Head) {                        // humanoid/pill: headwear rides the Head channel
      const g = new THREE.Group(), r = actor.model.userData.headR || .118;
      if (!bareHead) g.add(lid(teamMat(teamPri(actor.team), .7), r, -1));
      else {
        actor.hairHex = actor.hairHex || pick(HAIR);
        const hg = makeHair(r, -1, actor.hairHex);
        hg.position.y = .05;                     // skull centre sits .05 above the Head pivot
        g.add(hg);
      }
      ch.Head.add(g);
    }
    if (glove && ch.handL) {
      const g = new THREE.Group(); g.position.y = -.05;
      g.scale.setScalar(catcher ? .51 : .78); g.name = 'mitt';   // catcher halved — matches the FBX path's .61× intent at fallback size
      g.add(makeMitt(teamMat('#7a4f28', pick([.76, .84, .9])), teamMat('#5c3b1d', .9), catcher));
      upgradeMitt(g, catcher);               // owner ask: real FBX leather swaps in once loaded
      ch.handL.add(g);
      actor._glove = undefined;                // stale cache: re-resolve on next toggle
    }
    if (bat && (ch.handR || ch.armR)) {
      const b = new THREE.Mesh(GEO.bat, teamMat('#c89b6a', .6)); b.castShadow = true; b.name = 'bat';
      if (ch.handR) {
        const mount = actor.model.userData.batMount;           // wrist socket from the builders
        if (mount) {
          /* Channel rigs: seat the bat in the exposed wrist socket (same
             hand-frame seat as the old direct mount), then register the
             handle so the per-frame stance stabiliser holds the FBX-
             matching cocked batReady look — a bare hand mount reads
             near-horizontal once the stance rolls the wrist. */
          b.position.set(0, .015, 0); b.rotation.set(.1, 0, -.05);
          mount.add(b);
          actor._batMount = mount;
          actor._batStabQ = null;
          bakeBarrelVerticality(actor, ch.handR, mount);
        } else {
          /* legacy direct hand mount — near-vertical seat, the barrel
             stands up over the shoulder, not lean out flat */
          b.position.set(0, .015, 0); b.rotation.set(.1, 0, -.05); ch.handR.add(b);
        }
      } else { b.position.y = -.5; b.rotation.x = .18; ch.armR.add(b); }   // legacy pill mount
      actor._bat = undefined;                  // stale cache: re-resolve on next toggle
    }
  }
}

/** Spawn a humanoid (mini runners: pill) immediately; hot-swap to FBX once it loads. */
export function spawnActor(name, team, opts = {}) {
  const kit = { ...opts, num: opts.num ?? rint(2, 49) };
  const actor = new Actor(opts.mini ? makePill(team, kit) : makeHumanoid(team, kit), name, team, opts);
  attachGear(actor, { glove:!!opts.glove, bat:!!opts.bat, cap:!opts.mini, catcher:!!opts.catcherMitt });
  if (opts.noFBX) return actor;
  loadFBX(name).then(obj => {
    if (!obj) return;
    try {
      actor.use({ type:'fbx', root:obj, channels:{} });
      attachGear(actor, { glove:!!opts.glove, bat:!!opts.bat, cap:!opts.mini, catcher:!!opts.catcherMitt });
      console.info(`[assets] ${name}.fbx loaded · grounded feet Y=0`);
    } catch (e) { console.warn('[assets] FBX prepare failed:', name, e); }
  });
  return actor;
}

/* ======================================================================
   VISITOR RIGS — the CPU club is instanced from two SHARED Mixamo rigs
   (Player1.fbx / Player2.fbx at the project root), loaded ONCE each through
   the same manifest/HEAD-probe/45 s-timeout loader as the LIN set. Every
   visitor receives an independent skeletonClone so bones never cross-talk
   between actors; the cached source objects are never grounded or posed —
   all mutation happens on the per-actor clones (groundModel in Actor.use).
   The pool is Player1 ONLY (user directive with the Field-of-Dreams roster:
   "Always use Player1.fbx, don't use Player2.fbx") — Player2 is never even
   loaded. opts.rigName still forces a rig for callers that care; with a
   single-entry pool it resolves to 0 either way. The old procedural visitor
   builder (HumanoidTeam.buildHumanoidFielder) is superseded on this path.
====================================================================== */
const VISITOR_RIG_NAMES = ['Player1'];
let visitorRigsP = null;

function visitorRigs() {
  if (!visitorRigsP) visitorRigsP = Promise.all(VISITOR_RIG_NAMES.map(n => loadFBX(n)));
  return visitorRigsP;
}

function nextRigIndex() {                                   // single-rig pool → always 0
  return 0;
}

/** Spawn a CPU visitor: humanoid stand-in immediately (field is never empty),
    then hot-swap to a cloned Player1/Player2 rig once both base loads land —
    the same spawn-then-swap pattern spawnActor uses for named FBX rigs. */
export function spawnVisitorActor(name, team, opts = {}) {
  const kit = { ...opts, num: opts.num ?? rint(2, 49) };
  const actor = new Actor(makeHumanoid(team, kit), name, team, opts);
  attachGear(actor, { glove:!!opts.glove, bat:!!opts.bat, cap:true, catcher:!!opts.catcherMitt });
  /* Runner-pool bodies ("LIN Runner 0..3" / "FOD Runner 0..3", the names
     Runners.createRunners passes — no other actor name carries the
     ' Runner N' suffix) get the base-runner polish kit: while the legacy
     pill path owns them they run cadence-synced strides + banked turns;
     once a sendRunner job takes over, the kit auto-yields per frame (see
     RunnersHelpers' ownership-arbitration note). Deliberate import cycle
     back through Runners.js resolves at runtime only — module-eval order
     never dereferences any binding of it. */
  enrollRunnerBody(actor, name);
  if (opts.noFBX) return actor;
  visitorRigs().then(rigs => {
    /* opts.rigName still forces a specific base rig for callers that care;
       with a one-entry pool the tally-free pick is always 0. */
    const i = opts.rigName ? Math.max(0, VISITOR_RIG_NAMES.indexOf(opts.rigName)) : nextRigIndex();
    const src = rigs[i];
    if (!src) return;                                       // load failed → stand-in serves on
    try {
      actor.rigName = VISITOR_RIG_NAMES[i];                 // QA affordance: which base rig this clone came from
      (window.__p1Rigs || (window.__p1Rigs = {}))[name] = VISITOR_RIG_NAMES[i];
      actor.use({ type:'fbx', root:skeletonClone(src), channels:{} });
      attachGear(actor, { glove:!!opts.glove, bat:!!opts.bat, cap:true, catcher:!!opts.catcherMitt });
      console.info(`[assets] ${name} → ${VISITOR_RIG_NAMES[i]} rig · grounded feet Y=0`);
    } catch (e) { console.warn('[assets] visitor FBX swap failed:', name, e); }
  });
  return actor;
}
