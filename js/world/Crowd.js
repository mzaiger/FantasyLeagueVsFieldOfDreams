/* =====================================================================
   Crowd.js — broadcast-grade instanced spectators for Gauntlet Park.
   Replaces the two flat box-crowd InstancedMeshes ('crowd' and
   'crowd_inner_bowl') that SceneManager.buildStadium() builds inline.
   Same anchoring maths (tier constants mirrored below), same GPU-bob
   architecture (attributes + one time uniform), upgraded:
     - row-aligned seating on the real tread lines, with empty seats
       and small absence-runs so rows read as seats, not confetti
     - two-part silhouettes: tapered shirted torso + skinned head,
       most fans in a dark cap (vertex-coloured into the head mesh),
       the rest with a hair shell — heads cut out against the field
     - per-fan instanceColour: skin tones on heads, muted street-clothes
       shirts on torsos, contiguous LIN-red (#C8102E, via Constants)
       home-fan clusters behind the plate and down the lines, a light
       visiting-team sprinkle elsewhere
     - varied bob: per-fan phase AND amplitude AND speed (some fans
       sit still), plus a periodic standing-wave that sweeps the bowl
       driven entirely from update(t) — 4 uniforms, zero allocations
   Still pure InstancedMesh: 3 draw calls (bodies / capped / bare),
   no per-frame CPU matrix work, no per-frame allocations, one 64px
   canvas texture. Part of the Lincoln Red Gauntlet engine · js/world/
===================================================================== */
import * as THREE from 'three';
import { DEG, TAU, rand, rint, pick, canvasTex } from '../utils/MathUtils.js';
import { FENCE_R, LIN, VSTAND } from '../core/Constants.js';
import { OPP } from '../entities/RosterManager.js';

export const CROWD_GROUP_NAME = 'crowd_v2';

/* Names of the SceneManager-built crowd meshes this module replaces. */
export const LEGACY_CROWD_NAMES = ['crowd', 'crowd_inner_bowl'];

/* ---- Stand maths — shared with SceneManager -----------------------------
   Every seat anchor MUST land on the same numbers the concrete uses or
   fans float / sink. The V-bowl arms, apex stand and dugout niches all
   derive from VSTAND in Constants.js (imported here); the outfield tier
   formulas are mirrored exactly as SceneManager builds them. There is no
   separate spec object left to drift out of sync. ----------------------- */

/* ---- Shared animation uniforms ----------------------------------------
   One object referenced by BOTH crowd materials, so update(t) writes
   four floats and every fan in the park moves. ------------------------- */
const U = {
  uTime:    { value: 0 },
  uWaveT0:  { value: -1e3 },     // wave start time (-inf = idle)
  uWaveDur: { value: 8 },
  uWaveFrom:{ value: -2.6 },     // wave coordinate range in aPhase units
  uWaveTo:  { value: 17.8 }
};

/* Vertex-shader bob + standing-wave. aPhase sweeps with azimuth around
   the bowl (identical formula to the legacy crowd, th * 2.4 + jitter),
   so a wave travelling that coordinate laps the whole park coherently.
   aAmp/aSpd de-sync neighbours: the crowd shimmers instead of pulsing. */
function injectCrowdMotion(mat) {
  mat.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader =
      'uniform float uTime,uWaveT0,uWaveDur,uWaveFrom,uWaveTo;\n' +
      'attribute float aPhase;\nattribute float aAmp;\nattribute float aSpd;\n' +
      sh.vertexShader.replace('#include <begin_vertex>',
`#include <begin_vertex>
{
  transformed.y += sin(uTime * aSpd + aPhase) * aAmp;
  transformed.x += cos(uTime * aSpd * 1.31 + aPhase * 1.7) * aAmp * .38;
  float wt = (uTime - uWaveT0) / uWaveDur;
  if (wt > 0. && wt < 1.) {
    float d = aPhase - mix(uWaveFrom, uWaveTo, wt);
    float g = exp(d * d * -.9);
    float env = smoothstep(0., .1, wt) * (1. - smoothstep(.86, 1., wt));
    float lift = g * env * .34;
    transformed.y += lift * (1. + .13 * abs(sin(uTime * 7. + aPhase)));
  }
}`);
  };
}

/* ---- Tiny coloured-geometry merger -------------------------------------
   Like Skyline.mergeGeoms but carries a per-part vertex COLOR so one
   merged mesh can mix skin (white verts -> shows instanceColour) with
   fixed-dark caps/hair (dark verts -> dark under any instance tint). -- */
function mergeColored(parts) {
  let vTotal = 0, iTotal = 0;
  for (const g of parts) {
    vTotal += g.attributes.position.count;
    iTotal += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(vTotal * 3), nor = new Float32Array(vTotal * 3),
        uv = new Float32Array(vTotal * 2), col = new Float32Array(vTotal * 3),
        idx = new Uint32Array(iTotal);
  let vOff = 0, iOff = 0;
  for (const g of parts) {
    pos.set(g.attributes.position.array, vOff * 3);
    nor.set(g.attributes.normal.array, vOff * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array, vOff * 2);
    col.set(g.attributes.color.array, vOff * 3);
    const gi = g.index, c = gi ? gi.count : g.attributes.position.count;
    for (let i = 0; i < c; i++) idx[iOff + i] = (gi ? gi.getX(i) : i) + vOff;
    iOff += c; vOff += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

/* Tag every vertex of a part with one flat RGB before merging. */
function tintVerts(geo, r, g, b) {
  const n = geo.attributes.position.count, c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { c[i * 3] = r; c[i * 3 + 1] = g; c[i * 3 + 2] = b; }
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return geo;
}

/* ---- Palettes -----------------------------------------------------------
   Shirts: muted street clothes (denim / grey / earth / khaki / cream),
   a couple of dusty brights. Skins: weighted toward light-mid tones.
   LIN red comes from Constants — never another red (brand rule). ------ */
const SHIRTS = [
  /* Day-game crowds skew light — creams/whites carry ~half the weight */
  '#e8e4da', '#e8e4da', '#d8d3c6', '#d8d3c6', '#e3ded2', '#efe9dc', '#c9c4b8',
  '#9db6c9', '#9db6c9', '#7f9db5', '#b8c9d6',            // light blues
  '#c2b490', '#c2b490', '#a49a7c', '#8f8a66',            // tans / khaki
  '#46617e', '#5d7a94', '#4f7280',                       // mid denims
  '#8d9298', '#a8adb2', '#7a5c3f', '#9c7e54',            // greys / earth
  '#3a4a63', '#565b61', '#26465e',                       // darks (low weight)
  '#7d3b45', '#6e3040',                                  // burgundy
  '#c8a44a', '#b5541e', '#7d9bb8'                        // rare accents
];
const SKINS = [
  '#f6d7bd', '#f6d7bd', '#efc49f', '#efc49f', '#e5b088', '#e5b088',
  '#d69a6e', '#d69a6e', '#c07f52', '#a97146', '#9c6238',
  '#7c4b2a', '#63401f', '#4e3016'
];

/* ======================================================================
   buildCrowd({ scene })
   Builds every spectator in the park (outfield bowl tiers, both V-bowl
   grandstand arms, the apex stand behind the plate) into ONE Group of
   three InstancedMeshes. Pass { scene } and the group is added for you.
   Returns { group, update, triggerWave, dispose, counts }.
====================================================================== */
export function buildCrowd(opts = {}) {

  /* Stand-maths mirrors (see Constants.VSTAND + SceneManager) ---------- */
  const slope   = .5;                                  // TIER_RISE/TIER_DEPTH
  const ofTopR  = t => FENCE_R + 7 + t * 4.2;
  /* NOTE: tier Y-pitch (2.05) differs from TIER_RISE (2.1) — consecutive
     outfield tiers overlap slightly in the stand construction. */
  const ofTopY  = t => 2.45 + t * 2.05;
  const VS      = VSTAND;
  const armLen  = Math.hypot(VS.p1x - VS.p0x, VS.p1z - VS.p0z);
  const aDx     = (VS.p1x - VS.p0x) / armLen, aDz = (VS.p1z - VS.p0z) / armLen;
  const aVx     = -aDz, aVz = aDx;                     // outward normal (1B-handed)
  const tread   = VS.width / VS.rows;
  const topAt   = u => VS.top0 + (VS.top1 - VS.top0) * (u / armLen);
  const rhAt    = u => (topAt(u) - VS.yBot) / VS.rows;
  const apxTopR = t => VS.apxR0 + t * VS.apxDepth;
  const apxTopY = t => 1.2 + t * VS.apxRise + VS.apxRise / 2;

  /* ---- Fan records (build-time scratch, discarded after upload) ----- */
  const fans = [];
  let redRun = 0;                                    // LIN-red cluster walker

  function shirtFor(zone) {
    let redP = zone === 'plate' ? .17 : zone === 'wing' ? .09 : .05;
    if (redRun > 0) redP = .52;                      // extend an open cluster
    if (Math.random() < redP) {
      redRun = rint(1, 4);                           // next few seats stay red
      return LIN.primary;
    }
    if (redRun > 0) redRun--;
    if (Math.random() < .06) return OPP.pri;         // visiting-pocket sprinkle
    return pick(SHIRTS);
  }

  function pushFan(th, x, y, z, zone) {
    const r = Math.random();
    fans.push({
      th, x, y, z, zone,
      yaw: th + Math.PI + rand(-.42, .42),           // face the field, jittered
      leanX: rand(-.05, .05), leanZ: rand(-.05, .05),
      sxz: rand(.88, 1.12), sy: rand(.72, 1.02),
      /* Amplitude mix: a few statues, most gentle, some lively. */
      amp: r < .07 ? rand(.004, .012) : r < .62 ? rand(.02, .045)
         : r < .9  ? rand(.04, .065) : rand(.06, .095),
      spd: rand(.8, 1.25),
      shirt: shirtFor(zone),
      skin: pick(SKINS),
      cap: Math.random() < .66
    });
  }

  /* Seat rows along a circular arc — quantised seating + jitter + gaps. */
  function arcSeats(az0, span, R, pitch, occ, cb) {
    const n = Math.floor(span * R / pitch);
    if (n < 1) return;
    const st = span / n;
    let blank = 0;
    for (let s = 0; s < n; s++) {
      if (blank > 0) { blank--; continue; }
      if (Math.random() > occ) {                     // empty seat / small run
        if (Math.random() < .3) blank = rint(2, 5);
        continue;
      }
      cb(az0 + (s + .5) * st + rand(-.09, .09) / R);
    }
  }

  /* -- Outfield bowl: 5 seat rows on each of the 3 tier treads -------- */
  for (let t = 0; t < 3; t++) {
    const rows = 5;
    for (let k = 0; k < rows; k++) {
      const rr = .32 + k * (4.2 - .64) / (rows - 1);
      const R = ofTopR(t) + rr;
      const footY = ofTopY(t) - rr * slope + .01;
      arcSeats(Math.PI * .75 + .06, Math.PI * .5 - .12, R, 1.02, .84,
        az => pushFan(az, Math.sin(az) * R, footY, Math.cos(az) * R, 'of'));
    }
  }

  /* -- Apex stand behind the plate: 3 seat rows on each of its 2 tiers,
        wedged between the V arms' heads (θ ±apxTH); zone 'plate' keeps
        the LIN-red home-fan clusters right behind home ----------------- */
  for (let t = 0; t < VS.apxN; t++) {
    const rows = 3;
    for (let k = 0; k < rows; k++) {
      const rr = .3 + k * (VS.apxDepth - .6) / (rows - 1);
      const R = apxTopR(t) + rr;
      const footY = apxTopY(t) - rr * (VS.apxRise / VS.apxDepth) + .01;
      arcSeats(-VS.apxTH * DEG + .05, (VS.apxTH - .05) * 2 * DEG, R, .8, .87,
        az => pushFan(az, Math.sin(az) * R, footY, Math.cos(az) * R, 'plate'));
    }
  }

  /* -- V arms: the 12 physical stepped rows walked down each straight
        run. Row height mirrors the concrete EXACTLY — SceneManager picks
        one rh per straight SEGMENT (head run / niche span / tail run),
        evaluated at that segment's midpoint — and lower rows skip the
        dugout-niche span so nobody sits inside the carve. -------------- */
  const segRh = u =>
    u <  VS.nicheU0 ? rhAt(VS.nicheU0 / 2) :
    u >  VS.nicheU1 ? rhAt((VS.nicheU1 + armLen) / 2) :
                      rhAt((VS.nicheU0 + VS.nicheU1) / 2);
  for (const s of [1, -1]) {
    for (let j = 0; j < VS.rows; j++) {
      let u = 2.2 + Math.random() * .4, blank = 0;
      while (u < armLen - 2.2) {
        if (!(u > VS.nicheU0 && u < VS.nicheU1 &&
              VS.yBot + (j + 1) * segRh(u) <= VS.nicheH)) {   // over the carve?
          if (blank > 0) blank--;
          else if (Math.random() > .82) { if (Math.random() < .3) blank = rint(2, 5); }
          else {
            const c = (j + .5) * tread + rand(-.16, .16);
            const x = s * (VS.p0x + u * aDx + c * aVx);
            const z = VS.p0z + u * aDz + c * aVz;
            pushFan(Math.atan2(x, z), x, VS.yBot + (j + 1) * segRh(u) + .01, z, 'wing');
          }
        }
        u += .95;
      }
    }
  }

  /* ---- Geometries ------------------------------------------------------
     Body: box tapered toward the shoulders, pivoted at the FEET so lean
     and bob act about the seat (same convention as the legacy crowd).
     Heads: skull + (cap crown + brim | hair shell), also foot-pivoted
     so the EXACT same instance matrix drives body and head and the GPU
     bob can never separate them. ------------------------------------- */
  const bodyGeo = new THREE.BoxGeometry(.54, .84, .44);
  {
    const p = bodyGeo.attributes.position;
    for (let i = 0; i < p.count; i++)
      if (p.getY(i) > 0) { p.setX(i, p.getX(i) * .78); p.setZ(i, p.getZ(i) * .7); }
    bodyGeo.translate(0, .42, 0);
  }

  const SKULL_Y = .945;
  const skull = () => tintVerts(new THREE.SphereGeometry(.132, 6, 5).translate(0, SKULL_Y, 0), 1, 1, 1);
  const capHeadGeo = mergeColored([
    skull(),
    tintVerts(new THREE.SphereGeometry(.142, 6, 3, 0, TAU, 0, 1.2)
      .scale(1, .8, 1).translate(0, .985, 0), .12, .13, .18),                  // cap crown
    tintVerts(new THREE.CylinderGeometry(.128, .134, .026, 7, 1, false, -Math.PI / 2, Math.PI)
      .rotateX(.16).translate(0, .955, .098), .12, .13, .18)                   // brim, tilted
  ]);
  const bareHeadGeo = mergeColored([
    skull(),
    tintVerts(new THREE.SphereGeometry(.139, 6, 3, 0, TAU, 0, 1.35)
      .scale(1, .92, 1).translate(0, .955, -.01), .16, .105, .06)              // hair shell
  ]);

  /* ---- Textures / materials -------------------------------------------
     One 64px shirt canvas: near-white so instanceColour carries the hue,
     with baked collar shadow + leg AO + fabric noise. Heads need no
     texture (flat lambert, vertex-coloured). Both materials share the
     motion uniforms. --------------------------------------------------- */
  const shirtTex = canvasTex(64, 64, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, '#ffffff'); gr.addColorStop(.5, '#eceff1');
    gr.addColorStop(.78, '#d3d7da'); gr.addColorStop(1, '#b9bec3');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(255,255,255,.5)'; g.fillRect(0, h * .05, w, h * .022); // shoulder sheen
    g.fillStyle = 'rgba(15,18,24,.34)'; g.fillRect(0, h * .075, w, h * .075);  // collar
    for (let i = 0; i < 170; i++) {
      g.fillStyle = Math.random() < .5 ? 'rgba(255,255,255,.05)' : 'rgba(20,24,30,.05)';
      g.fillRect(rand(0, w), rand(0, h), rand(1, 3), rand(1, 3));
    }
  });

  const bodyMat = new THREE.MeshLambertMaterial({ map: shirtTex });
  const headMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  injectCrowdMotion(bodyMat);
  injectCrowdMotion(headMat);

  /* ---- Meshes: bodies + capped heads + bare heads --------------------- */
  const capped = [], bare = [];
  for (const f of fans) (f.cap ? capped : bare).push(f);

  const group = new THREE.Group();
  group.name = CROWD_GROUP_NAME;

  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), Q2 = new THREE.Quaternion(),
        E = new THREE.Euler(), V = new THREE.Vector3(), S = new THREE.Vector3(),
        YAX = new THREE.Vector3(0, 1, 0), C = new THREE.Color();

  function writeMesh(name, geo, mat, list, isHead) {
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    mesh.name = name;
    const ph = new Float32Array(list.length), am = new Float32Array(list.length),
          sp = new Float32Array(list.length);
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      E.set(f.leanX, 0, f.leanZ); Q2.setFromEuler(E);
      Q.setFromAxisAngle(YAX, f.yaw).multiply(Q2);
      V.set(f.x, f.y, f.z); S.set(f.sxz, f.sy, f.sxz);
      mesh.setMatrixAt(i, M.compose(V, Q, S));
      ph[i] = f.th * 2.4 + rand(0, .8);              // bowl-wide ripple coord
      am[i] = f.amp; sp[i] = f.spd;
      if (isHead) C.set(f.skin);
      else C.set(f.shirt).offsetHSL(rand(-.02, .02), rand(-.05, .05), rand(-.05, .05));
      mesh.setColorAt(i, C);
    }
    geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(ph, 1));
    geo.setAttribute('aAmp', new THREE.InstancedBufferAttribute(am, 1));
    geo.setAttribute('aSpd', new THREE.InstancedBufferAttribute(sp, 1));
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();                    // correct instanced culling
    group.add(mesh);
    return mesh;
  }

  const meshes = {
    bodies: writeMesh('crowd_body', bodyGeo, bodyMat, fans, false),
    headsCapped: writeMesh('crowd_heads_capped', capHeadGeo, headMat, capped, true),
    headsBare: writeMesh('crowd_heads_bare', bareHeadGeo, headMat, bare, true)
  };

  /* ---- Standing-wave scheduler -----------------------------------------
     Every ~16-30 s a ridge of standing fans sweeps once around the bowl
     (direction alternates). Pure uniform writes — the travel itself is
     GPU-side, keyed off aPhase. -------------------------------------- */
  let waveAt = rand(3, 7), waveUntil = -1, dir = false;

  function update(t) {
    U.uTime.value = t;
    if (waveUntil < 0 && t >= waveAt) {
      dir = !dir;
      U.uWaveFrom.value = dir ? -2.6 : 17.8;
      U.uWaveTo.value = dir ? 17.8 : -2.6;
      U.uWaveT0.value = t;
      U.uWaveDur.value = 8.5;
      waveUntil = t + 8.5;
    } else if (waveUntil > 0 && t > waveUntil + 1.5) {
      waveUntil = -1;
      waveAt = t + rand(16, 30);
    }
  }

  function triggerWave() { waveAt = 0; waveUntil = -1; }

  function dispose() {
    group.children.forEach(m => m.geometry?.dispose());
    bodyMat.dispose(); headMat.dispose(); shirtTex.dispose();
  }

  if (opts.scene) opts.scene.add(group);

  const byZone = z => fans.reduce((n, f) => n + (f.zone === z), 0);

  return {
    group, meshes, update, triggerWave, dispose,
    counts: {
      outfield: byZone('of'),
      plate: byZone('plate'),
      wings: byZone('wing'),
      total: fans.length
    }
  };
}

/* ---- removeLegacyCrowd(scene) ------------------------------------------
   Convenience for integration: pulls the old inline crowd meshes out of
   the scene and frees their GPU resources. Call BEFORE buildCrowd. ---- */
export function removeLegacyCrowd(scene) {
  const dead = [];
  scene.traverse(o => { if (LEGACY_CROWD_NAMES.includes(o.name)) dead.push(o); });
  for (const o of dead) {
    o.parent.remove(o);
    o.geometry?.dispose();
    if (o.material) {                          // both meshes shared one material
      o.material.map?.dispose();
      o.material.dispose();
    }
  }
  return dead.length;
}
