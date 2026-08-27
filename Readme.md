# ⚾ Fantasy League vs Field of Dreams

A browser-based 3D baseball game built from scratch with [Three.js](https://threejs.org/) — no game engine, no build step, just an `index.html` and vanilla JS modules. Step up to the plate as the **Fantasy League** against a roster of Field of Dreams legends, in either **Oracle Park** or a corn-ringed **Field of Dreams**.

Powered by the **Lincoln Red Gauntlet engine** — a homegrown JS baseball sim covering pitching, hitting, fielding AI, base running, camera direction, and instant replay.

## Play

Open `index.html` in a modern browser (Chrome/Edge/Safari). No server or build step required — it runs straight off the filesystem.

1. Pick your park: **Oracle Park** or **Field of Dreams**.
2. Watch the ~13-second aerial flyover intro (skippable — tap or press any key).
3. When Fantasy League bats: **SPACE** or **tap** to swing, timed against the pitch.
4. When Fantasy League fields: tap a cell in the pitch-location grid (or drag to fine-aim) to aim, then hit **PITCH**.

## Features

- **Full 9-inning game** (extra innings supported) with a live scorebug — score, inning, count, and base diamond.
- **Timing-based hitting** — swing quality is graded against pitch timing, with exit velocity/launch bands driving realistic ball flight (drag-modeled physics, tuned so home runs feel earned rather than automatic).
- **Pitch-location aiming** for the half-innings your team is on the mound, via a 3×3 strike-zone grid.
- **Fielding AI** — chase logic, cutoffs, backing up flies, infield creep during the windup, shifts, and race-the-runner throws to the bag.
- **Base running** with full force/tag logic across all bases.
- **Broadcast-style camera direction** — dedicated shots for at-bats, live ball tracking, and post-play framing, plus an **instant replay system** with a mid-replay angle cut.
- **Two stadiums**: a classic V-bowl **Oracle Park**, and **Field of Dreams**, complete with a corn-outfield entrance sequence where both benches emerge from the corn before first pitch.
- Animated crowd, scoreboard/videoboard, dynamic skyline, and ambient stadium audio.
- FBX-rigged player models with skeleton-cloned instancing (see [Assets](#assets)) and a stylized geometric fallback when a model isn't present.

## Matchup

| | **Fantasy League** (home) | **Field of Dreams** (visitors) |
|---|---|---|
| Roster | 11 real-world names, shuffled across all 9 field positions + DH/Manager each game | The *Shoeless Joe* cast — Eddie Cicotte, "Shoeless" Joe Jackson, Gil Hodges, Buck Weaver, Mel Ott, Ty Cobb (DH), John Kinsella (manager, dugout-only), and more |
| Colors | Crimson `#C8102E` | Corn green `#2F5D3A` |

## Project structure

```
index.html              Boot screen, HUD, styles, park picker
js/
  main.js                Engine entry — boot sequence & main loop
  core/
    Game.js               Core game/at-bat state machine, rules, input wiring
    GameState.js           Shared mutable game state (G)
    SceneManager.js         Scene/stadium construction, renderer
    CameraSystem.js          Broadcast camera director
    ReplaySystem.js           Instant replay recorder/playback
    Flyover.js                 Opening aerial cinematic
    CornEntrance.js             Field of Dreams corn entrance choreography
    Constants.js                 Field geometry, fielding/ballistics tuning
  entities/
    PlayerFactory.js          FBX/fallback player construction & rigging
    RosterManager.js           Team rosters & lineups
    FieldingAI.js               Defensive fielder logic
    Runners.js / RunnersHelpers.js   Base running logic
    HumanoidTeam.js               Bench/idle team management
  physics/BallPhysics.js    Pitch & batted-ball flight model
  animation/
    AnimationController.js   Procedural/rig animation driver
    GripIK.js                  Hand/glove IK
  ui/
    HUDController.js          Scorebug, drawer, toasts
    PitchPicker.js              Pitch-location aiming UI
    StrikeZone.js                 Strike zone overlay
  world/
    Crowd.js / Scoreboard.js / Skyline.js   Stadium set dressing
  audio/AudioManager.js     Sound effects & ambience
  effects/ParticleSystem.js Hit/dirt/dust particles
  utils/MathUtils.js       Shared helpers
lib/three/               Bundled Three.js + FBXLoader (no npm install needed)
```

## Assets

The engine expects `.fbx` player/prop models in the project root (loaded via `loadFBX()`, with graceful fallback to a stylized geometric model if a file is missing):

- **Home roster:** `Dan.fbx`, `Danny.fbx`, `Doug.fbx`, `Hyle.fbx`, `Josh.fbx`, `Kevo.fbx`, `Nate.fbx`, `Nick.fbx`, `Paul.fbx`, `Scherz.fbx`, `Ted.fbx`
- **Visiting team rig:** `Player1.fbx` (used for all Field of Dreams fielders), `Player2.fbx` (loaded, currently unused)
- **Mitts:** `CatcherMit.fbx`, `RegularMit.fbx`

Models aren't tracked in this repo — drop your own `.fbx` files in the project root using the names above to enable them; anything missing just falls back to the built-in stylized model.

## Tech

- [Three.js](https://threejs.org/) (bundled locally under `lib/three/`, including `FBXLoader`)
- Plain ES modules, no bundler/build step
- No external dependencies or package manager required

## Status

Personal/hobby project — a solo experiment in building a full 3D sports sim in the browser with vanilla Three.js.
