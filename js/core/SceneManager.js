/* =====================================================================
   SceneManager.js — renderer, sky, lights, stadium, scoreboard surface
   Part of the Lincoln Red Gauntlet engine · js/core/
===================================================================== */
import * as THREE from 'three';
import { FENCE_R, FENCE_H, BASE_POS, VSTAND, STADIUM } from './Constants.js';
import { LIN } from './Constants.js';
import { DEG, TAU, rand, rint, pick, $, softCircleTexture, configureCanvasTex, canvasTex } from '../utils/MathUtils.js';
import { OPP } from '../entities/RosterManager.js';
import { buildCityscape, mergeGeoms } from '../world/Skyline.js';

export const renderer = new THREE.WebGLRenderer({ antialias:true, powerPreference:'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));   // capped ≤1.5 — biggest single fill-rate win on HiDPI screens
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.06;
$('stage').appendChild(renderer.domElement);
configureCanvasTex(renderer);

export const scene = new THREE.Scene();
/* Atmospheric haze — near plane past the stadium (r≈115) so the playing
   field stays crisp while the city skyline (r≈150-230) fades into it. */
scene.fog = new THREE.Fog(0xcfe3f5, 130, 470);

export const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, .1, 1200);
camera.position.set(0, 2.1, 5.4);

/* ---- Lighting -------------------------------------------------------- */
scene.add(new THREE.HemisphereLight(0xbfdcff, 0x4d6b33, .85));
export const sun = new THREE.DirectionalLight(0xfff1da, 1.55);
sun.position.set(75, 115, 45); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
/* Ortho box must cover EVERY shadow receiver that can reach the shadow
   map — field (r 92), grass-wedge tails (r 97.5), stands (r ~115) and the
   light towers (r 92). The old ±95 box left the wedge tails and the cement
   apron OUTSIDE the frustum: their clamped edge-sampling smeared the stand
   shadows across the whole outfield as giant streaks ("rays" bug). */
Object.assign(sun.shadow.camera, { left:-130, right:130, top:130, bottom:-130, near:20, far:320 });
sun.shadow.bias = -.0004; sun.shadow.normalBias = .03; sun.shadow.radius = 2.4;
scene.add(sun);
const fillLight = new THREE.DirectionalLight(0xa3bde8, .25);   // cool sky bounce opposite the sun, no shadows
fillLight.position.set(-72, 58, -48);
scene.add(fillLight);

/* ---- Sky dome · sun sprite · drifting clouds -------------------------- */
export const clouds = [];
{
  const skyMat = new THREE.ShaderMaterial({ side:THREE.BackSide, fog:false, depthWrite:false,
    uniforms:{ top:{value:new THREE.Color(0x4f8fd6)}, mid:{value:new THREE.Color(0xa8cdec)}, bot:{value:new THREE.Color(0xeaf3fb)} },
    vertexShader:`varying vec3 vp;void main(){vp=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    fragmentShader:`uniform vec3 top,mid,bot;varying vec3 vp;
      void main(){float h=normalize(vp).y;vec3 c=h>.18?mix(mid,top,smoothstep(.18,.75,h)):mix(bot,mid,smoothstep(-.05,.18,h));gl_FragColor=vec4(c,1.);}` });
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(600, 32, 18), skyMat));

  const sunSpr = new THREE.Sprite(new THREE.SpriteMaterial({
    map:softCircleTexture('rgba(255,247,223,1)', 'rgba(255,255,255,0)'),
    color:0xfff2c8, transparent:true, opacity:.95, fog:false, depthWrite:false }));
  sunSpr.position.copy(sun.position).normalize().multiplyScalar(520);
  sunSpr.scale.setScalar(140); scene.add(sunSpr);

  const cloudTex = softCircleTexture('rgba(255,255,255,.95)', 'rgba(255,255,255,0)');
  /* Two SHARED sprite materials (near/far) instead of one per cloud —
     same layered look, fewer material instances and state changes. */
  const cloudMats = [
    new THREE.SpriteMaterial({ map:cloudTex, color:0xffffff, transparent:true, opacity:.48, fog:false, depthWrite:false }),
    new THREE.SpriteMaterial({ map:cloudTex, color:0xf2f6fa, transparent:true, opacity:.34, fog:false, depthWrite:false })
  ];
  for (let i = 0; i < 7; i++) {
    const c = new THREE.Sprite(cloudMats[i % 2]);
    const a = rand(0, TAU), r = rand(240, 430);
    c.position.set(Math.sin(a) * r, rand(120, 210), Math.cos(a) * r);
    c.scale.set(rand(130, 230), rand(36, 62), 1);
    scene.add(c); clouds.push({ spr:c, v:rand(.6, 1.6) });
  }
}

/* ---- Playing surface & stadium ---------------------------------------- */
/* ---- Center-field scoreboard --------------------------------------------
   The videoboard itself lives in js/world/Scoreboard.js; its draw/bind API
   is re-exported here so main.js and HUDController keep their original
   import paths unchanged. ----------------------------------------------- */
export { setScoreboardDrawer, drawScoreboard, bindScoreboardState } from '../world/Scoreboard.js';
import { buildScoreboard } from '../world/Scoreboard.js';
import { buildCrowd } from '../world/Crowd.js';

let crowdV2 = null;         // Crowd.js v2 handle — built by buildStadium, ticked by updateCrowd

const grassTex = canvasTex(512, 512, (g, w, h) => {
  g.fillStyle = '#3f7d31'; g.fillRect(0, 0, w, h);
  for (let i = 0; i < 8; i++) { g.fillStyle = i % 2 ? 'rgba(206,232,158,.085)' : 'rgba(9,34,15,.115)'; g.fillRect(i * 64, 0, 64, h); }
  for (let i = 0; i < 6; i++) {   // broad warm/cool hue-drift patches, kept clear of tile edges
    const px = rand(50, w - 50), py = rand(50, h - 50), pr = rand(46, 92);
    const pg = g.createRadialGradient(px, py, 0, px, py, pr);
    pg.addColorStop(0, Math.random() < .5 ? 'rgba(148,178,66,.10)' : 'rgba(26,88,58,.10)');
    pg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = pg; g.beginPath(); g.arc(px, py, pr, 0, TAU); g.fill();
  }
  for (let i = 0; i < 5200; i++) { g.fillStyle = `rgba(${rint(10,70)},${rint(70,140)},${rint(15,60)},${rand(.05,.16)})`; g.fillRect(rand(0,w), rand(0,h), 1.6, rand(1.6,4)); }
}, [46, 46]);

const dirtTex = canvasTex(512, 512, (g, w, h) => {
  g.fillStyle = '#8a5a33'; g.fillRect(0, 0, w, h);
  for (let i = 0; i < 4200; i++) {
    const v = rint(-26, 26);
    g.fillStyle = `rgba(${138+v},${90+(v*.8|0)},${51+(v*.6|0)},${rand(.2,.5)})`;
    g.beginPath(); g.arc(rand(0,w), rand(0,h), rand(.7, 2.4), 0, TAU); g.fill();
  }
});

/* Concourse cement — the flat gray that now surrounds the whole park.
   Mottled slabs with expansion joints: the joint lines sit on the tile's
   left/top edges so the [64,64] repeat lays a ~8.75 m joint grid over the
   560 m disc without any visible seam elsewhere. */
const cementTex = canvasTex(512, 512, (g, w, h) => {
  g.fillStyle = '#a3a7ab'; g.fillRect(0, 0, w, h);
  for (let i = 0; i < 2600; i++) {
    const v = rint(-13, 13);
    g.fillStyle = `rgba(${163+v},${167+v},${171+v},${rand(.15,.4)})`;
    g.fillRect(rand(0, w), rand(0, h), rand(1, 3.2), rand(1, 3.2));
  }
  g.strokeStyle = 'rgba(96,100,104,.55)'; g.lineWidth = 3;
  g.beginPath(); g.moveTo(0, 1.5); g.lineTo(w, 1.5); g.moveTo(1.5, 0); g.lineTo(1.5, h); g.stroke();
}, [64, 64]);


export function buildStadium(key = 'oracle') {
  /* Stadium PICKER entry point (task 8): main.js calls this after the load
     screen's park choice. 'oracle' — the classic V-bowl park with city
     skyline; 'fod' — Field of Dreams (from FieldOfDreams.jpg): the SAME
     field with the stadium removed, corn in the outfield, 1960s school-
     field wood bleachers behind the plate. */
  STADIUM.key = key;
  STADIUM.name = key === 'fod' ? 'Field of Dreams' : 'Oracle Park';
  const FOD = key === 'fod';

  const grassMat = new THREE.MeshStandardMaterial({ map:grassTex, roughness:1 });
  const dirtMat  = new THREE.MeshStandardMaterial({ map:dirtTex, roughness:1 });

  /* Ground plane is now FLAT GRAY CEMENT everywhere outside the playing
     field (user directive: the world around the stadium is concourse). The
     park's own grass returns as a shaped polygon clipped to the stadium
     interior: fair sector out to just under the wall, both foul wedges up
     to the V arms' inner face lines, and the plate apron out to the
     backstop. Shape coords map to world (x, −z) after rotateX(−π/2), so a
     world azimuth θ becomes shape angle θ − 90°. */
  /* FOD sits in Iowa farmland — the world outside the field is GRASS, not
     concourse cement. Same disc; a re-tiled clone of the lawn texture keeps
     the base's 4.2 m tile matching the shaped field polygon's. The FOD disc
     runs out to r 560 (oracle keeps 280 — its skyline pad owns the far
     ring): with the jagged treeline band gone there is nothing left to
     mask the disc edge, so the lawn now reaches past the fog's far plane
     (380 in FOD) and the horizon dissolves into haze instead of showing a
     hard grass/sky rim at 280. Repeat doubles with the radius so the tile
     stays 4.2 m. */
  const baseTex = FOD ? (() => {
    const t = grassTex.clone(); t.repeat.set(266, 266); t.needsUpdate = true; return t;
  })() : cementTex;
  const cementBase = new THREE.Mesh(new THREE.CircleGeometry(FOD ? 560 : 280, FOD ? 96 : 72),
    new THREE.MeshStandardMaterial({ map:baseTex, roughness:FOD ? 1 : .97 }));
  cementBase.rotation.x = -Math.PI / 2; scene.add(cementBase);
  /* receiveShadow stays OFF: the apron runs to r 280 (oracle) / 560 (FOD),
     far past any sane shadow-frustum, so sampling it only ever produced
     edge-smear streaks. Nothing meaningful casts onto it — the city doesn't
     cast at all. */
  {
    const V = VSTAND;
    const shp = new THREE.Shape();
    shp.moveTo(V.p0x, -V.p0z);                       // 1B arm head (backstop corner)
    shp.lineTo(V.p1x, -V.p1z);                       // down the arm's inner face line
    const a1 = Math.atan2(-V.p1z, V.p1x);            // ≈ 44.6° — tail's shape angle
    shp.absarc(0, 0, FENCE_R + 1, a1, a1 + Math.PI / 2, false);   // under the OF wall through CF
    shp.lineTo(-V.p1x, -V.p1z);                      // 3B tail
    shp.lineTo(-V.p0x, -V.p0z);                      // back up the 3B face line
    const aH1 = Math.atan2(-V.p0z, V.p0x),           // ≈ −.574 rad (1B head)
          aH3 = Math.atan2(-V.p0z, -V.p0x);          // ≈ −2.567 rad (3B head)
    shp.absarc(0, 0, 9.35, aH3, aH1, false);         // behind the plate, under the backstop pad
    shp.closePath();
    const grassPoly = new THREE.Mesh(new THREE.ShapeGeometry(shp, 24),
      new THREE.MeshStandardMaterial({ map:grassTex, roughness:1,
        /* NO polygonOffset here: a depth bias beats every coplanar-ish
           surface, including the infield dirt stacked ABOVE the lawn —
           the bias painted lawn over the whole dirt circle (the "no more
           dirt" regression). The y-ladder below gives every ground layer
           a real ≥10 mm separation instead, which holds at all camera
           distances (precision ≈ 4.8 mm at 200 m with near .5). */ }));
    /* ShapeGeometry uses raw local coords as UVs (metres) — with grassTex's
       repeat 46 the lawn would tile ~46× per METRE and shimmer into pale
       moiré rays across the outfield. Rescale to the legacy circle's tiling
       (46 repeats across ~193 m ⇒ one 4.2 m tile) before it renders. */
    {
      const gp = grassPoly.geometry.attributes.position,
            gu = grassPoly.geometry.attributes.uv;
      for (let i = 0; i < gu.count; i++) gu.setXY(i, gp.getX(i) / 193, gp.getY(i) / 193);
    }
    grassPoly.name = 'grass_field';
    grassPoly.rotation.x = -Math.PI / 2; grassPoly.position.y = .004;
    grassPoly.receiveShadow = true; scene.add(grassPoly);
  }

  const flat = (geo, mat, x, z, y, rz) => {
    const m = new THREE.Mesh(geo, mat); m.rotation.x = -Math.PI / 2;
    if (rz) m.rotation.z = rz; m.position.set(x, y, z); m.receiveShadow = true; scene.add(m); return m;
  };
  flat(new THREE.CircleGeometry(29, 48), dirtMat, 0, -13.2, .012);            // infield dirt
  flat(new THREE.PlaneGeometry(27.4, 27.4), grassMat, 0, -19.38, .02, Math.PI / 4); // infield grass diamond
  flat(new THREE.CircleGeometry(4.2, 36), dirtMat, 0, 0, .03);                 // home plate dirt
  /* Warning track — CLIPPED to the fair sector (θ 45°..135° in the ring's
     local frame, which maps to world θ 135°..225°). The old full-360° ring
     kept running behind the plate and down both lines where no wall exists;
     lying just .011 above the new cement base it z-fought into dashed
     moiré rings from any elevated camera and read as a floating brown
     circle on the concrete. Raised to y .02 to clear the grass polygon
     (y .004) it overlaps in fair territory. */
  flat(new THREE.RingGeometry(FENCE_R - 6, FENCE_R - .4, 96, 1, Math.PI / 4, Math.PI / 2),
    dirtMat, 0, 0, .02);

  const mound = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 2.9, .24, 26), dirtMat);
  mound.position.set(0, .12, -18.44); mound.castShadow = mound.receiveShadow = true; scene.add(mound);
  const rubber = new THREE.Mesh(new THREE.BoxGeometry(.61, .05, .16),
    new THREE.MeshStandardMaterial({ color:0xf4f4f4, roughness:.7 }));
  rubber.position.set(0, .265, -18.44); rubber.castShadow = true; scene.add(rubber);

  /* Bases + home plate */
  const white = new THREE.MeshStandardMaterial({ color:0xffffff, roughness:.55 });
  BASE_POS.slice(0, 3).forEach(p => {
    const b = new THREE.Mesh(new THREE.BoxGeometry(.56, .11, .56), white);
    b.rotation.y = Math.PI / 4; b.position.set(p.x, .055, p.z);
    b.castShadow = b.receiveShadow = true; scene.add(b);
    flat(new THREE.CircleGeometry(1.05, 20), dirtMat, p.x, p.z, .028);
  });
  {
    const s = new THREE.Shape();
    s.moveTo(-.216, 0); s.lineTo(.216, 0); s.lineTo(.216, -.216);
    s.lineTo(0, -.372); s.lineTo(-.216, -.216); s.closePath();
    const plate = new THREE.Mesh(new THREE.ShapeGeometry(s), white);
    plate.rotation.x = -Math.PI / 2; plate.position.y = .04; plate.castShadow = true; scene.add(plate);
  }

  /* Chalk foul lines + batter boxes */
  const chalk = new THREE.MeshBasicMaterial({ color:0xf8f8f2, transparent:true, opacity:.92 });
  [1, -1].forEach(sx => {
    /* Trimmed to run apex → fence: the old 1.02·R strip centred on the
       midpoint left its inner tip .01·R ≈ 0.9 m BEHIND the plate apex.
       Length 1.005·R with the centre at exactly half that distance puts
       the inner tip on the apex (the junction hides under the white
       plate) and the outer end just under the wall/pole line. */
    const len = FENCE_R * 1.005;
    const l = new THREE.Mesh(new THREE.PlaneGeometry(.14, len), chalk);
    /* z-rotation sign: −sx·45° lays the strip's length axis along the home→
       corner diagonal (1B line direction (1,0,−1)/√2 for sx=+1). The old
       +sx·45° rotated the strip PERPENDICULAR to the diagonal — both lines
       crossed in centre field as a giant white "V" chalk mark on the grass
       while the real foul lines were missing entirely. */
    l.rotation.x = -Math.PI / 2; l.rotation.z = -sx * Math.PI / 4;
    l.position.set(sx * (len / 2) * Math.SQRT1_2, .032, -(len / 2) * Math.SQRT1_2); scene.add(l);
  });
  [.95, -.95].forEach(bx => {
    const mk = (w, d, x, z) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), chalk);
      m.rotation.x = -Math.PI / 2; m.position.set(x, .032, z); scene.add(m);
    };
    mk(.08, 1.8, bx - .55, .35); mk(.08, 1.8, bx + .55, .35);
    mk(1.18, .08, bx, -.55); mk(1.18, .08, bx, 1.25);
  });

  /* On-deck circles (SEV-1 audit): Game.js parks each side's next hitter
     at (±6.5, 3.5) with nothing marking the spot. Flat dirt pads + white
     chalk rings via the same flat() idiom as the base circles above; this
     is the SHARED field section, so both parks pour them identically.
     y ladder: infield dirt sits at .012, chalk lines at .032 — pads at
     .026 / rings at .03 clear everything nearby without touching the lines. */
  [-1, 1].forEach(sx => {
    flat(new THREE.CircleGeometry(1.05, 24), dirtMat, sx * 6.5, 3.5, .026);
    flat(new THREE.RingGeometry(.93, 1.01, 24), chalk, sx * 6.5, 3.5, .03);
  });

  /* Fair-sector arc (cylinder theta frame: 135°..225°) — shared by the
     oracle wall and the FOD corn mass so both sit exactly on FENCE_R. */
  const a0 = Math.PI * .75, alen = Math.PI * .5;

  if (FOD) {
    /* ---- FIELD OF DREAMS (from FieldOfDreams.jpg) — same field, NO stadium:
       no bowl, no backstop, no towers, no videoboard, no city. Instead: a
       tall corn mass occupying the wall's slot (physics keeps FENCE_R —
       wall-balls rustle back out of the stalks, true bombs vanish into the
       field of corn), 1960s school-field wood bleachers behind the plate,
       and open dugout benches at the exact coordinates Game.js stages
       bench actors to. No horizon ring of any kind — the old jagged
       treeline band read as a mountain ridge on the skyline, so the
       prairie horizon is left to the deep corn and the fog. ------------ */
    /* Morning haze — FOD-only fog retune (oracle keeps the module's crisp
       130→470 default; the oracle path below resets it, so park order in
       one session can't leak). Pulling near in to 50 grades the deep corn
       rings into soft haze while the playing field — and the farmstead
       behind the plate (r ≈ 35) — stay crisp; the sky dome, sun sprite and
       clouds already opt out via fog:false, so the backdrop can't be
       muddied. */
    scene.fog.color.set(0xd8e5f0); scene.fog.near = 50; scene.fog.far = 380;

    const cornTex = canvasTex(256, 512, (g, w, h) => {
      g.clearRect(0, 0, w, h);
      for (let i = 0; i < 16; i++) {                        // full-height stalks
        const x = (i + .5) * (w / 16) + rand(-6, 6);
        const sway = rand(-12, 12);
        g.strokeStyle = `hsl(${rint(80, 102)},${rint(46, 60)}%,${rint(26, 40)}%)`;
        g.lineWidth = rand(6, 10);
        g.beginPath(); g.moveTo(x, h);
        g.quadraticCurveTo(x + sway, h * .55, x + sway * 1.7, rand(h * .04, h * .18));
        g.stroke();
        for (let L = 0; L < 9; L++) {                       // arcing leaf blades
          const ly = h * (.14 + L * .095), dir = L % 2 ? 1 : -1;
          g.strokeStyle = `hsl(${rint(74, 106)},${rint(48, 64)}%,${rint(28, 46)}%)`;
          g.lineWidth = rand(4, 7);
          g.beginPath(); g.moveTo(x + sway * (1 - ly / h), ly);
          g.quadraticCurveTo(x + dir * rand(16, 32), ly - rand(6, 16),
            x + dir * rand(34, 58), ly - rand(16, 32));
          g.stroke();
        }
        /* pollen-tassel sprays at the tasselled tops — the tan crown that
           says CORN rather than hedge */
        g.strokeStyle = `hsl(${rint(48, 58)},${rint(38, 52)}%,${rint(52, 64)}%)`;
        g.lineWidth = rand(2.5, 4);
        const tx = x + sway * 1.7;
        for (const dx of [-7, 0, 7]) {
          g.beginPath(); g.moveTo(tx, h * .06);
          g.lineTo(tx + dx + rand(-3, 3), rand(0, h * .035)); g.stroke();
        }
      }
    }, [1, 1]);
    const cornMat = (ru = 1, rv = 1) => {                   // per-user clone: repeats differ per layer
      const t = cornTex.clone(); t.repeat.set(ru, rv); t.needsUpdate = true;
      return new THREE.MeshStandardMaterial({
        map:t, alphaTest:.3, side:THREE.DoubleSide, roughness:1 });
    };

    /* Ten depth layers on the wall's arc, widened past both foul lines so
       the corners wrap naturally (the physics wall stays on the fair arc —
       the extra corn is pure decoration over dead territory). Heights tower
       2×+ over the players, like the movie's wall of corn; each layer steps
       back and UP so elevated/result cams never see the ring end. u-repeat
       keeps each painted stalk ≈ .5 m wide at the wall coarsening to ≈ 1.2 m
       in the deep field (tile arc ÷ ru ÷ 16 stalk columns); v stays 1 so a
       stalk reads full-height, not stacked segments.
       EXTENDED (owner ask — corn must dominate beyond the fence): the seven
       tuned near rings are untouched and three deep-sea rings continue the
       same step pattern out to FENCE_R + 48 (r ≈ 139), roughly doubling the
       radial reach (24 → 48 m past the fence; ≈2.5× annulus area over the
       sector) and wrapping ±23° past each line. Tops plateau at the audited
       9.5 m — Flyover's cruise keys clear exactly that figure — then ease
       down (9.3, 9.1) so the distant rim melts into haze instead of ending
       on a hard shelf. Balls despawn at BallPhysics's FENCE_R + 26 (117 m),
       which now lands INSIDE the corn: deep bombs vanish into stalks rather
       than winking out on open grass, so the abrupt kill reads as "lost in
       the corn". Each ring is one draw call on its own cloned material. */
    [[FENCE_R + .1, 4.2, 18], [FENCE_R + .9, 4.6, 17], [FENCE_R + 3.2, 5.6, 15],
     [FENCE_R + 6.8, 6.8, 13], [FENCE_R + 11.6, 7.7, 13], [FENCE_R + 17.2, 8.6, 13],
     [FENCE_R + 23.6, 9.5, 14],
     [FENCE_R + 30.8, 9.5, 15], [FENCE_R + 39.0, 9.3, 16], [FENCE_R + 48.2, 9.1, 18]]
      .forEach(([r, hh, ru], i) => {
        const grow = i * .045;                              // wider arc per layer
        const m = new THREE.Mesh(
          new THREE.CylinderGeometry(r, r, hh, 96, 1, true, a0 - .015 - grow, alen + .03 + grow * 2),
          cornMat(ru, 1));
        m.position.y = hh / 2; scene.add(m);
      });

    /* Real 3D stalks for parallax — ONE instanced draw call of crossed
       quads, random height/yaw, scattered across the whole stalk field:
       the arc wraps ~23° past each foul line (matching the deepest layer)
       and the depth runs ~48 m past the fence, density biased toward the
       wall (pow 1.35) so the near rows stay dense while the deep sea still
       reads as continuous corn. Instance count scales with the sampled
       annulus: 2900 covered r ≤ 115 across ±61° (~5.3 k m²); the doubled
       footprint samples ~13 k m², so N ×2.5 → 7200 keeps per-m² density
       identical — still ONE draw call (~29 k tris vs ~12 k). Azimuth frame
       is the wallPlane one — 0 = centre field, ±45° = the lines — so ±68°
       dresses the fair arc plus the deep layers' wrap; the old 45..135
       range sprayed the stalks into 1B dead territory. */
    {
      const stalkGeo = mergeGeoms([
        new THREE.PlaneGeometry(.9, 1).translate(0, .5, 0),
        new THREE.PlaneGeometry(.9, 1).rotateY(Math.PI / 2).translate(0, .5, 0)
      ]);
      const N = 7200;
      const stalks = new THREE.InstancedMesh(stalkGeo, cornMat(), N);
      const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler(),
            S = new THREE.Vector3(), P = new THREE.Vector3();
      for (let i = 0; i < N; i++) {
        const th = rand(-68, 68) * DEG,
              r = FENCE_R + .1 + 48.1 * Math.pow(Math.random(), 1.35);
        P.set(Math.sin(th) * r, 0, -Math.cos(th) * r);
        E.set(0, rand(0, TAU), 0); Q.setFromEuler(E);
        S.set(rand(.85, 1.3), rand(2.6, 3.9), rand(.85, 1.3));
        M.compose(P, Q, S); stalks.setMatrixAt(i, M);
      }
      scene.add(stalks);
    }

    /* 1960s school-field bleachers — five rows of wood planks on a timber
       frame behind the plate. (The old short line wings that sat yawed in
       FRONT of this stand as a V are gone — owner: "remove the weird v
       bench in front of the normal bench behind home plate"; the plain
       five-row stand is what stays.) Crowd.js seats only on the oracle
       bowl formulas, so the few period spectators this stand hosts are
       raised right below. */
    {
      const woodMat = new THREE.MeshStandardMaterial({ color:0x9a7b52, roughness:.92 });
      const ROWS = 5, W = 15, tread = 1.18, rise = .6;
      const parts = [];
      for (let rI = 0; rI < ROWS; rI++) {
        const zC = 11.4 + rI * tread + tread / 2, y = .55 + rI * rise;
        parts.push(new THREE.BoxGeometry(W, .1, tread).translate(0, y, zC));              // seat plank
        parts.push(new THREE.BoxGeometry(W, y, .16).translate(0, y / 2, zC - tread / 2 + .02)); // riser
      }
      const frameH = .55 + (ROWS - 1) * rise;
      for (const sx of [-W / 2 + .4, 0, W / 2 - .4])            // stringers under the rows
        parts.push(new THREE.BoxGeometry(.22, frameH, ROWS * tread).rotateX(.42)
          .translate(sx, frameH / 2, 11.4 + ROWS * tread / 2));
      const bleacher = new THREE.Mesh(mergeGeoms(parts), woodMat);
      bleacher.name = 'fod_bleachers';
      bleacher.castShadow = bleacher.receiveShadow = true; scene.add(bleacher);
    }

    /* Period spectators — a sparse handful of early-1900s Iowa townsfolk on
       the school-field bleachers built above (owner ask: "put few fans in
       the seats behind the plate"). Oracle's Crowd.js stays untouched — it
       seats only on the oracle bowl formulas — so FOD raises its own dozen
       figures: each fan is ONE merged, vertex-coloured geometry (lap/shin/
       torso/arm boxes + a 7-segment skull; a few wear flat tweed caps or
       brimmed straw hats — deliberately NO ballcaps and no team colours, so
       LIN red never leaks onto the field dressing), all sharing one
       MeshStandardMaterial → a dozen draw calls total. Seated pose follows
       the real plank lines: hips .45 forward of each plank centre (front
       half of the board), shins dropping past the plank edge, feet dangling
       toward the next tread down. Barely-there idle sway rides the existing
       updateCrowd tick hook through crowdV2 — per-fan sine phase, ≤.017 rad,
       zero per-frame allocation. */
    {
      const fanMat = new THREE.MeshStandardMaterial({ vertexColors:true, roughness:.95 });
      const tint = (g, hex) => {                    // bake one flat colour into vertices
        const c = new THREE.Color(hex), n = g.attributes.position.count,
              a = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) { const j = i * 3; a[j] = c.r; a[j + 1] = c.g; a[j + 2] = c.b; }
        g.setAttribute('color', new THREE.BufferAttribute(a, 3));
        return g;
      };
      /* Muted workwear / Sunday-best palette — browns, greys, dusty blues. */
      const SHIRTS = [0x6e5a41, 0x8c8577, 0x5d6b74, 0x746248, 0x504a42, 0x86766a],
            PANTS  = [0x4a4238, 0x3e3a33, 0x55503f, 0x596058],
            SKIN   = [0xd9ab8a, 0xc99872, 0xb98a63],
            HAIR   = [0x3f3128, 0x8d8880, 0x2e2620, 0xa8895f];
      /* One seated figure in LOCAL frame — hips at the origin resting on a
         plank top, facing −z toward the field (~180 tris apiece). */
      const mkFanGeo = hat => mergeGeoms([
        tint(new THREE.BoxGeometry(.34, .14, .38).translate(0, .07, -.06), pick(PANTS)),            // lap
        tint(new THREE.BoxGeometry(.26, .5, .13).translate(0, -.2, -.2), pick(PANTS)),              // shins
        tint(new THREE.BoxGeometry(.11, .1, .19).translate(-.075, -.48, -.235), 0x3a322a),           // boots
        tint(new THREE.BoxGeometry(.11, .1, .19).translate(.075, -.48, -.235), 0x3a322a),
        tint(new THREE.BoxGeometry(.37, .47, .24).translate(0, .375, .02), pick(SHIRTS)),           // torso
        tint(new THREE.BoxGeometry(.09, .35, .11).rotateX(.32).translate(-.235, .38, -.04), pick(SHIRTS)),
        tint(new THREE.BoxGeometry(.09, .35, .11).rotateX(.32).translate(.235, .38, -.04), pick(SHIRTS)),
        tint(new THREE.SphereGeometry(.105, 7, 6).translate(0, .74, .01), pick(SKIN)),              // head
        ...(hat === 'cap'                                                            // flat tweed cap
          ? [tint(new THREE.SphereGeometry(.118, 7, 4, 0, TAU, 0, 1.25).scale(1, .62, 1.05)
                 .translate(0, .8, .01), 0x777168),
             tint(new THREE.BoxGeometry(.15, .028, .1).rotateX(.18).translate(0, .735, -.115), 0x777168)]
          : hat === 'straw'                                                          // brimmed straw hat
            ? [tint(new THREE.CylinderGeometry(.2, .225, .028, 10).translate(0, .805, .01), 0xc9b184),
               tint(new THREE.CylinderGeometry(.1, .115, .11, 9).translate(0, .86, .01), 0xc9b184)]
            : [tint(new THREE.SphereGeometry(.112, 7, 4, 0, TAU, 0, 1.5).scale(1, .9, 1)
                 .translate(0, .76, .005), pick(HAIR))])                             // bare hair
      ]);

      const fans = [];
      const seatFan = (mesh, x, y, z, yaw) => {
        mesh.name = 'fod_fan';
        mesh.position.set(x, y, z); mesh.rotation.y = yaw; mesh.castShadow = true;
        mesh.userData = { ph:rand(0, TAU), sp:rand(.55, .95), amp:rand(.007, .017) };
        fans.push(mesh); scene.add(mesh);
      };
      /* Sparse scatter across the five rows — plank tops run y .60→3.00 at
         plank centres z 11.99→16.71, hips parked .45 forward of each centre;
         wide gaps keep it "a few neighbours came out", never a bowl. (The
         two wing latecomers left with the removed V wings.) */
      [[0, -4.7, 'straw'], [0, 2.4, null],
       [1, -1.0, null],   [1, 5.2, 'cap'],
       [2, -5.9, null],   [2, 1.2, 'straw'], [2, 6.3, null],
       [3, -2.8, 'cap'],  [3, 4.0, null],
       [4, 0.5, null]]
        .forEach(([r, x, hat]) => seatFan(new THREE.Mesh(mkFanGeo(hat), fanMat),
          x + rand(-.15, .15), .6 + r * .6, 11.99 + r * 1.18 - .45, rand(-.14, .14)));

      /* Idle life through the SAME hook oracle's crowd uses — main.js calls
         updateCrowd(t) every tick regardless of park; here it tips each fan
         ≤.017 rad about its hips on an individual phase. No per-frame
         allocations, no instance-buffer uploads. */
      crowdV2 = { update(t) {
        for (let i = 0; i < fans.length; i++) {
          const f = fans[i];
          f.rotation.z = Math.sin(t * f.userData.sp + f.userData.ph) * f.userData.amp;
        }
      } };
    }

    /* Open dugout benches — no carved niches in a schoolyard, so the bench
       actors (Game.js tables: LIN |x| 14.3–16.6 · z −5.8…−7.6 both sides,
       visitors x 17.2–19.0 · z −8.9…−6.7 on the 1B side) get plain plank
       benches right where they stand. */
    {
      const benchMat = new THREE.MeshStandardMaterial({ color:0x7a5230, roughness:.85 });
      const mkBench = (x, z, len, yaw) => {
        const bg = new THREE.Group();
        const seat = new THREE.Mesh(new THREE.BoxGeometry(len, .09, .55), benchMat);
        seat.position.y = .48; seat.castShadow = seat.receiveShadow = true; bg.add(seat);
        const legGeo = new THREE.BoxGeometry(.1, .48, .5);
        for (const lx of [-len / 2 + .35, 0, len / 2 - .35]) {
          const leg = new THREE.Mesh(legGeo, benchMat);
          leg.position.set(lx, .24, 0); leg.castShadow = true; bg.add(leg);
        }
        bg.position.set(x, 0, z); bg.rotation.y = yaw; scene.add(bg);
      };
      /* Yaw ±π/4 runs each bench's long axis PARALLEL to its foul line
         (the lines head (.707, 0, −.707) / (−.707, 0, −.707); local +x
         maps to (cos yaw, 0, −sin yaw), so +π/4 on the 1B side aligns the
         plank with the line) with the bench front (local −z) turned across
         the line toward the infield — the old −π/4/π/4 signs sat the planks
         perpendicular, staring off into foul territory. */
      mkBench( 15.5, -7.2, 7.5,  Math.PI / 4);                  // 1B home bench
      mkBench(-15.5, -7.2, 7.5, -Math.PI / 4);                  // 3B home bench
      mkBench( 18.1, -7.8, 6.5,  Math.PI / 4);                  // visitors, 1B side
    }

    /* White 1900s farmhouse + red gable barn BEHIND THE BACKSTOP — the
       movie's farmstead overlooking the field from behind home plate, in
       the view the catcher/umpire cameras look back at. Pure low-poly
       boxes and gable triangles, merged into FOUR draw calls (one per flat
       material), both facing the plate as one grouping on the grass well
       past the bleachers' far edge (house (−10, +42), barn (+12, +38) —
       the bleacher rows end at z ≈ 17.3 and the backstop hood at r 10.1,
       so nothing touches the playable surface, any camera position (all
       inside r ≈ 7.6) or the foul-ball flight corridor's sight lines).
       Each building bakes its OWN part arrays — sharing arrays across the
       two bake passes would double-transform the first building's parts.
       castShadow stays off: the whole behind-plate apron takes no shadows
       (the disc's receiveShadow is deliberately off — see the base-disc
       note above), so a lone house shadow would have nothing to land on.
       DoubleSide so the flat gable planes read from both sides. */
    {
      const whiteMat = new THREE.MeshStandardMaterial({ color:0xf4f1e8, roughness:.9, side:THREE.DoubleSide }),
            roofMat  = new THREE.MeshStandardMaterial({ color:0x46413c, roughness:.95, side:THREE.DoubleSide }),
            redMat   = new THREE.MeshStandardMaterial({ color:0x9e3226, roughness:.88, side:THREE.DoubleSide }),
            trimMat  = new THREE.MeshStandardMaterial({ color:0x45403a, roughness:.85, side:THREE.DoubleSide });
      const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
      const gable = (hw, rise) => {                     // triangular gable end, ridge up
        const s = new THREE.Shape();
        s.moveTo(-hw, 0); s.lineTo(hw, 0); s.lineTo(0, rise);
        return new THREE.ShapeGeometry(s);
      };
      const bake = (parts, x, z) => {                   // face the plate, place
        const yaw = Math.atan2(-x, -z);
        for (const arr of parts) for (const g of arr) g.rotateY(yaw).translate(x, 0, z);
      };

      /* Farmhouse — 13×9 two-storey clapboard block, pitched roof with
         eave overhangs, full-width porch on four posts, brick chimney off
         the ridge, dark door + windows. Sits at (−10, +42), a step back
         from the barn so the pair reads as one farmstead. */
      const hW = [], hR = [], hRed = [], hTrim = [];
      {
        const pitch = Math.atan2(3.6, 7.1);
        for (const s of [1, -1]) {
          hR.push(box(8.4, .24, 10).rotateZ(-s * pitch).translate(s * 3.55, 8.3, 0));
          hW.push(gable(6.5, 3.6).translate(0, 7, s * 4.5));
          for (const px of [4.1, 1.4])                  // porch posts
            hW.push(box(.28, 5.2, .28).translate(s * px, 3.1, 6.7));
          for (const wy of [4.9, 2.4])                  // front windows, two floors
            hTrim.push(box(1.5, 1.7, .14).translate(s * 3.7, wy, 4.52));
        }
        hW.push(box(13, 7, 9).translate(0, 3.5, 0));
        hW.push(box(9, .5, 2.6).translate(0, .25, 5.8));           // porch deck
        hR.push(box(9.6, .22, 3.1).translate(0, 5.8, 6.0));        // porch roof
        hRed.push(box(1.1, 3.2, 1.1).translate(3.3, 10.6, -1.7));  // brick chimney
        hTrim.push(box(1.7, 3.1, .16).translate(0, 1.55, 4.53));   // front door
        bake([hW, hR, hRed, hTrim], -10, 42);
      }

      /* Barn — classic red gable barn, 11×13, white trim double doors with
         X-braces, hay door in the gable. Sits at (+12, +38). */
      const bW = [], bR = [], bRed = [], bTrim = [];
      {
        const pitch = Math.atan2(3.2, 6.1);
        for (const s of [1, -1]) {
          bR.push(box(7.3, .26, 14).rotateZ(-s * pitch).translate(s * 3.05, 8.6, 0));
          bRed.push(gable(5.5, 3.2).translate(0, 7, s * 6.5));
        }
        bRed.push(box(11, 7, 13).translate(0, 3.5, 0));
        bW.push(box(3.6, 5, .18).translate(0, 2.5, 6.56));         // trim double doors
        for (const s of [1, -1])                                   // door X-braces
          bW.push(box(.24, 6.3, .1).rotateZ(s * .62).translate(0, 2.5, 6.68));
        bTrim.push(box(1.4, 1.6, .14).translate(0, 8.05, 6.55));   // hay door
        bake([bW, bR, bRed, bTrim], 12, 38);
      }

      const farm = [
        ['fod_farm_white', mergeGeoms([...hW, ...bW]), whiteMat],
        ['fod_farm_roof', mergeGeoms([...hR, ...bR]), roofMat],
        ['fod_farm_red', mergeGeoms([...hRed, ...bRed]), redMat],
        ['fod_farm_trim', mergeGeoms([...hTrim, ...bTrim]), trimMat]
      ];
      for (const [n, g, m] of farm) {
        const mesh = new THREE.Mesh(g, m);
        mesh.name = n; scene.add(mesh);
      }
    }

    /* Worn dirt farm road — THE ROAD TO THE HOUSE (owner ask): a dusty
       track that starts in the farmstead yard between the barn (x 6.5…17.5,
       z 31.5…44.5) and the house (x −16.5…−3.5, z 37.5…46.5), then runs
       out across the deep-back grass toward the horizon, AWAY from the
       field. Anchors are farmstead ↔ fog only — it never approaches foul
       ground, the plate side or the corn (every corn ring and stalk stands
       on the OUTFIELD arc around CF, all z < 0, so this +z track crosses
       no stalks and needs no corridor). One flat ribbon along a
       CatmullRomCurve3, ~3 m wide, y +0.03 over the apron, one draw call;
       wheel ruts + grain are painted into a small repeating canvas tile,
       v-tiling rides arc length so rut spacing stays honest around the
       bends. The far end (z 362) dies inside the fog band (fog.far 380),
       so the track fades into the haze instead of ending on a cut edge.
       receiveShadow stays off — the whole behind-plate apron takes no
       shadows (see the base-disc note above). */
    {
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3( 1.5, 0,  43),
        new THREE.Vector3( 4.0, 0,  90),
        new THREE.Vector3(-6.0, 0, 165),
        new THREE.Vector3( 3.0, 0, 245),
        new THREE.Vector3(-4.0, 0, 318),
        new THREE.Vector3( 0.0, 0, 362)
      ]);
      const roadTex = canvasTex(128, 128, (g, w, h) => {
        g.fillStyle = '#d2bd94'; g.fillRect(0, 0, w, h);           // dusty tan base
        g.fillStyle = 'rgba(222,204,164,.35)';                     // worn centre crown
        g.fillRect(w * .3, 0, w * .4, h);
        for (let i = 0; i < 260; i++) {                            // dirt grain
          g.fillStyle = `rgba(${rint(150, 200)},${rint(130, 175)},${rint(95, 135)},${rand(.08, .2)})`;
          g.fillRect(rand(0, w), rand(0, h), rand(1, 3), rand(1, 3));
        }
        g.fillStyle = 'rgba(105,86,60,.22)';                       // wheel ruts, faint
        g.fillRect(w * .26, 0, w * .07, h);
        g.fillRect(w * .67, 0, w * .07, h);
        g.fillStyle = 'rgba(90,74,52,.14)';                        // soft worn edges
        g.fillRect(0, 0, w * .04, h); g.fillRect(w * .96, 0, w * .04, h);
      }, [1, 1]);
      const SEG = 80, HALF_W = 1.5, len = curve.getLength();
      const pos = new Float32Array((SEG + 1) * 6);
      const nor = new Float32Array((SEG + 1) * 6);
      const uv  = new Float32Array((SEG + 1) * 4);
      const idx = [];
      for (let i = 0; i <= SEG; i++) {
        const t = i / SEG, o6 = i * 6, o4 = i * 4;
        const p = curve.getPointAt(t), tn = curve.getTangentAt(t);
        const nx = -tn.z, nz = tn.x;                     // horizontal normal
        pos[o6]     = p.x + nx * HALF_W; pos[o6 + 1] = .03; pos[o6 + 2] = p.z + nz * HALF_W;
        pos[o6 + 3] = p.x - nx * HALF_W; pos[o6 + 4] = .03; pos[o6 + 5] = p.z - nz * HALF_W;
        nor[o6 + 1] = nor[o6 + 4] = 1;                   // flat strip, normals up
        const v = (t * len) / 3;                         // rut tile every ~3 m
        uv[o4] = 0; uv[o4 + 1] = v; uv[o4 + 2] = 1; uv[o4 + 3] = v;
        if (i < SEG) {
          const a = i * 2;
          /* Winding: (A_i, A_i+1, B_i / B_i, A_i+1, B_i+1) so the strip's
             FRONT side faces UP — the first draft (A_i, B_i, A_i+1) faced
             down and the lit render went near-black: from above you saw
             backfaces whose flipped normal points at the ground (N·L ≈ 0). */
          idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
        }
      }
      const rg = new THREE.BufferGeometry();
      rg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      rg.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      rg.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      rg.setIndex(idx);
      const road = new THREE.Mesh(rg, new THREE.MeshStandardMaterial({
        map: roadTex, roughness: .96, side: THREE.DoubleSide }));
      road.name = 'fod_farm_road';
      scene.add(road);
    }

    /* Prewarm + reveal: same two-pass compile the oracle path ends with. */
    renderer.compile(scene, camera);
    renderer.render(scene, camera);
    Promise.resolve().then(() => {
      renderer.compile(scene, camera);
      renderer.render(scene, camera);
    });
    return;
  }

  /* Oracle keeps the crisp module-default haze — reset here in case a FOD
     build ran earlier in this session and retuned scene.fog. */
  scene.fog.color.set(0xcfe3f5); scene.fog.near = 130; scene.fog.far = 470;

  /* Outfield wall + yellow line */
  const wall = new THREE.Mesh(
    new THREE.CylinderGeometry(FENCE_R, FENCE_R, FENCE_H, 96, 1, true, a0, alen),
    new THREE.MeshStandardMaterial({ color:0x1e5c2e, roughness:.9, side:THREE.DoubleSide }));
  wall.position.y = FENCE_H / 2; wall.receiveShadow = true; scene.add(wall);
  const yline = new THREE.Mesh(
    new THREE.CylinderGeometry(FENCE_R + .02, FENCE_R + .02, .14, 96, 1, true, a0, alen),
    new THREE.MeshStandardMaterial({ color:0xF2C14E, roughness:.6, side:THREE.DoubleSide }));
  yline.position.y = FENCE_H - .07; scene.add(yline);

  function wallPlane(txt, phiDeg) {
    const tex = canvasTex(512, 256, g => {
      g.clearRect(0, 0, 512, 256);
      g.font = "800 190px 'Arial Black',sans-serif"; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = '#F2C14E'; g.fillText(txt, 256, 132);
    });
    const p = new THREE.Mesh(new THREE.PlaneGeometry(5, 2.5), new THREE.MeshBasicMaterial({ map:tex, transparent:true }));
    const phi = phiDeg * DEG, r = FENCE_R - .25;
    p.position.set(Math.sin(phi) * r, 2.15, -Math.cos(phi) * r); p.lookAt(0, 2.15, 0); scene.add(p);
  }
  wallPlane('330', -41); wallPlane('400', 0); wallPlane('330', 41);

  ['GAUNTLET COLA','LINCOLN SLUG CO.','PLAY BALL!','DOGS $3','WEBGL SPORTS','RADIO 88.1'].forEach((t, i) => {
    const tex = canvasTex(512, 96, g => {
      g.fillStyle = i % 2 ? '#101820' : '#7a1010'; g.fillRect(0, 0, 512, 96);
      g.font = "700 50px 'Arial Black',sans-serif"; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = '#f5efe0'; g.fillText(t, 256, 52);
    });
    const p = new THREE.Mesh(new THREE.PlaneGeometry(9, 1.7), new THREE.MeshBasicMaterial({ map:tex }));
    const phi = (-40 + i * 16) * DEG, r = FENCE_R - .22;
    p.position.set(Math.sin(phi) * r, .95, -Math.cos(phi) * r); p.lookAt(0, .95, 0); scene.add(p);
  });

  /* Foul poles */
  [-41, 41].forEach(d => {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(.09, .12, 14, 10),
      new THREE.MeshStandardMaterial({ color:0xF2C14E, emissive:0x554400, roughness:.5 }));
    const phi = d * DEG;
    pole.position.set(Math.sin(phi) * (FENCE_R - .4), FENCE_H + 7, -Math.cos(phi) * (FENCE_R - .4));
    pole.castShadow = true; scene.add(pole);
  });

  /* Light towers */
  [[-58,-72],[58,-72],[-84,-18],[84,-18]].forEach(([x, z]) => {
    const g = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(.5, .7, 26, 10),
      new THREE.MeshStandardMaterial({ color:0x9aa3ad, metalness:.6, roughness:.4 }));
    pole.position.y = 13; pole.castShadow = true; g.add(pole);
    const head = new THREE.Mesh(new THREE.BoxGeometry(7, 3.4, .8),
      new THREE.MeshStandardMaterial({ color:0x333a42, roughness:.6 }));
    head.position.y = 27; g.add(head);
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(6.4, 2.8, .2),
      new THREE.MeshStandardMaterial({ color:0xffffff, emissive:0xfff7dd, emissiveIntensity:.85 }));
    lamp.position.set(0, 27, .45); g.add(lamp);
    g.position.set(x, 0, z); g.lookAt(0, 0, 0); scene.add(g);
  });

  /* Grandstand tiers + instanced crowd */
  /* DoubleSide: every camera sits well inside these shells (tiers at r≈98-111),
     so without it the back faces are culled and the stands vanish entirely,
     leaving the crowd hovering in apparent mid-air. The emissive lift keeps
     the shadow-side interior from reading as a near-black band on broadcast
     cams — concrete still shades with the sun, just never below this floor. */
  const standMat = new THREE.MeshStandardMaterial({
    color:0x51606b, roughness:.95, side:THREE.DoubleSide,
    emissive:0x39434d, emissiveIntensity:.55
  });
  /* Shared tier math — the crowd anchoring below MUST derive from the same
     numbers: each tier is an open frustum whose upper rim sits at
     (TIER_TOP_R(t), TIER_TOP_Y(t)) and whose tread slopes down-and-outward
     at TIER_SLOPE height-units per radial unit. */
  const TIER_TOP_R = t => FENCE_R + 7 + t * 4.2;
  const TIER_TOP_Y = t => 2.45 + t * 2.05;                 // = 1.4 + t*2.05 + 2.1/2
  const TIER_DEPTH = 4.2, TIER_RISE = 2.1;
  const TIER_SLOPE = TIER_RISE / TIER_DEPTH;               // .5 y per radial unit
  for (let t = 0; t < 3; t++) {
    const tier = new THREE.Mesh(
      new THREE.CylinderGeometry(TIER_TOP_R(t), TIER_TOP_R(t) + TIER_DEPTH, TIER_RISE, 64, 1, true, a0 - .06, alen + .12), standMat);
    tier.position.y = 1.4 + t * 2.05; tier.receiveShadow = true; scene.add(tier);
  }

  /* Solid grandstand backing — seals every sight-line through the bowl.
     The tiers alone are open frustum shells, so the wedge between one
     tier's inner rim and the next tier's tread showed sky straight
     through ("see-through levels"). Three pieces close it up, all merged
     into ONE draw call sharing `standMat`:
       risers  — vertical wall at each tier's inner rim, spanning down to
                 the previous tread (row t reads as riser + tread now)
       facade  — rear outer wall; also closes from-behind/aerial views
       caps    — radial end walls at both angular extremes              */
  {
    const th0 = a0 - .06, thL = alen + .12;
    const parts = [];
    /* Each riser runs from the tier BELOW's tread (or the ground) up to its
       own inner rim — full 4.15 m on the upper tiers — so no sight-line can
       slip under its bottom edge into the hollow beneath the tier. */
    for (let t = 0; t < 3; t++) {
      const yBot = Math.max(0, TIER_TOP_Y(t - 1) - TIER_RISE);
      parts.push(new THREE.CylinderGeometry(TIER_TOP_R(t), TIER_TOP_R(t), TIER_TOP_Y(t) - yBot, 64, 1, true, th0, thL)
        .translate(0, (yBot + TIER_TOP_Y(t)) / 2, 0));
    }
    const rOut = TIER_TOP_R(2) + TIER_DEPTH + .3, backH = TIER_TOP_Y(2) + 1.25;
    parts.push(new THREE.CylinderGeometry(rOut, rOut, backH, 64, 1, true, th0, thL)
      .translate(0, backH / 2, 0));
    for (const thE of [th0, th0 + thL])
      parts.push(new THREE.PlaneGeometry(rOut - TIER_TOP_R(0) + 1, backH)
        .rotateY(thE - Math.PI / 2)
        .translate(Math.sin(thE) * (TIER_TOP_R(0) + rOut) / 2, backH / 2, Math.cos(thE) * (TIER_TOP_R(0) + rOut) / 2));
    const backing = new THREE.Mesh(mergeGeoms(parts), standMat);
    backing.receiveShadow = true; scene.add(backing);
  }

  /* Crowd v2 — js/world/Crowd.js: ~3600 two-part instanced fans seated on
     the REAL row lines of every stand this file builds (foot-pivoted bodies
     + merged cap/skull heads sharing one matrix), per-fan skin/shirt
     palettes with LIN-red home clusters behind the plate, GPU bob desync +
     a standing wave sweeping the bowl. Seat anchors derive from VSTAND /
     the same tier formulas, so re-seating follows any future retune. */
  crowdV2 = buildCrowd({ scene });

  /* ---- Inner bowl: backstop, V arms, dugout niches, apex stand -----------
     Closes the park into a full V-shaped bowl. All static, merged or
     instanced, no external assets:
       backstop    — curved chain-link fence (canvas alpha texture) ringing
                     home plate at z ≈ +5.0..+10.1, ~4 m tall, topped by an
                     angled flare hood; parked BEHIND the broadcast cams
                     (bat/windup/intro all sit inside r ≈ 5.3) so they never
                     shoot through chain-link, while running-base/result
                     shots looking back see it frame the plate (alphaTest,
                     casts no shadows). It is also the NOSE of the V: both
                     grandstand arms spring from its corner posts.
       V arms      — two straight stepped grandstand runs converging at the
                     backstop corners and widening down the foul lines into
                     the outfield bowl's end caps; their bases are carved
                     into recessed dugout niches whose cavities hold Game.js
                     bench tables unchanged.
       apex stand  — a short two-tier grandstand wedged behind the plate
                     between the arm heads, same frustum recipe as the
                     outfield bowl, LIN-red accents spent sparingly.
     Crowd continuity: buildCrowd seats fans on the identical VSTAND /
     tier formulas, so the instanced crowd reads the new bowl directly. */

  /* Backstop — curved protective fence BEHIND the broadcast cameras -------
     Chain-link painted on canvas (transparent bg, alphaTest .35) exactly
     like the file's other procedural textures: dark green-charcoal gauge
     wire with a faint galvanising glint, tiled fine so the running-base /
     result shots looking back from the infield read it as a real backstop
     rather than a ladder. The ring is deliberately pushed out PAST the
     cams — bat cam z≈7.6, windup cut z≈5.3 and intro dip z≈2.6 all sit
     INSIDE it, so no chain-link ever hangs between them and the plate.
     The net itself never casts shadows — the shadow depth pass ignores
     alphaTest and would drop a solid slab on the field — the steel frame
     below does the casting. */
  {
    const BSP_R = 9.2, BSP_ARC = 57 * DEG;            // radius / half-angle → net z +5.0..+9.2, hood lip ≈ 10.1
    const PAD_H = .95, NET_TOP = 3.15, HOOD = .9;     // pad, net band, flare (top rail ≈ 4.05 m)
    const paintChain = (g, w, h) => {
      g.clearRect(0, 0, w, h);
      const diag = (col, lw, off) => {
        g.strokeStyle = col; g.lineWidth = lw;
        for (let i = -1; i <= 2; i++) {
          g.beginPath(); g.moveTo(i * 64 + off, -6); g.lineTo(i * 64 + off + h + 12, h + 6); g.stroke();
          g.beginPath(); g.moveTo(i * 64 + off + h + 12, -6); g.lineTo(i * 64 + off, h + 6); g.stroke();
        }
      };
      diag('#3a453d', 5, 0);                          // dark green-charcoal wire
      diag('rgba(215,227,217,.34)', 1.5, 3);          // galvanised glint, offset a touch
    };
    const linkMat = rep => new THREE.MeshStandardMaterial({
      map: canvasTex(128, 128, paintChain, rep), transparent:true, alphaTest:.35,
      side:THREE.DoubleSide, roughness:.95, metalness:.15 });
    const net = new THREE.Mesh(
      new THREE.CylinderGeometry(BSP_R, BSP_R, NET_TOP - PAD_H, 72, 1, true, -BSP_ARC, BSP_ARC * 2), linkMat([36, 5]));
    net.position.y = (PAD_H + NET_TOP) / 2; scene.add(net);
    const hood = new THREE.Mesh(
      new THREE.CylinderGeometry(BSP_R + HOOD, BSP_R, HOOD, 72, 1, true, -BSP_ARC, BSP_ARC * 2), linkMat([40, 2]));
    hood.position.y = NET_TOP + HOOD / 2; scene.add(hood);
    const pad = new THREE.Mesh(
      new THREE.CylinderGeometry(BSP_R + .02, BSP_R + .02, PAD_H, 72, 1, true, -BSP_ARC, BSP_ARC * 2),
      new THREE.MeshStandardMaterial({ color:0x1e5c2e, roughness:.9, side:THREE.DoubleSide }));  // same green as the OF wall
    pad.position.y = PAD_H / 2; pad.receiveShadow = true; scene.add(pad);

    /* Steel: three hoop rails (pad top, net top, hood lip) + seven posts,
       merged into ONE draw call. Torus arcs are born at azimuth 90°, so
       rotateY(-(π/2 + half-angle)) recentres them symmetric about +z. */
    const steel = [], POST_H = PAD_H + NET_TOP + HOOD + .06;
    for (const [r, y] of [[BSP_R, PAD_H], [BSP_R, NET_TOP], [BSP_R + HOOD, POST_H - .06]]) {
      const tg = new THREE.TorusGeometry(r, .045, 6, 80, BSP_ARC * 2);
      tg.rotateX(-Math.PI / 2); tg.rotateY(-Math.PI / 2 - BSP_ARC); tg.translate(0, y, 0);
      steel.push(tg);
    }
    for (let i = -3; i <= 3; i++) {
      const th = i * (BSP_ARC / 3), pb = new THREE.BoxGeometry(.15, POST_H, .15);
      pb.translate(0, POST_H / 2, 0); pb.rotateY(th);
      pb.translate(Math.sin(th) * (BSP_R + .07), 0, Math.cos(th) * (BSP_R + .07));
      steel.push(pb);
    }
    const bspFrame = new THREE.Mesh(mergeGeoms(steel),
      new THREE.MeshStandardMaterial({ color:0x2c3430, roughness:.6, metalness:.35 }));
    bspFrame.castShadow = true; bspFrame.receiveShadow = true; scene.add(bspFrame);
  }

  /* V-bowl grandstand arms + carved-in dugout niches ------------------------
     The stands form a V funnel converging at the backstop and widening
     down both foul lines into the outfield bowl seating ("the stadium is
     way out"). Each arm is ONE straight stepped run whose inner face runs
     from the backstop's corner post P0 to the outfield backing's radial
     end-cap ray at P1; this file AND Crowd.js both derive from VSTAND in
     Constants.js so seats and concrete can never drift apart.
     The box dugouts are GONE — each arm's base is CARVED over u ∈
     [nicheU0, nicheU1]: rows whose prism tops sit at or below nicheH skip
     that span, and an explicit floor / field-side railing / back wall /
     jamb pair / roof closes the recess. The cavity (cross −3.4…+1.7,
     where cross runs along the arm's outward normal from the inner face
     line) contains Game.js's UNTOUCHED bench tables (LIN |x| 14.3–16.6 ·
     z −5.8…−7.6 on both sides; visitors x 17.2–19.0 · z −8.9…−6.7 on the
     1B side) — bench placement code needed zero edits.
     All concrete merges into one draw call on `standMat`; wood benches
     and dirt floors get their own two. */
  {
    const V = VSTAND;
    const armLen = Math.hypot(V.p1x - V.p0x, V.p1z - V.p0z);
    const dX = (V.p1x - V.p0x) / armLen, dZ = (V.p1z - V.p0z) / armLen;
    const vX = -dZ, vZ = dX;                         // unit outward normal (1B-handed)
    const tread = V.width / V.rows;
    const topAt = u => V.top0 + (V.top1 - V.top0) * (u / armLen);
    /* Point on side s (+1 = 1B, −1 = 3B): u along the run, c across it */
    const armPt = (s, u, c) => ({
      x: s * (V.p0x + u * dX + c * vX),
      z: V.p0z + u * dZ + c * vZ
    });

    const parts = [], benches = [], floors = [];
    for (const s of [1, -1]) {
      const yw = Math.atan2(-dZ, s * dX);            // box yaw: local +X = run direction
      for (const [ua, ub, carve] of [
        [0, V.nicheU0], [V.nicheU0, V.nicheU1, true], [V.nicheU1, armLen]
      ]) {
        if (ub <= ua) continue;
        const um = (ua + ub) / 2, topM = topAt(um), rh = (topM - V.yBot) / V.rows;
        const L = (ub - ua) + .18;                   // hairline overlap seals segment joints
        for (let j = 0; j < V.rows; j++) {
          if (carve && V.yBot + (j + 1) * rh <= V.nicheH) continue;   // the dugout opening
          const p = armPt(s, um, (j + .5) * tread);
          parts.push(new THREE.BoxGeometry(L, rh, tread).rotateY(yw)
            .translate(p.x, V.yBot + (j + .5) * rh, p.z));
        }
        {   // skirt under the front row + rear facade down to grade
          const pS = armPt(s, um, tread / 2);
          parts.push(new THREE.BoxGeometry(L, V.yBot, tread).rotateY(yw)
            .translate(pS.x, V.yBot / 2, pS.z));
          const pF = armPt(s, um, V.width + .15);
          parts.push(new THREE.BoxGeometry(L, topM, .3).rotateY(yw)
            .translate(pF.x, topM / 2, pF.z));
        }
      }

      /* Niche shell — dirt floor, field railing, back wall, jambs, roof,
         wood bench against the back wall (top y ≈ .53 matches the old
         box-dugout bench height the bench actors were staged for). */
      const nL = V.nicheU1 - V.nicheU0, uC = (V.nicheU0 + V.nicheU1) / 2,
            cW = V.nicheC1 - V.nicheC0, cC = (V.nicheC0 + V.nicheC1) / 2;
      const pf = armPt(s, uC, cC);
      floors.push(new THREE.PlaneGeometry(nL, cW).rotateX(-Math.PI / 2)
        .translate(pf.x, .02, pf.z));
      const pr = armPt(s, uC, V.nicheC0 + .07);
      parts.push(new THREE.BoxGeometry(nL, V.nicheRail, .14).rotateY(yw)
        .translate(pr.x, V.nicheRail / 2, pr.z));
      const pb = armPt(s, uC, V.nicheC1 - .1);
      parts.push(new THREE.BoxGeometry(nL, V.nicheH, .2).rotateY(yw)
        .translate(pb.x, V.nicheH / 2, pb.z));
      for (const ue of [V.nicheU0, V.nicheU1]) {
        const pj = armPt(s, ue, cC);
        parts.push(new THREE.BoxGeometry(.22, V.nicheH, cW).rotateY(yw)
          .translate(pj.x, V.nicheH / 2, pj.z));
      }
      const po = armPt(s, uC, cC);
      parts.push(new THREE.BoxGeometry(nL + .5, .18, cW + .7).rotateY(yw)
        .translate(po.x, V.nicheH - .09, po.z));
      const pw = armPt(s, uC, V.nicheC1 - .55);
      benches.push(new THREE.BoxGeometry(nL - 1.4, .45, .68).rotateY(yw)
        .translate(pw.x, .3, pw.z));

      /* Head + tail caps seal the run's ends — into the backstop corner
         post and into the outfield backing's radial end-cap wall. */
      for (const uu of [.25, armLen - .25]) {
        const hh = topAt(uu), pc = armPt(s, uu, V.width / 2);
        parts.push(new THREE.BoxGeometry(.5, hh, V.width + .3).rotateY(yw)
          .translate(pc.x, hh / 2, pc.z));
      }
    }
    const vArms = new THREE.Mesh(mergeGeoms(parts), standMat);
    vArms.name = 'stand_v_arms'; vArms.receiveShadow = true; scene.add(vArms);
    const benchMesh = new THREE.Mesh(mergeGeoms(benches),
      new THREE.MeshStandardMaterial({ color:0x7a5230, roughness:.85 }));
    benchMesh.name = 'dugout_benches'; benchMesh.castShadow = true; scene.add(benchMesh);
    const floorMesh = new THREE.Mesh(mergeGeoms(floors), dirtMat);
    floorMesh.name = 'dugout_floors'; floorMesh.receiveShadow = true; scene.add(floorMesh);

    /* Apex stand — the short grandstand wedged behind the plate between
       the two arm heads (θ ±apxTH), same frustum recipe as the outfield
       bowl. Its front rim (r apxR0, just outside the backstop hood lip)
       tucks behind the netting while its angular ends bury inside the
       arm heads' cap boxes, so plate-level broadcast cams (all inside
       r ≈ 7.6) never clip it and result shots looking back see stands. */
    const apxTopR = t => V.apxR0 + t * V.apxDepth;
    const apxTopY = t => 1.2 + t * V.apxRise + V.apxRise / 2;
    const thA = V.apxTH * DEG, lnA = thA * 2, apx = [];
    for (let t = 0; t < V.apxN; t++)
      apx.push(new THREE.CylinderGeometry(apxTopR(t), apxTopR(t) + V.apxDepth, V.apxRise, 48, 1, true, -thA, lnA)
        .translate(0, 1.2 + t * V.apxRise, 0));
    for (let t = 0; t < V.apxN; t++) {                     // risers seal under each rim
      const yB = Math.max(0, apxTopY(t - 1) - V.apxRise);
      apx.push(new THREE.CylinderGeometry(apxTopR(t), apxTopR(t), apxTopY(t) - yB, 48, 1, true, -thA, lnA)
        .translate(0, (yB + apxTopY(t)) / 2, 0));
    }
    const axOut = apxTopR(V.apxN - 1) + V.apxDepth + .3, axBack = apxTopY(V.apxN - 1) + 1.25;
    apx.push(new THREE.CylinderGeometry(axOut, axOut, axBack, 48, 1, true, -thA, lnA)
      .translate(0, axBack / 2, 0));
    for (const e of [-thA, thA])                           // radial end-cap walls
      apx.push(new THREE.PlaneGeometry(axOut - V.apxR0 + 1, axBack)
        .rotateY(e - Math.PI / 2)
        .translate(Math.sin(e) * (V.apxR0 + axOut) / 2, axBack / 2, Math.cos(e) * (V.apxR0 + axOut) / 2));
    const apxStand = new THREE.Mesh(mergeGeoms(apx), standMat);
    apxStand.name = 'stand_apex'; apxStand.receiveShadow = true; scene.add(apxStand);

    /* LIN-red accents on the apex (facade band + front-rim rail), spent as
       sparingly as everywhere else in the park. Brand colour straight
       from Constants — never another red. */
    const reds = [new THREE.CylinderGeometry(axOut + .05, axOut + .05, .3, 48, 1, true, -thA, lnA)
      .translate(0, axBack - .3, 0)];
    const rr = new THREE.TorusGeometry(V.apxR0 + .06, .04, 6, 72, lnA);
    rr.rotateX(-Math.PI / 2); rr.rotateY(-Math.PI / 2 - thA); rr.translate(0, apxTopY(0) + .08, 0);
    reds.push(rr);
    const accent = new THREE.Mesh(mergeGeoms(reds),
      new THREE.MeshStandardMaterial({ color:new THREE.Color(LIN.primary), roughness:.55 }));
    accent.name = 'accents_apex_lin_red'; scene.add(accent);
  }

  buildScoreboard(scene);
  buildCityscape(scene);

  /* ---- Golden Gate approach roads ---------------------------------------
     Skyline.js' bay bridge (centre x 372, deck z ±155, deck top y 26.8)
     otherwise ends mid-water — off the cove reveal it reads as a span with
     nowhere to go. These continuations run the highway off BOTH ends out
     to the bay plane's rim (Skyline water spans z ±490): a 70 m descent
     from deck grade to a shoreline causeway (top y 2.4, base y .2 — grounded
     in the .45 water), then flat to z ±486. Every lens in the engine sits
     ≥ ~490 m from those tips — past scene.fog.far (470) — so at ANY zoom
     level the strips always terminate inside the haze band: the road reads
     as running on to the horizon forever. One tiny dashed-asphalt canvas
     (two repeat variants) + fog-on Lambert keeps this at two draw calls;
     geometry stays outside the shadow ortho (±130) and far beyond ball
     range, and physics never raycasts scenery. Coordinates mirror
     Skyline.js' bridge block — move both together if the bridge moves. */
  {
    const RX = 372, RW = 8;                       // bridge centreline / deck width (Skyline.js BX)
    const Y_DECK = 26.8, Y_SHORE = 2.4, THICK = 2.2;
    const RAMP_RUN = 70, Z_END = 486;             // bay rim ±490 — stop short of the seam
    const asphalt = repY => canvasTex(64, 256, (g, w, h) => {
      g.fillStyle = '#3a3e44'; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 900; i++) {             // aggregate speckle
        const v = rint(-10, 10);
        g.fillStyle = `rgba(${58+v},${62+v},${68+v},${rand(.15,.5)})`;
        g.fillRect(rand(0, w), rand(0, h), rand(1, 2.6), rand(1, 2.6));
      }
      g.fillStyle = '#d6d2bd';                    // centre dash ≈ 5 m paint / 7 m gap
      g.fillRect(w / 2 - 2, 0, 4, h * .42);
    }, [1, repY]);
    const drop = Y_DECK - Y_SHORE, th = Math.atan2(drop, RAMP_RUN),
          len = Math.hypot(RAMP_RUN, drop);     // 74.13 m slab at ~19°
    const rampMat = new THREE.MeshLambertMaterial({ map: asphalt(Math.round(len / 12)) });
    const flatMat = new THREE.MeshLambertMaterial({ map: asphalt(Math.round((Z_END - 155 - RAMP_RUN) / 12)) });
    const roads = new THREE.Group(); roads.name = 'gg_roads';
    for (const s of [-1, 1]) {
      /* Descent: top surface flush with the deck lip and running exactly
         lip (z s·155, y 26.8) → shore grade (z s·225, y 2.4). rotateX(s·th)
         drops the outward end; the position solve puts the slab's top-face
         midline on that lip→shore segment (the ±.3 terms undo the rotated
         half-thickness offset). */
      const ramp = new THREE.Mesh(new THREE.BoxGeometry(RW, .6, len), rampMat);
      ramp.rotation.x = s * th;
      ramp.name = 'gg_road_ramp_' + (s > 0 ? 'p' : 'm');
      ramp.position.set(RX,
        (Y_DECK + Y_SHORE) / 2 - .3 * Math.cos(th),
        s * (155 + RAMP_RUN / 2) - s * .3 * Math.sin(th));
      /* Shore-grade causeway out to the bay rim — bottom sinks .25 into
         the water so it reads as grounded embankment, not a floating plank. */
      const flatLen = Z_END - (155 + RAMP_RUN);
      const flat = new THREE.Mesh(new THREE.BoxGeometry(RW, THICK, flatLen), flatMat);
      flat.name = 'gg_road_span_' + (s > 0 ? 'p' : 'm');
      flat.position.set(RX, Y_SHORE - THICK / 2, s * (155 + RAMP_RUN + flatLen / 2));
      roads.add(ramp, flat);
    }
    /* Owner ask: land on BOTH sides of the causeway so the road never reads
       as a lone strip on open water. Grassy earth berms flank the flat
       shore-grade run — tucked under the descent's low end (the ramp there
       is still ≥ 2.2 m overhead, so nothing intersects) out to the bay rim.
       Tops sit .35 under the asphalt like a packed shoulder; bottoms sink
       .65 below the surface, well under the .45 waterline, so they ground
       as filled embankment. One symmetric texture (gravel edging on both u
       edges) + fog-on Lambert keeps all four berms at a single draw-call
       material; like the roads they stay outside the shadow ortho, beyond
       ball range, and physics never raycasts scenery. */
    const bermTex = repY => canvasTex(128, 256, (g, w, h) => {
      g.fillStyle = '#68713f'; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 700; i++) {
        g.fillStyle = rand(0, 1) < .5 ? 'rgba(84,92,52,.55)' : 'rgba(124,118,76,.45)';
        g.fillRect(rand(0, w), rand(0, h), rand(2, 7), rand(1, 4));
      }
      g.fillStyle = '#5c5340';                    // gravel shoulder, both road-facing edges
      g.fillRect(0, 0, 10, h);
      g.fillRect(w - 10, 0, 10, h);
    }, [1, repY]);
    const bermMat = new THREE.MeshLambertMaterial({ map: bermTex(Math.round((Z_END - 218) / 12)) });
    const LW = 16, BT = 2.7, Y_TOP = Y_SHORE - .35;
    const bermLen = Z_END - 218;
    for (const s of [-1, 1]) for (const sd of [-1, 1]) {
      const berm = new THREE.Mesh(new THREE.BoxGeometry(LW, BT, bermLen), bermMat);
      berm.name = `gg_land_${s > 0 ? 'p' : 'm'}${sd > 0 ? 'e' : 'w'}`;
      berm.position.set(RX + sd * (RW / 2 + LW / 2), Y_TOP - BT / 2, s * (218 + bermLen / 2));
      roads.add(berm);
    }
    scene.add(roads);
  }

  /* Prewarm — runs while the opaque #boot overlay is still up (main.js only
     reveals the scene after its async FBX load resolves). Compiles every
     world program (stands, crowd, sky shader, city) and uploads their
     textures/buffers; the microtask pass drains after main.js's synchronous
     body has added the actors, still ahead of the first revealed frame. */
  renderer.compile(scene, camera);
  renderer.render(scene, camera);
  Promise.resolve().then(() => {
    renderer.compile(scene, camera);
    renderer.render(scene, camera);
  });
}

/* ---- Crowd idle animation — call from the main tick ----------------------
   The bob lives in the crowd material's vertex shader (see buildStadium):
   a ±.035 sine per fan with phase rippling around the bowl. This only
   advances the shared time uniform — no per-frame allocations, no CPU
   matrix rewrites, no instance-buffer uploads. -------------------------- */
export function updateCrowd(t) {
  if (crowdV2) crowdV2.update(t);
}

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
});

/* Boot prewarm now lives at the end of buildStadium() — the stadium (and
   therefore the compiled programs) exist only after the load-screen park
   choice, so the old module-eval-time passes would have compiled an empty
   scene. */
