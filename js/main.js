/* =====================================================================
   main.js — engine entry: wiring, main loop, debug instrumentation, boot
   Part of the Lincoln Red Gauntlet engine · js/
===================================================================== */
import * as THREE from 'three';
import { renderer, scene, camera, clouds, buildStadium, bindScoreboardState, updateCrowd } from './core/SceneManager.js';
import { G } from './core/GameState.js';
import { LIN, STADIUM, DEBUG_POSE, DEBUG_CHAR } from './core/Constants.js';
import { OPP, roster, lineupOrder } from './entities/RosterManager.js';
import { ACTORS, loadFBX } from './entities/PlayerFactory.js';
import { driveActor } from './animation/AnimationController.js';
import { stepBall, ball } from './physics/BallPhysics.js';
import { updateParticles } from './effects/ParticleSystem.js';
import { initFielding, updateFielders } from './entities/FieldingAI.js';
import { updateRunners, runnerPool } from './entities/Runners.js';
import { camCtl, updateCamera } from './core/CameraSystem.js';
import {
  initCornEntrance, updateCornEntrance, cornEntranceBegin
} from './core/CornEntrance.js';
import { initReplay, updateReplay, replayActive } from './core/ReplaySystem.js';
import { initFlyover, updateFlyover } from './core/Flyover.js';
import {
  deployTeams, initSubsystems, wireInput, startAtBat,
  getBatter, defense, homeActors
} from './core/Game.js';
import { toast, buildDrawer, refreshHUD } from './ui/HUDController.js';
import { initStrikeZone, updateStrikeZone } from './ui/StrikeZone.js';
import {
  runSched, now, getDelta, rand, schedLen, $
} from './utils/MathUtils.js';

/* Gauntlet error surfacing — nothing dies silently */
addEventListener('error', e => console.error('[runtime]', e.message, '@', e.filename, e.lineno));
addEventListener('unhandledrejection', e =>
  console.error('[promise]', e.reason && (e.reason.stack || e.reason.message) || String(e.reason)));

/* ---- Assemble world & systems -----------------------------------------
   Boot order (task 8 — stadium picker at load): the load screen first asks
   Oracle Park or Field of Dreams; ONLY then does buildStadium raise the
   chosen park (SceneManager no longer builds at module eval). Everything
   downstream — team deployment, HUD, FBX load, reveal — runs after it.
   ?park=oracle|fod skips the picker for QA / deep links. ---------------- */
/* bootmsg stays on its static BUILDING BALLPARK… seed until the park is
   chosen below — the matchup name now lives in #boot .title instead. */

function choosePark() {
  return new Promise(res => {
    const forced = new URLSearchParams(location.search).get('park');
    if (forced === 'oracle' || forced === 'fod') return res(forced);
    /* Owner directive: plain two-card picker — NO park is marked default,
       the choice is made by clicking a card. ?park=oracle|fod deep-links
       past this for QA / shared links. */
    const el = $('parkpick');
    el.classList.add('show');
    el.querySelectorAll('.pp-card').forEach(b =>
      b.addEventListener('click', () => { el.classList.remove('show'); res(b.dataset.park); }, { once:true }));
  });
}

const parkKey = await choosePark();
buildStadium(parkKey);
$('bootbar').style.visibility = 'visible';
$('bootmsg').textContent = parkKey === 'fod' ? 'PLANTING THE CORN…' : `BUILDING ${STADIUM.name.toUpperCase()}…`;

bindScoreboardState(() => G);
deployTeams();
initSubsystems();
initStrikeZone(scene);
initReplay();
wireInput();
buildDrawer();
refreshHUD();

/* On-deck hitter visible near the circle */
{
  const od = homeActors[roster[lineupOrder[1]]];
  od.root.visible = true;
  od.root.position.set(-6.5, 0, 3.5);
  od.root.rotation.y = Math.atan2(-od.root.position.x, -od.root.position.z);   // face the plate (on-deck yaw fix)
  od.animState = { name:'idle', start:rand(0, 9) };
}

/* ======================================================================
   MAIN LOOP
====================================================================== */
let running = false;

function tick() {
  requestAnimationFrame(tick);
  window.__TICKS = (window.__TICKS || 0) + 1;
  const dt = getDelta();
  const t = now();

  runSched();
  stepBall(dt);
  updateParticles(dt);
  updateStrikeZone(dt, t);
  updateFielders(dt);
  updateRunners(dt);

  for (const a of ACTORS) driveActor(a, t);
  for (const a of ACTORS) a.update(dt);

  /* Broadcast camera director — stands down while an instant replay owns the
     lens; the world (trot, fielders, crowd) keeps living underneath it. */
  if (!replayActive()) {
    if (['READY','WINDUP','PITCH'].includes(G.state)) camCtl.mode = 'bat';
    else if (G.state === 'LIVE' && ball.mesh.visible) camCtl.mode = 'track';
    /* Live flight over → frame the result. The old gate demanded
       ball.mode === 'dead', but throw-out theatre ends the ball HIDDEN
       ('held' in a glove), never dead — the chase shot then stared at the
       frozen last ball spot (bag + two idle actors) for the whole DEAD
       window: the "two statues" stall. Cut to result framing whenever the
       tracked ball stops being a live object, however the play ended. */
    else if (camCtl.mode === 'track') {
      camCtl.mode = 'result';
      if (G.result && G.result.type !== 'HR') camCtl.focus.copy(ball.pos);
      else camCtl.focus.set(0, 0, -40);
      camCtl.focus.y = Math.max(camCtl.focus.y, 0);
    }
    if (G.state === 'OVER') { camCtl.mode = 'result'; camCtl.focus.set(0, 0, -30); }
    updateCamera(dt);
  }
  updateReplay(dt);

  /* Opening flyover — last write wins the frame while it flies (it parks
     over whatever updateCamera/updateReplay produced). Once finished or
     skipped this call is a no-op branch and the director regains the lens
     seamlessly from wherever the flight left it — see Flyover.js header. */
  updateFlyover(dt);

  /* FOD pre-game theatre: the opening defence + bench hold hidden in the
     corn while the flyover tours, then stream out once it releases the
     lens. Runs after every other system in the tick, so while active our
     transforms are the last word on that cast; when it completes they are
     already standing where Game.js staged them at deploy time — no
     tug-of-war with gameplay prep (CornEntrance.js). */
  updateCornEntrance(dt);

  for (const c of clouds) {
    c.spr.position.x += c.v * dt;
    if (c.spr.position.x > 460) c.spr.position.x = -460;
  }
  updateCrowd(t);

  renderer.render(scene, camera);
}

/* ======================================================================
   AUTOMATED GAUNTLET DEBUG HANDLE
===================================================================== */
window.__GB = {
  G, ball, SCENE:scene, CAM:camera, THREE,
  getCams:() => camCtl.mode,
  getState:() => G.state,
  getBatter:() => getBatter() && getBatter().name,
  schedLen:() => schedLen(),
  elapsed:() => now(),
  ticks:() => window.__TICKS || 0,
  forceStart:() => { try { startAtBat(); return 'ok'; } catch (e) { return 'THREW: ' + e.message; } },
  actorByName:n => ACTORS.find(a => a.name === n) || null,
  /* Debug lens override: setCam(px,py,pz, lx,ly,lz) parks the camera until
     setCam() is called bare. Feeds camCtl.manual — see CameraSystem. */
  setCam:(...a) => { camCtl.manual = a.length >= 6
    ? { pos:new THREE.Vector3(a[0], a[1], a[2]), look:new THREE.Vector3(a[3], a[4], a[5]) }
    : null; return 'ok'; },
  actors:() => ACTORS.map(a => ({
    n:a.name, f:!!a.bones, anim:a.animState.name,
    p:[+a.root.position.x.toFixed(1), +a.root.position.z.toFixed(1)]
  })),
  pick:(x, y) => {
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(x * 2 - 1, -(y * 2 - 1)), camera);
    return rc.intersectObjects(scene.children, true).slice(0, 4).map(h => ({
      t:h.object.type, n:h.object.name || '',
      p:h.object.parent ? (h.object.parent.name || h.object.parent.type) : '', d:+h.distance.toFixed(1)
    }));
  },
  probe:(x, y) => {
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(x * 2 - 1, -(y * 2 - 1)), camera);
    const h = rc.intersectObjects(scene.children, true)[0];
    if (!h) return null;
    const o = h.object;
    return {
      pt:h.point.toArray().map(v => +v.toFixed(1)), d:+h.distance.toFixed(1),
      geo:o.geometry ? o.geometry.type : '',
      prm:o.geometry && o.geometry.parameters ? JSON.stringify(o.geometry.parameters) : '',
      mat:o.material ? (o.material.type + ':' + (o.material.color ? o.material.color.getHexString()
        : (o.material.userData && o.material.userData.shader ? 'shader' : ''))) : '',
      chain:(() => { const a = []; let c = o; while (c && a.length < 6) { a.push(c.name || c.type); c = c.parent; } return a; })()
    };
  },
  rig:() => {
    const a = getBatter(); if (!a) return null;
    let bat = null;
    a.root.traverse(o => {
      if (/bat/i.test(o.name) && !bat)
        bat = { n:o.name, par:o.parent ? (o.parent.name || o.parent.type) : '', vis:o.visible, sx:+o.scale.x.toFixed(3) };
    });
    return {
      name:a.name,
      ch:Object.keys(a.channels),
      sig:Object.entries(a.sig).map(([k, v]) => k + '=' + JSON.stringify(v)).join(' '),
      anim:a.animState ? a.animState.name : '', bat
    };
  },
  getFootY:name => {
    const a = ACTORS.find(a => a.name === name); if (!a) return null;
    const b = new THREE.Box3().setFromObject(a.model);
    return { min:+b.min.y.toFixed(3), max:+b.max.y.toFixed(3) };
  }
};

/* ======================================================================
   BOOT SEQUENCE (tail — park chosen & world assembled above)
===================================================================== */
if (DEBUG_POSE && DEBUG_CHAR) {
  setTimeout(() => {
    const a = homeActors[DEBUG_CHAR] || defense[DEBUG_CHAR] || Object.values(defense)[0];
    if (a) a.animState = { name:DEBUG_POSE, start:now(), dur:1e9 };
  }, 1500);
}

loadFBX(roster[lineupOrder[0]]).finally(() => {
  $('boot').classList.add('hide');
  /* BOOT HOLD — the first at-bat gates on the flyover FINISHING, not on a
     timer: initFlyover's onDone fires exactly when the lens is released,
     parked bit-exact on the director's 'bat'/plate rest pose (see Flyover.js
     header), so gameplay begins on one continuous camera move. Skipping the
     tour runs the SAME signal through its ~.85 s return ease — still effectively
     instant, and still behind the hitter before the first windup. In FOD the
     corn theatre extends that gate one beat — see the onDone hook below.
     ?freeze=1 — diagnostic boot: world renders, nobody ever steps in the
     box, so staged poses (via __GB.actorByName) survive for screenshots. */
  const freezeBoot = new URLSearchParams(location.search).has('freeze');
  initFlyover({
    camera, park: parkKey,
    onDone: freezeBoot ? null : () => {
      /* FOD: the lens coming home is the corn walkout's STARTING GUN — the
         cast held hidden through the whole tour; cornEntranceBegin() sends
         them streaming out and the module itself calls startAtBat from its
         completion callback once EVERY actor has planted, so no windup can
         beat the last jogger home. Parks without the theatre get false and
         bat immediately right here (oracle timing unchanged). */
      try { if (!cornEntranceBegin()) startAtBat(); }
      catch (e) { console.error('[boot] startAtBat failed:', e); }
    }
  });
  /* FOD only: the opening defence + bench hold hidden in the corn for the
     ENTIRE flyover, then stream out when it ends; the module OWNS the
     first at-bat via onStartBatting (fires only once everyone has arrived,
     or instantly on skip). Oracle untouched, and ?freeze=1 keeps everyone
     at their diagnostic marks. */
  if (parkKey === 'fod' && !freezeBoot)
    try {
      initCornEntrance({
        park: parkKey, defense, runnerPool,
        onStartBatting: () => {
          try { startAtBat(); } catch (e) { console.error('[boot] startAtBat failed:', e); }
        }
      });
    } catch (e) { console.error('[boot] corn entrance failed:', e); }
  try { tick(); running = true; } catch (e) { console.error('[boot] tick failed:', e); }
  try { toast(`Welcome to ${STADIUM.name} — ${LIN.name} host the ${OPP.city} ${OPP.nick}!`); }
  catch (e) { console.error('[boot] toast failed:', e); }
});
