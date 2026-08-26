/* =====================================================================
   Skyline.js — city backdrop for Gauntlet Park: a layered downtown
   beyond the stands — landmark towers with varied massing (slabs,
   setback tiers, cylinders, crown roofs) and a belt of mid-rise blocks —
   plus the bay on the +x (right-field) side with a hazy suspension
   bridge on the horizon. Static scenery, built
   once at boot; everything is merged (one draw call per material) and
   dressed by ONE shared facade atlas whose UVs are quantized to whole
   windows per face, so a single texture tiles every building cleanly.
   Part of the Lincoln Red Gauntlet engine · js/world/
===================================================================== */
import * as THREE from 'three';
import { TAU, rand, rint, pick, clamp, canvasTex } from '../utils/MathUtils.js';

/* ---- Tiny geometry merger ----------------------------------------------
   Concatenates simple indexed BufferGeometries (position/normal/uv plus
   an OPTIONAL color attribute — inputs without one contribute white)
   into one geometry so N primitives can share a single draw call without
   vendoring BufferGeometryUtils. Transform each part BEFORE merging via
   the chainable rotateY / translate helpers. -------------------------- */
export function mergeGeoms(list) {
  let vTotal = 0, iTotal = 0, hasColor = false;
  for (const g of list) {
    vTotal += g.attributes.position.count;
    iTotal += g.index ? g.index.count : g.attributes.position.count;
    if (g.attributes.color) hasColor = true;
  }
  const pos = new Float32Array(vTotal * 3), nor = new Float32Array(vTotal * 3),
        uv = new Float32Array(vTotal * 2), idx = new Uint32Array(iTotal),
        col = hasColor ? new Float32Array(vTotal * 3) : null;
  let vOff = 0, iOff = 0;
  for (const g of list) {
    const p = g.attributes.position, n = g.attributes.normal, u = g.attributes.uv,
          c = g.attributes.color;
    pos.set(p.array, vOff * 3); nor.set(n.array, vOff * 3); uv.set(u.array, vOff * 2);
    if (col) for (let i = 0; i < p.count; i++) {
      const j = (vOff + i) * 3;
      col[j] = c ? c.getX(i) : 1; col[j + 1] = c ? c.getY(i) : 1; col[j + 2] = c ? c.getZ(i) : 1;
    }
    const gi = g.index, cnt = gi ? gi.count : p.count;
    for (let i = 0; i < cnt; i++) idx[iOff + i] = (gi ? gi.getX(i) : i) + vOff;
    iOff += cnt; vOff += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (col) out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

/* ---- Facade atlas --------------------------------------------------------
   ONE 1024x1024 canvas, 8x8 cells of 128px. Cells 0-11 are seamless
   window-grid tiles (glass curtain walls, punched stone, ribbon bands,
   vertical strips — each with random lit/dark/blind cells), cells 12-15
   are flat finishes (light concrete, mid, dark, roof gravel). Building
   UVs are quantized to WHOLE windows — one world unit = UNIT_W x UNIT_H
   (one column x one floor) — and wrapped inside their cell, so every
   face shows complete floors no matter its size and the single atlas
   dresses the entire city. -------------------------------------------- */
const ATLAS_S = 1024, CELL_N = 8, CELL_PX = ATLAS_S / CELL_N;
const UNIT_W = 3.1, UNIT_H = 3.6;               // metres per window column / floor
const EPS = 1.5 / ATLAS_S;                      // half-texel inset against cell bleed

const GLASS_BLUE   = ['#dfe9f2', '#8fa6b8', '#46586a', '#b9c9d6'];
const GLASS_GREEN  = ['#e2eee6', '#84a396', '#3d564d', '#bcd6c8'];
const GLASS_DARK   = ['#c8d4de', '#71828f', '#2e3a44', '#9fb0bc'];
const GLASS_BRONZE = ['#efe6d4', '#ab9a80', '#4c4034', '#cabfa8'];
const PUNCH_LIGHT  = ['#eef2f4', '#9fb2bd', '#37414a', '#c4d2da'];
const PUNCH_BRICK  = ['#f0e8dc', '#a08874', '#42332a', '#cbb49e'];
const PUNCH_DENSE  = ['#e9ecee', '#94a4ae', '#333d45', '#b9c6ce'];
const PUNCH_SLATE  = ['#e6ebef', '#8b9ba6', '#2f3a43', '#b3c1ca'];
const BAND_COOL    = ['#e8eef2', '#93a8b5', '#3c4a54', '#bcccd6'];
const BAND_WARM    = ['#f1ede2', '#a89a86', '#4a4038', '#cec2ae'];

function drawWin(g, x, y, w, h, tones) {        // one window: sky-lit / mid / dark, some blinds
  const r = Math.random();
  g.fillStyle = r < .16 ? tones[0] : r < .4 ? tones[1] : tones[2];
  g.fillRect(x, y, w, h);
  if (r >= .4 && Math.random() < .3) { g.fillStyle = tones[3]; g.fillRect(x, y, w, h * rand(.3, .55)); }
}
function paintGlass(g, x, y, s, nx, ny, wall, tones) {
  g.fillStyle = wall; g.fillRect(x, y, s, s);
  const cw = s / nx, ch = s / ny, m = Math.max(1.5, s * .014);
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++)
    drawWin(g, x + i * cw + m, y + j * ch + m * .6, cw - 2 * m, ch - m * 1.5, tones);
  g.strokeStyle = 'rgba(18,24,30,.4)'; g.lineWidth = 1;   // mullions
  for (let i = 0; i <= nx; i++) { g.beginPath(); g.moveTo(x + i * cw + .5, y); g.lineTo(x + i * cw + .5, y + s); g.stroke(); }
}
function paintPunch(g, x, y, s, nx, ny, wall, tones) {
  g.fillStyle = wall; g.fillRect(x, y, s, s);
  for (let k = 0; k < 12; k++) {                          // weathering streaks
    g.fillStyle = `rgba(30,25,20,${rand(.02, .05).toFixed(3)})`;
    g.fillRect(x + rand(0, s - 12), y, rand(4, 12), s);
  }
  const cw = s / nx, ch = s / ny, ww = cw * .52, wh = ch * .48;
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    const wx = x + i * cw + (cw - ww) / 2, wy = y + j * ch + ch * .3;
    drawWin(g, wx, wy, ww, wh, tones);
    g.fillStyle = 'rgba(255,255,255,.3)'; g.fillRect(wx - 2, wy + wh + 1.5, ww + 4, 2);   // sill
  }
}
function paintBand(g, x, y, s, nx, ny, wall, tones) {     // ribbon windows + spandrels
  g.fillStyle = wall; g.fillRect(x, y, s, s);
  const ch = s / ny, bh = ch * .5;
  for (let j = 0; j < ny; j++) {
    drawWin(g, x + 2, y + j * ch + ch * .32, s - 4, bh, tones);
    g.fillStyle = 'rgba(25,30,35,.4)';
    for (let i = 1; i < nx; i++) g.fillRect(x + i * (s / nx) - 1, y + j * ch + ch * .32, 2, bh);
  }
}
function paintStrip(g, x, y, s, nx, ny, wall, tones) {    // vertical glass strips
  g.fillStyle = wall; g.fillRect(x, y, s, s);
  const cw = s / nx, sw = cw * .44;
  for (let i = 0; i < nx; i++) drawWin(g, x + i * cw + (cw - sw) / 2, y + 2, sw, s - 4, tones);
}
function paintFlat(g, x, y, s, hex) {
  g.fillStyle = hex; g.fillRect(x, y, s, s);
  for (let k = 0; k < 30; k++) {
    g.fillStyle = `rgba(${Math.random() < .5 ? '255,255,255' : '20,24,28'},${rand(.02, .05).toFixed(3)})`;
    g.fillRect(x + rand(0, s), y + rand(0, s), rand(3, 16), rand(3, 16));
  }
}

const VARIANTS = [
  { fn: paintGlass,  nx: 3, ny: 3, wall: '#aeb6bf', tones: GLASS_BLUE },
  { fn: paintGlass,  nx: 3, ny: 4, wall: '#9fb3ac', tones: GLASS_GREEN },
  { fn: paintGlass,  nx: 4, ny: 4, wall: '#5f6771', tones: GLASS_DARK },
  { fn: paintPunch,  nx: 4, ny: 4, wall: '#cfc6b2', tones: PUNCH_LIGHT },
  { fn: paintPunch,  nx: 3, ny: 4, wall: '#b3866a', tones: PUNCH_BRICK },
  { fn: paintBand,   nx: 3, ny: 3, wall: '#caccc6', tones: BAND_COOL },
  { fn: paintStrip,  nx: 3, ny: 3, wall: '#b4bcc3', tones: GLASS_BLUE },
  { fn: paintPunch,  nx: 5, ny: 5, wall: '#bab7ae', tones: PUNCH_DENSE },
  { fn: paintGlass,  nx: 3, ny: 3, wall: '#a9b8a4', tones: GLASS_GREEN },
  { fn: paintBand,   nx: 2, ny: 3, wall: '#d9cfbd', tones: BAND_WARM },
  { fn: paintGlass,  nx: 3, ny: 3, wall: '#b3a58f', tones: GLASS_BRONZE },
  { fn: paintPunch,  nx: 4, ny: 3, wall: '#9aa4ab', tones: PUNCH_SLATE },
];
const PLAINS = ['#d3d2cb', '#9aa0a4', '#5a6167', '#8b857a'];   // light/mid/dark/roof gravel

function cellRect(i) {                                          // normalized rect, v upward
  const cx = i % CELL_N, cy = Math.floor(i / CELL_N);
  return { u0: cx / CELL_N, v0: 1 - (cy + 1) / CELL_N, uw: 1 / CELL_N, vh: 1 / CELL_N };
}
function buildFacadeAtlas() {
  const cells = [];
  const tex = canvasTex(ATLAS_S, ATLAS_S, (g, w, h) => {
    paintFlat(g, 0, 0, w, '#8e9499');                           // neutral backstop under mip bleed
    VARIANTS.forEach((v, i) => {
      const x = (i % CELL_N) * CELL_PX, y = Math.floor(i / CELL_N) * CELL_PX;
      v.fn(g, x, y, CELL_PX, v.nx, v.ny, v.wall, v.tones);
    });
    PLAINS.forEach((hex, k) => {
      const id = 12 + k, x = (id % CELL_N) * CELL_PX, y = Math.floor(id / CELL_N) * CELL_PX;
      paintFlat(g, x, y, CELL_PX, hex);
    });
    VARIANTS.forEach((v, i) => cells.push({ ...cellRect(i), nx: v.nx, ny: v.ny }));
  });
  const P = i => ({ ...cellRect(i) });
  return { tex, cells, plains: { light: P(12), mid: P(13), dark: P(14), roof: P(15) } };
}

/* ---- City + bay builder -------------------------------------------------
   Azimuth convention matches the stadium code: a point at angle `az` sits
   at (sin(az)·r, y, cos(az)·r), so az = π/2 is the +x / right-field side
   where the bay opens up. Two depth rings — near landmark core and mid
   belt — give the skyline parallax from the broadcast cameras;
   SceneManager's fog (130→470) grades the layers for free. The former
   third ring of muted horizon masses (the "distant mountains" backdrop,
   r 285–420) was removed outright at the owner's request — no stub kept:
   fog over open ground grades into the sky dome's haze band instead.
   ------------------------------------------------------------------ */
export function buildCityscape(scene) {
  const atlas = buildFacadeAtlas();
  const { cells, plains } = atlas;
  const facGeos = [], detGeos = [], beaconCands = [];
  const TC = new THREE.Color();

  const TINTS = ['#e8e6e0', '#dcd9d0', '#d5d9dd', '#cdd4d8', '#e0d6c4', '#ccd3d7', '#ddd5c5', '#c8ced2'];
  const TALL_CELLS = [0, 1, 2, 5, 6, 8, 10], MID_CELLS = [3, 4, 5, 7, 9, 11, 6, 0];

  /* per-vertex tint (multiplied over the atlas) — breaks up the gray */
  function paintVerts(g, hex, dl) {
    const n = g.attributes.position.count, a = new Float32Array(n * 3);
    TC.set(hex).offsetHSL(rand(-.015, .015), rand(-.03, .03), dl !== undefined ? dl : rand(-.045, .03));
    for (let i = 0; i < n; i++) { a[i * 3] = TC.r; a[i * 3 + 1] = TC.g; a[i * 3 + 2] = TC.b; }
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  }
  /* whole-window UVs for a box: per-face tile counts rounded to full
     windows, wrapped inside the atlas cell with a random phase; roof and
     underside faces sample a flat plain cell instead. */
  function facadeUVBox(g, w, h, d, cell, phX, phY, roof) {
    const uv = g.attributes.uv, dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
    for (let f = 0; f < 6; f++) {
      const flat = f === 2 || f === 3, [fw, fh] = dims[f];
      for (let v = 0; v < 4; v++) {
        const i = f * 4 + v, u = uv.getX(i), t = uv.getY(i);
        if (flat) { uv.setXY(i, roof.u0 + (u * .5 + .25) * roof.uw, roof.v0 + (t * .5 + .25) * roof.vh); continue; }
        const tu = Math.max(1, Math.round(fw / UNIT_W)), tv = Math.max(1, Math.round(fh / UNIT_H));
        const cu = ((Math.round(u * tu) + phX) % cell.nx + cell.nx) % cell.nx;
        const cv = ((Math.round(t * tv) + phY) % cell.ny + cell.ny) % cell.ny;
        uv.setXY(i,
          clamp(cell.u0 + cu / cell.nx * cell.uw, cell.u0 + EPS, cell.u0 + cell.uw - EPS),
          clamp(cell.v0 + cv / cell.ny * cell.vh, cell.v0 + EPS, cell.v0 + cell.vh - EPS));
      }
    }
  }
  /* same for cylinder sides (segment counts chosen = window counts, so
     vertices land on window boundaries); caps go to the plain cell. */
  function facadeUVCyl(g, seg, hs, cell, roof) {
    const uv = g.attributes.uv, side = (seg + 1) * (hs + 1);
    const phX = rint(0, cell.nx - 1), phY = rint(0, cell.ny - 1);
    for (let i = 0; i < uv.count; i++) {
      if (i >= side) { uv.setXY(i, roof.u0 + roof.uw * .5, roof.v0 + roof.vh * .5); continue; }
      const cu = ((Math.round(uv.getX(i) * seg) + phX) % cell.nx + cell.nx) % cell.nx;
      const cv = ((Math.round(uv.getY(i) * hs) + phY) % cell.ny + cell.ny) % cell.ny;
      uv.setXY(i,
        clamp(cell.u0 + cu / cell.nx * cell.uw, cell.u0 + EPS, cell.u0 + cell.uw - EPS),
        clamp(cell.v0 + cv / cell.ny * cell.vh, cell.v0 + EPS, cell.v0 + cell.vh - EPS));
    }
  }
  function plainUV(g, cell) {                   // whole primitive samples one flat cell
    const uv = g.attributes.uv, u = cell.u0 + cell.uw * .5, v = cell.v0 + cell.vh * .5;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, u, v);
  }
  function facadeBox(w, h, d, ry, x, y, z, cell, phX, phY, roof, tint) {
    const g = new THREE.BoxGeometry(w, h, d);
    facadeUVBox(g, w, h, d, cell, phX, phY, roof);
    paintVerts(g, tint);
    g.translate(0, h / 2, 0).rotateY(ry).translate(x, y, z);   // pivot at the base
    return g;
  }

  /* Tower with 1-3 setback tiers; window phase continues up the stack so
     floors read as uninterrupted. Occasional pyramid crown. */
  function towerBlock(x, z, ry, w, d, h, ci) {
    const cell = cells[ci], tint = pick(TINTS);
    const roof = pick([plains.roof, plains.mid, plains.dark]);
    let phX = rint(0, cell.nx - 1), phY = rint(0, cell.ny - 1), y = 0, cw = w, cd = d, left = h;
    const tiers = h > 62 && Math.random() < .55 ? rint(2, 3) : 1;
    for (let t = 0; t < tiers && left > 5; t++) {
      const th = t === tiers - 1 ? left : Math.max(UNIT_H * rint(4, 9), left * rand(.38, .58));
      facGeos.push(facadeBox(cw, th, cd, ry, x, y, z, cell, phX, phY, roof, tint));
      phY = (phY + Math.max(1, Math.round(th / UNIT_H))) % cell.ny;
      y += th; left -= th;
      cw *= rand(.58, .8); cd *= rand(.58, .8);
    }
    if (Math.random() < .38) {                                  // pyramid / mansard cap
      const hh = rand(3.5, 8), ph = Math.max(2.2, Math.min(cw, cd) * rand(.42, .55));
      const cg = new THREE.ConeGeometry(ph, hh, 4, 1);
      cg.rotateY(Math.PI / 4);
      plainUV(cg, plains.dark); paintVerts(cg, pick(['#b6afa1', '#a5abb1', '#8e969d']));
      cg.rotateY(ry); cg.translate(x, y + hh / 2, z);
      facGeos.push(cg); y += hh;
    }
    roofClutter(x, z, ry, w, d, y, h >= 82);
  }
  /* Cylindrical tower — segment counts equal window counts for clean UVs */
  function cylTower(x, z, h, ci) {
    const r = rand(6.5, 9.5), cell = cells[ci];
    const tu = Math.max(8, Math.round(TAU * r / UNIT_W)), tv = Math.max(4, Math.round(h / UNIT_H));
    const g = new THREE.CylinderGeometry(r, r, h, tu, tv);
    facadeUVCyl(g, tu, tv, cell, plains.roof);
    paintVerts(g, pick(TINTS));
    g.translate(0, h / 2, 0).translate(x, 0, z);
    facGeos.push(g);
    const dr = r * rand(.4, .55), dh = rand(2.5, 5);            // crown drum
    const drum = new THREE.CylinderGeometry(dr, dr, dh, 10);
    paintVerts(drum, pick(['#b3b0a7', '#a6a8ac']));
    drum.translate(0, h + dh / 2, 0).translate(x, 0, z);
    detGeos.push(drum);
    if (Math.random() < .5) {
      const mh = rand(4, 10), mg = new THREE.BoxGeometry(.5, mh, .5);
      paintVerts(mg, '#4c5157');
      mg.translate(0, h + dh + mh / 2, 0).translate(x, 0, z);
      detGeos.push(mg);
      if (h > 80) beaconCands.push({ x, y: h + dh + mh + .5, z });
    } else if (h > 80) beaconCands.push({ x, y: h + dh + .5, z });
  }
  /* Rooftop dressing: mechanical penthouse, water tank, antenna mast */
  function roofClutter(x, z, ry, w, d, topY, tall) {
    if (Math.random() < .72) {
      const pw = w * rand(.2, .38), pd = d * rand(.2, .38), ph = rand(2.2, 4.6);
      const g = new THREE.BoxGeometry(pw, ph, pd);
      paintVerts(g, pick(['#b3b0a7', '#a6a8ac', '#9aa0a6']));
      g.translate(rand(-.1, .1) * w, ph / 2, rand(-.1, .1) * d).rotateY(ry).translate(x, topY, z);
      detGeos.push(g);
    }
    if (Math.random() < .3) {
      const r = rand(1.1, 1.7), th = rand(2.2, 3.2), ox = rand(-.2, .2) * w, oz = rand(-.2, .2) * d;
      const body = new THREE.CylinderGeometry(r, r, th, 8);
      paintVerts(body, '#8a5a40');
      body.translate(ox, th / 2, oz).rotateY(ry).translate(x, topY, z);
      detGeos.push(body);
      const cap = new THREE.ConeGeometry(r + .3, 1.3, 8);
      paintVerts(cap, '#6f4632');
      cap.translate(ox, th + .65, oz).rotateY(ry).translate(x, topY, z);
      detGeos.push(cap);
    }
    if (Math.random() < .5) {
      const mh = tall ? rand(8, 16) : rand(3.5, 8);
      const g = new THREE.BoxGeometry(.5, mh, .5);
      paintVerts(g, '#4c5157');
      g.translate(rand(-.3, .3) * w, mh / 2, rand(-.3, .3) * d).rotateY(ry).translate(x, topY, z);
      detGeos.push(g);
      beaconCands.push({ x, y: topY + mh + .5, z });
    }
  }
  /* Ring-slot placement: jittered azimuths with a minimum gap so towers
     never overlap; the bay sector (±half rad around +x) stays open. */
  const placed = [];
  function slot(rMin, rMax, gap, half, xMax) {
    for (let tries = 0; tries < 900; tries++) {
      const az = rand(0, TAU);
      const daz = Math.atan2(Math.sin(az - Math.PI / 2), Math.cos(az - Math.PI / 2));
      if (Math.abs(daz) < half) continue;                       // keep the waterfront open
      const r = rand(rMin, rMax), x = Math.sin(az) * r, z = Math.cos(az) * r;
      if (x > xMax) continue;                                   // never plant a tower in the bay
      let ok = true;
      for (const p of placed) {
        const da = Math.abs(Math.atan2(Math.sin(p.az - az), Math.cos(p.az - az)));
        if (da * Math.min(p.r, r) < gap) { ok = false; break; }
      }
      if (!ok) continue;
      placed.push({ az, r });
      return { x, z };
    }
    return null;
  }
  const gridYaw = () => Math.random() < .7 ? pick([0, Math.PI / 2]) + rand(-.08, .08) : rand(0, TAU);

  /* NEAR — landmark core: tallest, most-detailed massing. Heights stay
     well under the ring distance so towers read as a downtown beyond the
     stands, not a wall crowding them; slender spires break the roofline. */
  for (let i = 0; i < 18; i++) {
    const s = slot(152, 205, 34, .98, 104); if (!s) break;
    const roll = Math.random();
    let h, w, d;
    if (roll < .08) { h = rand(92, 112); w = rand(10, 14); d = rand(10, 14); }       // slender spire
    else if (roll < .24) { h = rand(68, 96); w = rand(14, 22); d = rand(14, 22); }   // landmark
    else if (roll < .55) { h = rand(42, 68); w = rand(13, 22); d = rand(13, 22); }
    else { h = rand(26, 46); w = rand(13, 24); d = rand(13, 24); }
    if (Math.random() < .15) cylTower(s.x, s.z, h, pick([0, 1, 2, 8]));
    else if (roll >= .24 && roll < .4) towerBlock(s.x, s.z, gridYaw(), rand(20, 28), rand(9, 13), h, pick(TALL_CELLS));
    else towerBlock(s.x, s.z, gridYaw(), w, d, h, pick(TALL_CELLS));
  }
  placed.length = 0;
  /* MID — mid-rise belt */
  for (let i = 0; i < 24; i++) {
    const s = slot(206, 264, 30, .92, 104); if (!s) break;
    const h = Math.random() < .12 ? rand(40, 56) : rand(15, 38);
    if (Math.random() < .1) cylTower(s.x, s.z, h, pick([3, 5, 11]));
    else towerBlock(s.x, s.z, gridYaw(), rand(12, 26), rand(12, 26), h, pick(MID_CELLS));
  }

  /* Merged meshes — one draw call per material */
  const city = new THREE.Mesh(mergeGeoms(facGeos),
    new THREE.MeshLambertMaterial({ map: atlas.tex, vertexColors: true }));
  city.name = 'city_buildings'; scene.add(city);
  const roofs = new THREE.Mesh(mergeGeoms(detGeos),
    new THREE.MeshLambertMaterial({ vertexColors: true }));
  roofs.name = 'city_rooftops'; scene.add(roofs);

  /* Red aircraft-warning lights on the five tallest masts (static — the
     engine has no per-object uniform hook, so no blink). */
  if (beaconCands.length) {
    const bg = [];
    beaconCands.sort((a, b) => b.y - a.y).slice(0, 5).forEach(b => {
      const s = new THREE.SphereGeometry(.5, 6, 4); s.translate(b.x, b.y, b.z); bg.push(s);
    });
    const beacons = new THREE.Mesh(mergeGeoms(bg), new THREE.MeshBasicMaterial({ color: 0xff2d1e }));
    beacons.name = 'city_beacons'; scene.add(beacons);
  }

  /* The bay — flat plane beyond the right-field stands (x > 114, well
     clear of the bowl whose outer wall tops out at r≈111). Unlit with a
     baked shore-to-horizon gradient standing in for atmospheric haze
     (fog:false keeps it from being washed out at 400+ m). */
  const waterTex = canvasTex(256, 32, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, w, 0);
    gr.addColorStop(0, '#49799f'); gr.addColorStop(.42, '#6f9cbd');
    gr.addColorStop(.75, '#a9c4da'); gr.addColorStop(1, '#d8e5ef');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
  });
  const water = new THREE.Mesh(new THREE.PlaneGeometry(560, 980),
    new THREE.MeshBasicMaterial({ map: waterTex, fog: false }));
  water.rotation.x = -Math.PI / 2;
  water.position.set(394, .45, 0);                // spans x 114-674, z -490..490
  water.name = 'bay_water'; scene.add(water);

  /* Bridge silhouette on the horizon — suspension type, muted
     international-orange baked toward the haze color. All boxes merged
     into ONE mesh (fog:false + pre-faded tone = reads as distance). */
  const bp = [];
  const box = (w, h, d, x, y, z, rx = 0) => {
    const b = new THREE.BoxGeometry(w, h, d);
    if (rx) b.rotateX(rx);
    b.translate(x, y, z); bp.push(b);
  };
  const BX = 372;                                 // bridge centre distance
  box(8, 1.6, 310, BX, 26, 0);                    // deck
  for (const zs of [-1, 1]) {                     // towers (legs + crossbeams)
    const z = zs * 78;
    box(3.2, 64, 3.2, BX - 5.4, 32, z);
    box(3.2, 64, 3.2, BX + 5.4, 32, z);
    box(14, 2.6, 3, BX, 52, z);
    box(14, 2.6, 3, BX, 62.5, z);
  }
  box(10, 19, 8, BX, 9.5, -162);                  // anchor piers
  box(10, 19, 8, BX, 9.5, 162);
  const wp = [[-162, 19], [-78, 62], [-40, 45], [0, 38], [40, 45], [78, 62], [162, 19]];
  for (let i = 0; i < wp.length - 1; i++) {       // main cable, chained segments
    const [za, ya] = wp[i], [zb, yb] = wp[i + 1];
    box(.7, .7, Math.hypot(zb - za, yb - ya), BX, (ya + yb) / 2, (za + zb) / 2,
      -Math.atan2(yb - ya, zb - za));
  }
  const bridge = new THREE.Mesh(mergeGeoms(bp),
    new THREE.MeshLambertMaterial({ color: 0xa87e63, fog: false }));
  bridge.name = 'bridge'; scene.add(bridge);

  /* A few hulls dotting the cove — merged, one draw call. */
  const bh = [];
  [[152, -.62, -44], [186, .4, 26], [214, -.2, -6]].forEach(([bx, ry, bz]) => {
    const b = new THREE.BoxGeometry(rand(2.6, 3.6), 1.3, rand(6, 9));
    b.rotateY(ry); b.translate(bx, .68, bz); bh.push(b);
  });
  const boats = new THREE.Mesh(mergeGeoms(bh), new THREE.MeshLambertMaterial({ color: 0xe9e6dc }));
  boats.name = 'boats'; scene.add(boats);
}
