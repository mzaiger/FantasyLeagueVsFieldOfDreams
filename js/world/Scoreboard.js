/* =====================================================================
   Scoreboard.js — Gauntlet Park center-field video board. A real
   videoboard build: dark bezel + LED cabinet in a tilted head, steel
   support truss on concrete pads, and ONE canvas texture (2048x1024)
   repainted only when game state changes, finished with a baked LED
   dressing (RGB subpixel grid, cabinet seams, scanlines, vignette,
   glass sheen) so it reads as a lit screen, not a poster.
   Screen layout: park wordmark, team colour-chip headers with giant
   condensed score digits, inning/TOP-BOT indicator, base diamond,
   B-S-O count pips, and a live line-score ribbon along the bottom
   (per-inning runs accumulated from the bound game state — no new
   fields required of GameState).
   Contract (drop-in mirror of the hooks that lived in SceneManager):
     setScoreboardDrawer(fn)      register the draw closure
     drawScoreboard()             invoke it (HUD calls on every refresh)
     bindScoreboardState(getter)  bind () => G (main.js calls once)
     buildScoreboard(scene)       build meshes + register drawer;
                                  returns { group, head, face, steel,
                                            canvas, texture, setScore,
                                            draw, bindState, resetLines }
   Imports stay in-band (Constants, RosterManager, Skyline helper), so
   the SceneManager -> Scoreboard edge keeps the module graph acyclic.
   Part of the Lincoln Red Gauntlet engine · js/world/
===================================================================== */
import * as THREE from 'three';
import { LIN, STADIUM } from '../core/Constants.js';
import { OPP } from '../entities/RosterManager.js';
import { mergeGeoms } from './Skyline.js';

/* ---- Draw-hook plumbing — signatures EXACTLY as they were ------------ */
let SB_DRAW = null;
let sbStateRef = () => null;
export const setScoreboardDrawer = fn => { SB_DRAW = fn; };
export const drawScoreboard = () => { if (SB_DRAW) SB_DRAW(); };
export const bindScoreboardState = getter => { sbStateRef = getter; };

/* ---- Tuning -----------------------------------------------------------
   Head sits between the wall (r = 91) and the grandstand inner rim
   (r = 98): face plane lands near z = -94.1, steel backs out to
   z ~= -96.1. Tilt tips the LED face a touch down toward home plate. */
const BOARD_Z = -(91 + 3.7);       // group origin (ground line, centre CF)
const HEAD_Y  = 9.7;               // head centre height
const TILT    = 0.055;             // ~3.2 deg downward toward the field
const CW = 2048, CH = 1024;        // LED canvas (POT -> mipmapped)

const AMBER = '#F2C14E';                       // park amber (wall line tone)
const AMBER_HI = '#ffd97a';
const DIM = 'rgba(159,176,191,';               // + alpha + ')'
const FONT_BLACK = "'Arial Black','Arial Bold',Arial,sans-serif";

export function buildScoreboard(scene) {

  /* ---- Canvas + texture ---------------------------------------------- */
  const cv = document.createElement('canvas'); cv.width = CW; cv.height = CH;
  const g = cv.getContext('2d');
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;

  /* LED dressing, baked once (patterns/gradients are cheap to reuse) */
  const gridPat = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 6;
    const q = c.getContext('2d');
    q.fillStyle = '#ffffff'; q.fillRect(0, 0, 6, 6);           // no-op base
    q.fillStyle = 'rgba(255,208,208,.5)'; q.fillRect(0, 0, 2, 5);   // R subpixel
    q.fillStyle = 'rgba(208,255,208,.5)'; q.fillRect(2, 0, 2, 5);   // G
    q.fillStyle = 'rgba(208,208,255,.5)'; q.fillRect(4, 0, 2, 5);   // B
    q.fillStyle = 'rgba(120,120,120,.55)'; q.fillRect(5, 0, 1, 6);  // pixel gap
    q.fillStyle = 'rgba(90,90,90,.55)'; q.fillRect(0, 5, 6, 1);     // scanline
    return g.createPattern(c, 'repeat');
  })();
  const vig = (() => {
    const gr = g.createRadialGradient(CW / 2, CH / 2, CH * .45, CW / 2, CH / 2, CW * .72);
    gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,.26)');
    return gr;
  })();
  const sheen = (() => {
    const gr = g.createLinearGradient(0, 0, CW * .55, CH);
    gr.addColorStop(0, 'rgba(255,255,255,.05)');
    gr.addColorStop(.55, 'rgba(255,255,255,.012)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    return gr;
  })();

  /* ---- Line-score memory ----------------------------------------------
     Per-inning runs, derived: every refreshHUD() re-sample banks
     total-minus-prior into the current (inning, half) cell, so runs
     land in the right column without touching GameState. */
  const rows = [[], []];
  let lastCol = -1;

  /* Local display state — drives the board before binding and when the
     board is driven manually via setScore (tests, screenshots). */
  const local = {
    state: 'READY', inning: 1, half: 'bottom',
    balls: 0, strikes: 0, outs: 0,
    score: { lin: 0, opp: 0 },
    bases: [false, false, false]
  };

  /* ---- Paint helpers --------------------------------------------------- */
  function rr(x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }
  const inkOf = hex => {
    const n = parseInt(hex.slice(1), 16);
    return ((n >> 16 & 255) * 299 + (n >> 8 & 255) * 587 + (n & 255) * 114) / 1000 > 150
      ? '#0b1016' : '#ffffff';                 // dark ink on light club colours
  };
  function txt(str, x, y, size, fill, o = {}) {
    g.save();
    if (o.sx) { g.translate(x, y); g.scale(o.sx, 1); x = 0; y = 0; }
    g.font = `${o.w || 900} ${size}px ${FONT_BLACK}`;
    g.textAlign = o.align || 'center';
    g.textBaseline = o.bl || 'alphabetic';
    g.letterSpacing = (o.ls || 0) + 'px';
    if (o.glow) {
      g.shadowColor = o.glowColor || 'rgba(242,193,78,.85)';
      g.shadowBlur = o.glow;
    }
    g.fillStyle = fill; g.fillText(str, x, y);
    if (o.glow) { g.shadowBlur = 0; g.fillText(str, x, y); }   // hot core
    g.restore();
  }
  function tri(cx, cy, w, h, up, fill) {
    g.beginPath();
    if (up) { g.moveTo(cx, cy - h / 2); g.lineTo(cx + w / 2, cy + h / 2); g.lineTo(cx - w / 2, cy + h / 2); }
    else { g.moveTo(cx, cy + h / 2); g.lineTo(cx + w / 2, cy - h / 2); g.lineTo(cx - w / 2, cy - h / 2); }
    g.closePath(); g.fillStyle = fill; g.fill();
  }
  function divider(y) {
    g.strokeStyle = 'rgba(255,255,255,.14)'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(40, y); g.lineTo(CW - 40, y); g.stroke();
  }

  /* ---- Screen sections -------------------------------------------------- */
  function wordmark() {
    const wy = 104;
    g.strokeStyle = 'rgba(242,193,78,.5)'; g.lineWidth = 3;
    g.beginPath();
    g.moveTo(150, wy - 18); g.lineTo(690, wy - 18);
    g.moveTo(CW - 690, wy - 18); g.lineTo(CW - 150, wy - 18);
    g.stroke();
    [[150, wy - 18], [CW - 150, wy - 18]].forEach(([dx, dy]) => {
      g.save(); g.translate(dx, dy); g.rotate(Math.PI / 4);
      g.fillStyle = LIN.primary; g.fillRect(-9, -9, 18, 18); g.restore();
    });
    txt(STADIUM.name.toUpperCase(), CW / 2, wy, 62, AMBER, { ls: 16, glow: 22 });
    txt('LINCOLN · NEBRASKA', CW / 2, wy + 36, 21, DIM + '.62)', { ls: 7, w: 700 });
  }

  function teamBlock(cx, club, runs) {
    const hex = club.pri || club.primary;          // LIN.primary vs OPP.pri
    const bw = 500, bx = cx - bw / 2, by = 200, bh = 76;
    rr(bx, by, bw, bh, 10);
    g.fillStyle = hex; g.fill();
    g.lineWidth = 2; g.strokeStyle = 'rgba(255,255,255,.3)'; g.stroke();
    /* abbr, auto-contrasted against the club colour */
    g.font = `900 50px ${FONT_BLACK}`;
    g.fillStyle = inkOf(hex); g.textAlign = 'left'; g.textBaseline = 'middle';
    g.save(); g.translate(bx + 30, by + bh / 2 + 2); g.scale(.92, 1);
    g.fillText(club.abbr, 0, 0); g.restore();
    /* city + nickname (LIN carries name, not city/nick), shrunk to fit */
    const label = (club.city ? club.city + ' ' + club.nick : club.name).toUpperCase();
    let fs = 25;
    g.font = `700 ${fs}px ${FONT_BLACK}`;
    while (g.measureText(label).width > bw - 165 && fs > 15) {
      fs--; g.font = `700 ${fs}px ${FONT_BLACK}`;
    }
    g.textAlign = 'right'; g.globalAlpha = .95;
    g.fillText(label, bx + bw - 26, by + bh / 2 + 3);
    g.globalAlpha = 1; g.textBaseline = 'alphabetic';
    /* giant condensed digits + club underline */
    txt(String(runs), cx, 596, 315, '#ffffff',
      { sx: .86, glow: 30, glowColor: 'rgba(255,205,110,.55)' });
    g.fillStyle = hex; g.fillRect(cx - 90, 624, 180, 7);
  }

  function centerCol(st, score) {
    const cx = CW / 2;
    txt('INNING', cx, 218, 26, AMBER, { ls: 9, w: 700 });
    if (st.state === 'OVER') {
      txt('FINAL', cx, 392, 118, AMBER, { sx: .9, glow: 26 });
      txt(`${LIN.abbr} ${score.lin}  -  ${score.opp} ${OPP.abbr}`,
        cx, 452, 32, '#ffffff', { w: 700, ls: 3 });
    } else {
      const top = st.half === 'top';
      tri(cx - 116, 340, 62, 52, top, AMBER_HI);
      txt(String(st.inning), cx + 34, 400, 175, '#ffffff',
        { sx: .9, glow: 18, glowColor: 'rgba(255,255,255,.4)' });
      txt(top ? 'TOP' : 'BOT', cx, 450, 30, DIM + '.8)', { ls: 8, w: 700 });
    }
    /* base diamond — fill follows the batting club, mirroring the HUD.
       Red visitor primaries read as LIN's Husker red at board distance, so
       confusable clubs fall back to their secondary (white); occupied
       squares also get a bolder white edge for small-size legibility. */
    const occ = [!!st.bases[1], !!st.bases[0], !!st.bases[2]];   // 2B, 1B, 3B
    const redLikeLin = h => {
      const n = parseInt(h.slice(1), 16);
      const r = n >> 16 & 255, gg = n >> 8 & 255, b = n & 255;
      return r > 110 && r > gg * 1.55 && r > b * 1.55;
    };
    const batCol = st.half === 'bottom' ? LIN.primary
      : redLikeLin(OPP.pri) ? (OPP.sec || '#ffffff') : OPP.pri;
    [[cx, 516], [cx + 52, 568], [cx - 52, 568]].forEach(([bx2, by2], i) => {
      g.save(); g.translate(bx2, by2); g.rotate(Math.PI / 4);
      if (occ[i]) { g.shadowColor = batCol; g.shadowBlur = 18; }
      g.fillStyle = occ[i] ? batCol : '#1d2530';
      g.fillRect(-24, -24, 48, 48);
      g.shadowBlur = 0;
      g.lineWidth = occ[i] ? 4 : 3;
      g.strokeStyle = occ[i] ? 'rgba(255,255,255,.8)' : 'rgba(255,255,255,.35)';
      g.strokeRect(-24, -24, 48, 48);
      g.restore();
    });
    g.save(); g.translate(cx, 620); g.rotate(Math.PI / 4);       // home ghost
    g.fillStyle = '#141b24'; g.fillRect(-16, -16, 32, 32);
    g.lineWidth = 2; g.strokeStyle = 'rgba(255,255,255,.2)';
    g.strokeRect(-16, -16, 32, 32); g.restore();
    /* B-S-O pips — same colours as the HUD score bug */
    const pipRow = (label, y, n, on, col) => {
      txt(label, cx - 118, y + 10, 30, AMBER, { align: 'right', w: 700 });
      for (let i = 0; i < n; i++) {
        g.beginPath(); g.arc(cx - 64 + i * 40, y, 13, 0, Math.PI * 2);
        if (i < on) { g.shadowColor = col; g.shadowBlur = 12; }
        g.fillStyle = i < on ? col : 'rgba(255,255,255,.14)';
        g.fill(); g.shadowBlur = 0;
        g.lineWidth = 2; g.strokeStyle = 'rgba(255,255,255,.25)'; g.stroke();
      }
    };
    pipRow('B', 676, 3, Math.min(3, st.balls | 0), '#7ec8ff');
    pipRow('S', 724, 2, Math.min(2, st.strikes | 0), '#ffcf4d');
    pipRow('O', 772, 2, Math.min(2, st.outs | 0), '#ff5f4e');
  }

  function ribbon(st, score) {
    /* One column per INNING (both halves share it): the visiting club
       (OPP) bats in the top and owns the column's cell on its row, the
       home nine (LIN) bats in the bottom and owns it on theirs —
       exactly how a park line score reads. MAX_INNINGS = 12 caps the
       board at 12 columns, so every played inning always fits. */
    const col = Math.max(0, st.inning - 1);
    const batRow = st.half === 'top' ? 1 : 0;       // 0 = LIN, 1 = OPP
    if (col < lastCol) rows.forEach(r => { r.length = Math.min(r.length, col + 1); });
    lastCol = col;
    const tot = [score.lin | 0, score.opp | 0];
    for (let tm = 0; tm < 2; tm++) {
      const arr = rows[tm];
      while (arr.length < col + 1) arr.push(0);
      if (tm === batRow) {
        let prior = 0;
        for (let i = 0; i < col; i++) prior += arr[i] || 0;
        arr[col] = Math.max(0, tot[tm] - prior);    // bank unseen runs here
      }
    }
    const slots = Math.min(12, Math.max(9, col + 1));
    const gx = 306, gr = 1782, cw = (gr - gx) / slots;
    txt('LINE SCORE', 70, 872, 22, DIM + '.6)', { align: 'left', ls: 5, w: 700 });
    for (let i = 0; i < slots; i++)
      txt(String(i + 1), gx + cw * (i + .5), 872, 20, DIM + '.55)', { w: 700 });
    txt('R', 1848, 872, 22, AMBER, { w: 700 });
    const ry = [924, 976];
    [[LIN, 0], [OPP, 1]].forEach(([club, tm]) => {
      const y = ry[tm], hex = tm ? OPP.pri : LIN.primary;
      g.fillStyle = hex; g.fillRect(70, y - 16, 16, 16);          // colour chip
      txt(club.abbr, 98, y + 12, 30, '#ffffff', { align: 'left', sx: .92 });
      for (let i = 0; i < slots; i++) {
        const played = i < rows[tm].length;
        txt(played ? String(rows[tm][i]) : '-',
          gx + cw * (i + .5), y + 12, 30,
          played ? (rows[tm][i] ? AMBER_HI : 'rgba(255,255,255,.78)')
                 : 'rgba(255,255,255,.16)',
          { sx: .9 });
      }
      txt(String(tot[tm]), 1848, y + 12, 34, '#ffffff',
        { sx: .9, glow: 10, glowColor: 'rgba(255,255,255,.35)' });
      g.strokeStyle = 'rgba(255,255,255,.07)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(64, y + 26); g.lineTo(1990, y + 26); g.stroke();
    });
    if (tot[0] !== tot[1]) {                                      // winner tick
      const wi = tot[0] > tot[1] ? 0 : 1;
      g.fillStyle = wi ? OPP.pri : LIN.primary;
      g.fillRect(1810, ry[wi] + 27, 86, 5);
    }
  }

  function ledDressing() {
    g.fillStyle = 'rgba(0,0,0,.3)';                               // cabinet seams
    for (let x = 256; x < CW; x += 256) g.fillRect(x - 1.5, 14, 3, CH - 28);
    g.fillRect(14, CH / 2 - 1.5, CW - 28, 3);
    g.save();
    g.globalCompositeOperation = 'multiply';
    g.fillStyle = gridPat; g.fillRect(0, 0, CW, CH);              // LED pixel mesh
    g.restore();
    g.fillStyle = vig; g.fillRect(0, 0, CW, CH);
    g.fillStyle = sheen; g.fillRect(0, 0, CW, CH);
  }

  /* ---- Full repaint (only ever called on a state change) ---------------- */
  function render(st) {
    const score = st.score || { lin: 0, opp: 0 };
    g.fillStyle = '#04070b'; g.fillRect(0, 0, CW, CH);
    g.fillStyle = '#070c12'; g.fillRect(16, 16, CW - 32, CH - 32);
    g.strokeStyle = 'rgba(242,193,78,.4)'; g.lineWidth = 3;
    g.strokeRect(14, 14, CW - 28, CH - 28);
    g.strokeStyle = 'rgba(242,193,78,.12)'; g.lineWidth = 1.5;
    g.strokeRect(24, 24, CW - 48, CH - 48);

    wordmark();
    divider(158);
    teamBlock(352, LIN, score.lin | 0);
    teamBlock(CW - 352, OPP, score.opp | 0);
    centerCol(st, score);
    divider(826);
    ribbon(st, score);

    ledDressing();
    tex.needsUpdate = true;
  }

  /* ---- Physical build -----------------------------------------------------
     group (ground origin, centre CF)  ->  steel stays plumb
       head (tilted)                   ->  bezel + cabinet + LED face        */
  const group = new THREE.Group(); group.name = 'scoreboard';
  group.position.set(0, 0, BOARD_Z);

  const head = new THREE.Group(); head.name = 'scoreboard_head';
  head.position.y = HEAD_Y; head.rotation.x = TILT; group.add(head);

  const bezel = new THREE.Mesh(new THREE.BoxGeometry(20.8, 11.6, .34),
    new THREE.MeshStandardMaterial({ color: 0x11161c, roughness: .65 }));
  bezel.castShadow = true; head.add(bezel);

  const cab = new THREE.Mesh(new THREE.BoxGeometry(20.2, 11, .5),
    new THREE.MeshStandardMaterial({ color: 0x05070a, roughness: .4 }));
  cab.position.z = .31; cab.castShadow = true; head.add(cab);

  const face = new THREE.Mesh(new THREE.PlaneGeometry(19.8, 10.6),
    new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));   // LEDs glow
  face.position.z = .585; face.name = 'scoreboard_face'; head.add(face);

  /* Steel truss — columns, cross members, X braces, cabinet arms and a
     catwalk rail, ALL merged into one geometry (one draw call). */
  const parts = [];
  const box = (w, h, d, x, y, rz = 0, z = -1.35) => {
    const b = new THREE.BoxGeometry(w, h, d);
    if (rz) b.rotateZ(rz);
    b.translate(x, y, z); parts.push(b);
  };
  for (const sx of [-1, 1]) {
    box(.55, 16.6, .55, sx * 8.7, 8.3);          // column
    box(1.7, .5, 1.7, sx * 8.7, .25);            // concrete pad
    box(.42, .42, 1.5, sx * 8.7, 6.2, 0, -.62);  // arm, low
    box(.42, .42, 1.5, sx * 8.7, 13.2, 0, -.62); // arm, high
  }
  box(17.95, .5, .5, 0, 3.4);                    // cross member, low
  box(17.95, .5, .5, 0, 12.6);                   // cross member, high
  box(17.6, .32, .32, 0, 1.85, .178);            // X braces, lower bay
  box(17.6, .32, .32, 0, 1.85, -.178);
  box(17.6, .32, .32, 0, 14.45, .213);           // X braces, upper bay
  box(17.6, .32, .32, 0, 14.45, -.213);
  for (let i = 0; i < 5; i++)
    box(.13, 1, .13, -9.8 + i * 4.9, 15.6, 0, -.1);   // catwalk posts
  box(20.6, .16, .16, 0, 16.12, 0, -.1);              // catwalk rail
  const steel = new THREE.Mesh(mergeGeoms(parts),
    new THREE.MeshStandardMaterial({ color: 0x515b64, roughness: .55, metalness: .5 }));
  steel.name = 'scoreboard_steel'; steel.castShadow = true; group.add(steel);

  scene.add(group);

  /* ---- Public API ---------------------------------------------------------
     setScore(patch) — drive the display directly (merges score deeply)
     draw()          — repaint from the bound game state (or local)
     bindState(fn)   — alias of bindScoreboardState
     resetLines()    — wipe the derived line-score history               */
  const api = {
    group, head, face, steel, canvas: cv, texture: tex,
    setScore(patch = {}) {
      if (patch.score) Object.assign(local.score, patch.score);
      for (const k of ['inning', 'half', 'balls', 'strikes', 'outs', 'state'])
        if (patch[k] !== undefined) local[k] = patch[k];
      if (patch.bases) local.bases = patch.bases.slice();
      render(local);
    },
    draw() { render(sbStateRef() || local); },
    bindState(getter) { bindScoreboardState(getter); },
    resetLines() {
      rows[0].length = 0; rows[1].length = 0; lastCol = -1;
      render(sbStateRef() || local);
    }
  };

  /* Register the closure exactly the way the old SceneManager drawer did:
     every HUDController.refreshHUD() -> drawScoreboard() repaints from
     the freshly bound G, so scores/count/inning can never go stale. */
  setScoreboardDrawer(() => {
    const G = sbStateRef(); if (!G) return;
    render(G);
  });

  return api;
}
