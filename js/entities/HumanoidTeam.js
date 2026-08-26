/* =====================================================================
   HumanoidTeam.js — visiting-club nine: full-uniform procedural
   ballplayers (the "HumanoidTeam" rig). Part of the Lincoln Red
   Gauntlet engine · js/entities/

   WHY: the CPU nine must read as real ballplayers on the broadcast cams
   — same species as the FBX Mixamo rigs — not undressed primitives.
   This builder keeps the engine's CONTRACT pivot skeleton (identical
   layout to the humanoid fallback in PlayerFactory, so every POSE
   target lands unchanged):

     Hips(0,.94,0) → Spine(+.10) → Spine1(+.12) → Neck(+.315) → Head(+.10)
     arms under Spine1 (±.215,.26) → fore(−.295) → hand(−.27)
     legs at Hips (±.095,−.03) → legLow(−.41);  limbs hang −Y,
     face/trim/toes toward −Z, left limbs at −X, resting arm splay
     (arm.rotation.z = side·.09) baked so it rides in Actor's captured
     rest quaternions like every other primitive rig.

   …and dresses it as a proper baseball uniform: lathe-cut jersey in the
   club PRIMARY with collar / button placket / sleeve hems in the
   SECONDARY, buckled belt, white pants with knicker cuffs, colour
   stirrup socks, cleats, a sculpted head (jaw, ears, nose, brow shade,
   nape hair under the cap, occasional beard) and canvas jersey numbers
   (large on the back, small chest badge up front). Per-actor skin-tone
   variety, cloth roughness jitter and a bulk variance keep the nine
   from reading as clones.

   CONTRACT
   --------
   buildHumanoidFielder({ team, number, hasBat, hasGlove }) →
        { type:'humanoidTeam', root, channels, headR, batMount }

   channels: armL/armR foreL/foreR handL/handR legL/legR legLowL/legLowR
   Spine Spine1 Neck Head Hips — exactly the vocabulary
   AnimationController.driveActor/POSE, calibrateSigns and Actor's
   damped-slerp loop address. `number` (alias `num`) paints the jersey;
   `hasBat` / `hasGlove` (aliases `bat` / `glove`) are accepted for API
   completeness — see GEAR PIPELINE for why the meshes themselves are
   NOT mounted here. `batMount` mirrors `headR`: the right-wrist socket
   group (also at root.userData.batMount) that attachGear parents the
   bat into, giving Actor's per-frame stance stabiliser its handle.

   GEAR PIPELINE — what the integrator needs
   -----------------------------------------
   The figure ships BODY-ONLY on purpose: PlayerFactory.attachGear()
   dresses it exactly like the existing humanoid fallback, because
     · root.userData.headR (= .12, mirrored in `headR`) sizes
       makeCap/makeHelmet on channels.Head — visiting clubs take caps
       (only LIN is hatless; attachGear's bareHead rule already routes
       that), and bat:true swaps in the batting helmet automatically;
     · the mitt mounts on channels.handL, the bat on channels.handR,
       named 'mitt'/'bat' so Game.setGloveVisible/setBatVisible can
       toggle costume;
     · Actor.use() grounds the model via groundModel() and captures
       per-channel restQ/restPos, so poses, sinks and strides behave
       identically to the humanoid fallback (GripIK stays a no-op on
       channel rigs — attachGear seats the bat in root.userData.batMount,
       bakes it vertical once, and the per-frame stance stabiliser holds
       the FBX-matching cocked batReady look from there);
     · absolute size is irrelevant (Actor renormalises height through
       groundModel), but the figure is authored ≈1.74u so the default
       1.92u target upscales ~1.10× without disturbing proportions.

   Minimal wiring (report copy — Game.deployTeams):
     import { Actor } from './PlayerFactory.js';            // + existing attachGear
     import { buildHumanoidFielder } from '../entities/HumanoidTeam.js';
     function spawnVisitor(name, opts = {}) {
       const kit = { ...opts, num: opts.num ?? rint(2, 49) };
       const actor = new Actor(buildHumanoidFielder({ team: OPP, ...kit }), name, OPP, opts);
       attachGear(actor, { glove: !!opts.glove, bat: !!opts.bat, cap: true });
       return actor;
     }
   …and route the two OPP spawn sites through it. No PlayerFactory edit.

   All geometries/materials/textures are shared module-side singletons;
   nothing allocates per frame. ES6 module, no bundler assumptions.
===================================================================== */
import * as THREE from 'three';
import { rand, rint, pick } from '../utils/MathUtils.js';
import { canvasTex } from '../utils/MathUtils.js';
import { teamMat } from './PlayerFactory.js';

/* ---- Palettes ----------------------------------------------------------
   Skin: per-actor tone variety (adjacent spawns never repeat, mirroring
   the factory's rule). Hair doubles as beard ink. Clubs come in two
   shapes — LIN carries `primary/secondary`, the 32 visiting clubs in
   RosterManager carry `pri/sec` — so both spellings are honoured. --- */
const SKIN = [0xf1c7a3, 0xd9a06b, 0xa9714b, 0x7c4a2d, 0x5b3620];
let lastSkin = -1;
const nextSkin = () => {
  if (SKIN.length < 2) return 0;
  let i; do { i = rint(0, SKIN.length - 1); } while (i === lastSkin);
  lastSkin = i; return i;
};
const HAIR = ['#15120e', '#231a10', '#33241a', '#0d0d11', '#4d3822'];

const teamPri = t => (t && (t.pri || t.primary)) || '#cccccc';
const teamSec = t => (t && (t.sec || t.secondary)) || '#ffffff';

/* Relative luminance of a #rrggbb string — decides jersey-number ink so
   light kits (Tampa Bay powder, Giants orange) take dark numerals and
   dark kits take white, like real MLB typography. */
const lumOf = hex => {
  const n = parseInt(String(hex).replace('#', ''), 16) || 0x888888;
  return (.2126 * (n >> 16 & 255) + .7152 * (n >> 8 & 255) + .0722 * (n & 255)) / 255;
};

/* ---- Shared geometries -------------------------------------------------
   Every mesh below instances one of these; per-figure shaping is done
   with scales/positions only. ---------------------------------------- */
const HT_GEO = {
  /* Jersey shell — lathe profile (radius, y): tucked hem → waist pinch →
     chest → armpit swell → shoulder slope. Flattened on Z at mount for a
     chest, not a tube. */
  torso:(() => {
    const P = [[.146,-.165],[.150,-.105],[.140,-.025],[.151,.065],
               [.165,.150],[.175,.215],[.171,.262],[.150,.290]];
    return new THREE.LatheGeometry(P.map(p => new THREE.Vector2(p[0], p[1])), 22);
  })(),
  pelvis:new THREE.CapsuleGeometry(.128,.06,4,12),
  belt:new THREE.CylinderGeometry(.152,.152,.046,16),
  buckle:new THREE.BoxGeometry(.048,.034,.018),
  trap:new THREE.SphereGeometry(.075,12,10),                 // trapezius bar (scaled wide)
  collar:new THREE.TorusGeometry(.075,.021,8,18),            // laid flat at mount
  placket:new THREE.BoxGeometry(.034,.235,.012),

  neck:new THREE.CylinderGeometry(.052,.058,.10,10),
  skull:new THREE.SphereGeometry(.12,20,16),
  jaw:new THREE.SphereGeometry(.09,14,12),
  ear:new THREE.SphereGeometry(.026,8,6),
  nose:new THREE.SphereGeometry(.02,8,6),
  eye:new THREE.SphereGeometry(.017,6,6),
  brow:new THREE.BoxGeometry(.104,.016,.02),
  hair:new THREE.SphereGeometry(1,18,12,0,Math.PI*2,0,1.18), // unit shell, sized at mount
  beard:new THREE.SphereGeometry(.123,14,8,Math.PI,Math.PI,Math.PI*.60,Math.PI*.33), // front-lower band

  delt:new THREE.SphereGeometry(.075,12,10),
  sleeve:new THREE.CapsuleGeometry(.057,.16,4,10),
  hem:new THREE.CylinderGeometry(.060,.060,.034,12),
  foreArm:new THREE.CapsuleGeometry(.045,.17,4,10),
  palm:new THREE.CapsuleGeometry(.05,.05,4,8),
  thumb:new THREE.CapsuleGeometry(.02,.048,4,8),

  thigh:new THREE.CapsuleGeometry(.077,.30,4,10),
  knicker:new THREE.CylinderGeometry(.079,.071,.09,12),      // flared pant cuff over the knee
  sock:new THREE.CapsuleGeometry(.052,.22,4,10),             // club-colour stirrup
  numBack:new THREE.PlaneGeometry(.27,.31),                  // large back numeral
  numChest:new THREE.PlaneGeometry(.11,.11),                 // small front badge
  blob:new THREE.CircleGeometry(.36,20),
  foot:null                                                  // built below: lies along Z
};
{ const f = new THREE.CapsuleGeometry(.045,.14,4,10); f.rotateX(Math.PI / 2); HT_GEO.foot = f; }

/* ---- Shared materials --------------------------------------------------
   Club colours route through PlayerFactory.teamMat's cache (keyed by
   hex|roughness so per-player cloth jitter stays cached). Skin/eyes/
   shoes/buckles live in local caches. ------------------------------- */
const skinMats = new Map();
const skinMat = (hex, rough = .65) => {
  const k = hex + '|' + rough;
  if (!skinMats.has(k)) skinMats.set(k, new THREE.MeshStandardMaterial({ color:new THREE.Color(hex), roughness:rough }));
  return skinMats.get(k);
};
const eyeMat = new THREE.MeshStandardMaterial({ color:0x202020, roughness:.35 });
const shoeMat = new THREE.MeshStandardMaterial({ color:0x26272c, roughness:.88 });
const buckleMat = new THREE.MeshStandardMaterial({ color:0xc8c2b4, roughness:.35 });
const blobMat = new THREE.MeshBasicMaterial({ color:0x000000, transparent:true, opacity:.15, depthWrite:false });
const browMats = new Map();
const browMat = hex => {
  if (!browMats.has(hex)) browMats.set(hex, new THREE.MeshStandardMaterial({ color:new THREE.Color(hex).multiplyScalar(.62), roughness:.75 }));
  return browMats.get(hex);
};

/* ---- Jersey numbers ----------------------------------------------------
   White (or dark-on-light-kits) numerals with a contrast stroke, cached
   per number|ink|size so the nine shares textures. Big = back numeral,
   small = front chest badge. ---------------------------------------- */
const numTexCache = new Map();
function numberTex(num, ink, big) {
  const k = num + '|' + ink + '|' + (big ? 'B' : 'S');
  if (numTexCache.has(k)) return numTexCache.get(k);
  const S = big ? 256 : 128;
  const t = canvasTex(S, S, g => {
    g.clearRect(0, 0, S, S);
    g.font = `800 ${big ? 200 : 92}px 'Arial Black',sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = big ? 10 : 5;
    g.strokeStyle = ink === '#f5f5f2' ? 'rgba(14,20,28,.55)' : 'rgba(245,245,242,.5)';
    g.strokeText(num, S / 2, S / 2 + S * .045);
    g.fillStyle = ink;
    g.fillText(num, S / 2, S / 2 + S * .045);
  });
  numTexCache.set(k, t);
  return t;
}

/* ======================================================================
   BUILD — one visiting ballplayer. See CONTRACT in the header.
====================================================================== */
export function buildHumanoidFielder(opts = {}) {
  const team = opts.team || null;
  const number = opts.number ?? opts.num ?? null;

  const root = new THREE.Group(); const channels = {};
  const pri = teamPri(team), sec = teamSec(team);

  /* Per-player material picks — roughness jitter keeps the nine from
     reading as one plastic mould; cloth rougher than skin. */
  const jersey = teamMat(pri, pick([.74, .82, .9]));
  const pants  = teamMat('#e8e6e0', pick([.86, .92]));
  const trim   = teamMat(sec, pick([.7, .78]));
  const belt   = teamMat(pri, .6);
  const sock   = teamMat(pri, pick([.78, .86]));
  const skinHex = '#' + new THREE.Color(SKIN[nextSkin()]).getHexString();
  const skin   = skinMat(skinHex, pick([.56, .64, .72]));
  const hairHex = pick(HAIR), hairM = teamMat(hairHex, .92);

  const bulk = 1 + rand(-.05, .05);                            // shoulder/chest width variance
  const pivot = (parent, x, y, z) => { const p = new THREE.Group(); p.position.set(x, y, z); parent.add(p); return p; };

  /* Core chain — Hips → Spine → Spine1 → Neck → Head. Pivot layout is
     CONTRACT (the pose library drives it); only meshes hang off it. */
  const hips = pivot(root, 0, .94, 0); channels.Hips = hips;
  const pelvis = new THREE.Mesh(HT_GEO.pelvis, pants); pelvis.position.y = -.02; hips.add(pelvis);
  const beltM = new THREE.Mesh(HT_GEO.belt, belt); beltM.position.y = .105; hips.add(beltM);
  const buckle = new THREE.Mesh(HT_GEO.buckle, buckleMat); buckle.position.set(0, .105, -.148); hips.add(buckle);
  const spine = pivot(hips, 0, .1, 0); channels.Spine = spine;
  const spine1 = pivot(spine, 0, .12, 0); channels.Spine1 = spine1;

  const torso = new THREE.Mesh(HT_GEO.torso, jersey);
  torso.scale.set(bulk, 1, .84); torso.position.y = .07; spine1.add(torso);
  const trap = new THREE.Mesh(HT_GEO.trap, jersey);              // rounds the neck↔shoulder line
  trap.scale.set(2.6 * bulk, .5, .85); trap.position.set(0, .287, 0); spine1.add(trap);
  const collar = new THREE.Mesh(HT_GEO.collar, trim);
  collar.rotation.x = Math.PI / 2; collar.position.y = .303; spine1.add(collar);
  const placket = new THREE.Mesh(HT_GEO.placket, trim);          // button line down the chest
  placket.position.set(0, .085, -.139); spine1.add(placket);

  const neck = pivot(spine1, 0, .315, 0); channels.Neck = neck;
  const neckM = new THREE.Mesh(HT_GEO.neck, skin); neckM.position.y = .045; neck.add(neckM);
  const head = pivot(neck, 0, .19, 0); channels.Head = head;

  /* Head — the skull centre hangs .04 BELOW the Head pivot. That offset
     is tuned for PlayerFactory.attachGear, which mounts makeCap/makeHelmet
     AT the pivot: with the skull here, the cap's rim (pivot + .006) lands
     on the upper forehead just above the eyes and the dome wraps the
     crown, instead of slumping over the face. Head-pivot rotations in
     the pose library are ≤.15 rad, so the crown pivot is invisible. */
  const skull = new THREE.Mesh(HT_GEO.skull, skin); skull.position.y = -.04; head.add(skull);
  const jaw = new THREE.Mesh(HT_GEO.jaw, skin); jaw.scale.set(1, .8, 1.02); jaw.position.set(0, -.075, -.024); head.add(jaw);
  [-1, 1].forEach(s => {
    const ear = new THREE.Mesh(HT_GEO.ear, skin); ear.scale.set(.5, .85, .66); ear.position.set(s * .116, -.05, .004); head.add(ear);
    const eye = new THREE.Mesh(HT_GEO.eye, eyeMat); eye.position.set(s * .045, -.002, -.108); head.add(eye);
  });
  const nose = new THREE.Mesh(HT_GEO.nose, skin); nose.scale.set(.72, .95, .9); nose.position.set(0, -.04, -.12); head.add(nose);
  const brow = new THREE.Mesh(HT_GEO.brow, browMat(skinHex)); brow.position.set(0, .014, -.112); head.add(brow);
  if (pick([true, true, true, true, false])) {                   // ~80% have hair under the cap
    const hair = new THREE.Mesh(HT_GEO.hair, hairM);
    hair.scale.set(.132, .138, .130); hair.position.set(0, -.02, .01);
    hair.rotation.x = .52;                                       // front rim up under the cap, rear to the nape
    head.add(hair);
  }
  if (pick([true, false, false])) {                              // ~⅓ beard band along the jaw
    const beard = new THREE.Mesh(HT_GEO.beard, hairM);
    beard.position.set(0, -.048, -.006); beard.rotation.x = -.12; beard.scale.set(1.02, .85, 1);
    head.add(beard);
  }

  /* Arms — delt cap, sleeved upper with a trim hem at the biceps, bare
     forearm, flattened palm + thumb (fingers implied toward −Z).
     Nested under Spine1 so spine twist carries them, as on the FBX rigs.
     The resting z-splay is CONTRACT: Actor captures it in restQ. ----- */
  const mkArm = side => {
    const L = side < 0;
    const arm = pivot(spine1, side * .215, .26, 0); channels[L ? 'armL' : 'armR'] = arm;
    arm.rotation.z = side * .09;
    const delt = new THREE.Mesh(HT_GEO.delt, jersey); delt.position.y = -.005; arm.add(delt);
    const sleeve = new THREE.Mesh(HT_GEO.sleeve, jersey); sleeve.position.y = -.14; arm.add(sleeve);
    const hem = new THREE.Mesh(HT_GEO.hem, trim); hem.position.y = -.283; arm.add(hem);
    const fore = pivot(arm, 0, -.295, 0); channels[L ? 'foreL' : 'foreR'] = fore;
    const fm = new THREE.Mesh(HT_GEO.foreArm, skin); fm.position.y = -.135; fore.add(fm);
    const hand = pivot(fore, 0, -.27, 0); channels[L ? 'handL' : 'handR'] = hand;
    const palm = new THREE.Mesh(HT_GEO.palm, skin);
    palm.scale.set(.74, .9, 1.3); palm.position.y = -.025; hand.add(palm);
    const thumb = new THREE.Mesh(HT_GEO.thumb, skin);
    thumb.position.set(-side * .024, -.045, -.028);
    thumb.rotation.set(-.2, 0, side * .65);
    hand.add(thumb);
  };
  mkArm(-1); mkArm(1);

  /* Bat mount handle — an empty socket group on the RIGHT WRIST pivot,
     recorded as root.userData.batMount (+ mirrored on the return object,
     the same pattern as headR). attachGear parents the bat mesh into it
     and registers it as Actor._batMount, which lets PlayerFactory's
     per-frame stance stabiliser ease the barrel into the cocked-over-the-
     shoulder batReady pose; without it channel rigs held the bat wherever
     the stance's hand roll happened to leave it (near-horizontal). */
  const batMount = new THREE.Group();
  batMount.name = 'batMount';
  channels.handR.add(batMount);

  /* Legs — thigh into a flared knicker cuff, club-colour stirrup sock,
     cleat. Toes toward −Z (the facing direction). */
  const mkLeg = side => {
    const L = side < 0;
    const leg = pivot(hips, side * .095, -.03, 0); channels[L ? 'legL' : 'legR'] = leg;
    const up = new THREE.Mesh(HT_GEO.thigh, pants); up.position.y = -.235; leg.add(up);
    const cuff = new THREE.Mesh(HT_GEO.knicker, pants); cuff.position.y = -.43; leg.add(cuff);
    const low = pivot(leg, 0, -.41, 0); channels[L ? 'legLowL' : 'legLowR'] = low;
    const stp = new THREE.Mesh(HT_GEO.sock, sock); stp.position.y = -.19; low.add(stp);
    const foot = new THREE.Mesh(HT_GEO.foot, shoeMat);
    foot.scale.set(1.15, .62, 1.05); foot.position.set(0, -.44, -.03);
    low.add(foot);
  };
  mkLeg(-1); mkLeg(1);

  /* Jersey numbers — large on the BACK (+Z; the face is −Z), small badge
     on the wearer's left chest. Ink flips to dark on light kits so the
     numeral reads against powder/orange cloth. */
  if (number != null) {
    const ink = lumOf(pri) > .58 ? '#101823' : '#f5f5f2';
    const nm = new THREE.MeshBasicMaterial({ map:numberTex(number, ink, true), transparent:true });
    const back = new THREE.Mesh(HT_GEO.numBack, nm);
    back.position.set(0, .135, .152); spine1.add(back);
    const nf = new THREE.MeshBasicMaterial({ map:numberTex(number, ink, false), transparent:true });
    const chest = new THREE.Mesh(HT_GEO.numChest, nf);
    chest.position.set(-.066, .155, -.140); chest.rotation.y = Math.PI; spine1.add(chest);
  }

  const blob = new THREE.Mesh(HT_GEO.blob, blobMat);
  blob.rotation.x = -Math.PI / 2; blob.position.y = .012; root.add(blob);
  root.traverse(o => { if (o.isMesh && o !== blob) o.castShadow = true; });

  root.userData.headR = .12;                     // skull radius for attachGear's cap/helmet sizing
  root.userData.batMount = batMount;             // wrist socket for attachGear's bat + stance stabiliser
  return { type:'humanoidTeam', root, channels, headR:.12, batMount };
}
