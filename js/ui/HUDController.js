/* =====================================================================
   HUDController.js — broadcast HUD: score bug, banners, stat line,
   toasts, roster drawer, action button, center-field scoreboard.
   Part of the Lincoln Red Gauntlet engine · js/ui/
===================================================================== */
import { LIN, STADIUM } from '../core/Constants.js';
import { G } from '../core/GameState.js';
import { $ } from '../utils/MathUtils.js';
import { drawScoreboard } from '../core/SceneManager.js';
import { OPP, roster, lineupOrder, oppFielders, OPP_DEF_KEYS } from '../entities/RosterManager.js';

export const UI = {
  btn:$('actionBtn'), banner:$('banner'),
  bannerMain:document.querySelector('#banner .ban-main'),
  bannerSub:document.querySelector('#banner .ban-sub'),
  dist:$('distpop'),
  ev:$('st-ev'), la:$('st-la'), distV:$('st-dist'), stat:$('statline'),
  muBat:$('mu-bat'), muPit:$('mu-pit'), inning:$('sb-inning'), sbRows:$('sb-rows'),
  pips:{
    b:[...document.querySelectorAll('#pips-b .pip')],
    s:[...document.querySelectorAll('#pips-s .pip')],
    o:[...document.querySelectorAll('#pips-o .pip')]
  },
  diamond:$('sb-diamond'),
  bases:[...document.querySelectorAll('#sb-diamond .base')]   // DOM order: 1B, 2B, 3B → G.bases order
};

export function toast(msg) {
  const d = document.createElement('div'); d.className = 'glass toast'; d.textContent = msg;
  $('toasts').appendChild(d);
  setTimeout(() => { d.style.opacity = '0'; setTimeout(() => d.remove(), 600); }, 5200);
}

export function banner(main, sub = '', kind = '', dur = 1.5) {
  UI.bannerMain.textContent = main; UI.bannerSub.textContent = sub;
  UI.banner.className = ''; void UI.banner.offsetWidth;      // restart animation
  UI.banner.style.setProperty('--bd', dur + 's');
  UI.banner.className = 'pop' + (kind ? ' b-' + kind : '');
}

export function distPopup(txt) {
  UI.dist.textContent = txt; UI.dist.style.opacity = '1';
  clearTimeout(distPopup._t);
  distPopup._t = setTimeout(() => UI.dist.style.opacity = '0', 1500);
}

let bdLast = null;   // last-seen base occupancy, for pop-on-change pulses

export function refreshHUD() {
  UI.sbRows.innerHTML =
    `<div class="sb-row"><span class="sb-chip" style="background:${LIN.primary}"></span><span class="sb-team">${LIN.abbr}</span><span class="sb-runs">${G.score.lin}</span></div>` +
    `<div class="sb-row"><span class="sb-chip" style="background:${OPP.pri}"></span><span class="sb-team">${OPP.abbr}</span><span class="sb-runs">${G.score.opp}</span></div>`;
  UI.inning.textContent = `${G.half === 'top' ? '▲' : '▼'} ${G.inning}`;
  UI.pips.b.forEach((p, i) => p.style.background = i < G.balls ? '#7ec8ff' : 'rgba(255,255,255,.22)');
  UI.pips.s.forEach((p, i) => p.style.background = i < G.strikes ? '#ffcf4d' : 'rgba(255,255,255,.22)');
  UI.pips.o.forEach((p, i) => p.style.background = i < G.outs ? '#ff5f4e' : 'rgba(255,255,255,.22)');

  /* Base diamond — fill colour follows the batting club (event-driven, not
     per-frame). Red visitor primaries are confusable with LIN's Husker red
     (#C8102E) at bug size, so those clubs fall back to their secondary
     (white): occupancy stays legible without reading as home-nine branding. */
  const redLikeLin = h => {
    const n = parseInt(h.slice(1), 16);
    const r = n >> 16 & 255, g = n >> 8 & 255, b = n & 255;
    return r > 110 && r > g * 1.55 && r > b * 1.55;
  };
  const batHex = G.half === 'bottom' ? LIN.primary
    : redLikeLin(OPP.pri) ? (OPP.sec || '#ffffff') : OPP.pri;
  UI.diamond.style.setProperty('--occ', batHex);
  UI.diamond.style.setProperty('--occ-glow', batHex + 'b3');
  const occ = [!!G.bases[0], !!G.bases[1], !!G.bases[2]];
  occ.forEach((on, i) => {
    const el = UI.bases[i];
    el.classList.toggle('on', on);
    el.classList.remove('pop');
    if (!bdLast || bdLast[i] !== on) { void el.offsetWidth; el.classList.add('pop'); }
  });
  bdLast = occ;

  drawScoreboard();
}

export function setBtn(main, sub, dis) {
  UI.btn.disabled = dis;
  UI.btn.innerHTML = `${main}<span class="sub">${sub}</span>`;
}

/* ---- Roster drawer ----------------------------------------------------- */
let getBatterIdx = () => G.batterIdx;
export const setBatterIdxSource = fn => { getBatterIdx = fn; };

export function buildDrawer() {
  const row = (num, pos, name, tag = '', hex, atbat = false) =>
    `<div class="rrow${atbat ? ' atbat' : ''}"><span class="rnum">${num}</span>` +
    `<span class="sb-chip" style="background:${hex}"></span>` +
    `<span class="rpos">${pos}</span><span class="rname">${name}</span>${tag ? `<span class="rtag">${tag}</span>` : ''}</div>`;

  /* Venue identity (owner directive): Oracle Park is the Lincoln Fantasy
     League's HOME park, Field of Dreams the AWAY park. Read at call time —
     buildStadium stamps STADIUM before the drawer ever builds, but it stays
     mutable in Constants, so a module-level const would go stale. */
  const parkTag = STADIUM.key === 'fod' ? "HOME OF SHOELESS JOE JACKSON'S" : "HOME OF THE FANTASY LEAGUE";

  let html = `<h2><span class="dot" style="background:${LIN.primary}"></span>${LIN.name.toUpperCase()}</h2>
    <div style="font-size:11px;color:var(--txt-dim);letter-spacing:1px">${STADIUM.name.toUpperCase()} · ${parkTag} · HOME NINE RESHUFFLED EVERY LOAD</div>
    <div class="rosec">STARTING LINEUP</div>`;
  const bi = getBatterIdx();
  lineupOrder.forEach((pos, i) => {
    html += row(i + 1, pos, roster[pos], i === bi ? 'AT BAT' : '', LIN.primary, i === bi);
  });
  html += `<div class="rosec">BULLPEN & STAFF</div>`;
  html += row('—', 'Pitcher', roster['Pitcher'], 'NL', LIN.primary, false);
  html += row('—', 'Manager', roster['Manager'], 'SKIPPER', LIN.accent, false);

  html += `<h2 style="margin-top:26px"><span class="dot" style="background:${OPP.pri}"></span>${OPP.city.toUpperCase()} ${OPP.nick.toUpperCase()}</h2>
    <div style="font-size:11px;color:var(--txt-dim);letter-spacing:1px">VISITING CLUB · DYERSVILLE, IOWA</div>
    <div class="rosec">DEFENSE TODAY</div>`;
  OPP_DEF_KEYS.forEach((pos, i) => {
    html += row(i + 1, pos, oppFielders[pos], '', OPP.pri, false);
  });
  html += `<div class="rosec">DH & STAFF</div>`;
  html += row('—', 'Designated Hitter', oppFielders['Designated Hitter'], 'DH', OPP.pri, false);
  html += row('—', 'Manager', oppFielders['Manager'], 'SKIPPER', OPP.sec, false);
  $('drawer').innerHTML = html;
}
