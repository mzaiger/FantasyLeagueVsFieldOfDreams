/* =====================================================================
   AudioManager.js — fully synthesised Web Audio SFX, layered build
   Part of the Lincoln Red Gauntlet engine · js/audio/
   Every effect is a small mix of shaped-noise transients + pitched
   bodies, band-filtered, fast-attacked, randomly detuned per play so
   repeats never sound identical. Public API unchanged: SND.crack(ev),
   pop(), whoosh(), thud(v), tick(), strike(), ballCall(), roar(v),
   groan(), cheerBuild(v), chant(), batTick(), cleats(), umpCall(kind),
   organ(), unlock().
   Crowd reactions are PARK-AWARE: STADIUM.key ('oracle' | 'fod') is
   read live on every event. 'oracle' is a FULL stadium — big plays
   (HRs, runs, double plays) get a proper loud layered roar, routine
   plays a moderate lift. 'fod' is period Iowa with a tiny rustic
   bleacher behind home plate: a handful of close, distinct fans cheer
   audibly on good events, then the cornfield settles back to quiet.
===================================================================== */
import { rand } from '../utils/MathUtils.js';
import { STADIUM } from '../core/Constants.js';

export const SND = (() => {
  let ctx = null, master = null, comp = null, crowdGain = null, breathe = null,
      whiteBuf = null, brownBuf = null, echoIn = null;
  let holdUntil = 0, bigNext = false;   // bigNext: the next roar is a cheerBuild-fed BIG one

  function ensure() {
    if (ctx) return true;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();

      /* master safety: gentle glue compressor clamps stacked voices */
      master = ctx.createGain(); master.gain.value = .85;
      comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -12; comp.knee.value = 20; comp.ratio.value = 5;
      comp.attack.value = .002; comp.release.value = .2;
      master.connect(comp); comp.connect(ctx.destination);

      /* stadium slap-back: two parallel feedback taps, darkened repeats so
         the echo reads as concrete stands rather than a metallic ping */
      echoIn = ctx.createGain();
      [[.121, .30, .08], [.187, .24, .06]].forEach(([tm, fbAmt, wet]) => {
        const dly = ctx.createDelay(1); dly.delayTime.value = tm;
        const fbLp = ctx.createBiquadFilter(); fbLp.type = 'lowpass'; fbLp.frequency.value = 2400;
        const fb = ctx.createGain(); fb.gain.value = fbAmt;
        const w = ctx.createGain(); w.gain.value = wet;
        echoIn.connect(dly); dly.connect(fbLp); fbLp.connect(fb); fb.connect(dly);
        dly.connect(w); w.connect(master);
      });

      /* two reusable noise colours: bright white for cracks/snaps, dark
         Brownian for thumps/crowd rumble (one buffer for everything was
         what made the old FX muddy) */
      whiteBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const wd = whiteBuf.getChannelData(0);
      for (let i = 0; i < wd.length; i++) wd[i] = Math.random() * 2 - 1;
      brownBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const bd = brownBuf.getChannelData(0); let last = 0;
      for (let i = 0; i < bd.length; i++) { last = (last + (Math.random() * 2 - 1) * .04) / 1.04; bd[i] = last * 3.2; }

      /* continuous crowd bed, three decorrelated bands (rumble / murmur /
         sizzle) breathing together — a single bandpass tone sounded like
         wind, not people */
      const mkBed = (buf, filt, fVal, mix, rate) => {
        const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.playbackRate.value = rate;
        const f = ctx.createBiquadFilter(); f.type = filt; f.frequency.value = fVal;
        if (filt === 'bandpass') f.Q.value = .55;
        const g = ctx.createGain(); g.gain.value = mix;
        s.connect(f); f.connect(g); g.connect(breathe); s.start();
      };
      breathe = ctx.createGain(); breathe.gain.value = 1;
      crowdGain = ctx.createGain(); crowdGain.gain.value = .04;
      mkBed(brownBuf, 'lowpass',   230,  .5,  rand(.9, 1.02));   // body rumble
      mkBed(whiteBuf, 'bandpass',  520,  .24, rand(.96, 1.04));  // murmur band
      mkBed(whiteBuf, 'highpass', 2800,  .035, rand(1.0, 1.1));  // air sizzle
      breathe.connect(crowdGain); crowdGain.connect(master);

      setInterval(() => {                                  /* fast wander, park-scaled */
        if (ctx && crowdGain && Date.now() >= holdUntil) {
          const lo = isFod() ? .02 : .035, hi = isFod() ? .042 : .07;
          crowdGain.gain.linearRampToValueAtTime(lo + Math.random() * (hi - lo), ctx.currentTime + 1.4);
        }
      }, 1500);
      setInterval(() => {                                  /* slow layered swell, multiplies */
        if (ctx && breathe && Date.now() >= holdUntil)
          breathe.gain.linearRampToValueAtTime(rand(.78, 1.14), ctx.currentTime + 3.4);
      }, 3700);
      return true;
    } catch (e) { console.warn('[audio]', e); return false; }
  }

  const now = () => ctx.currentTime;

  function sendEcho(node, amt) {
    const s = ctx.createGain(); s.gain.value = amt; node.connect(s); s.connect(echoIn);
  }

  /* ---- Park keying ------------------------------------------------------
     STADIUM.key is stamped once at boot by SceneManager.buildStadium and
     read LIVE here on every event, so crowd audio always follows whichever
     park is loaded — no snapshotting, safe if the scene is ever rebuilt.
     Tiers: v >= .5, or a roar handed off from cheerBuild(), is a BIG
     moment (full Oracle roar / the whole FOD bleacher); lighter v values
     get a moderate Oracle lift / only part of the FOD handful. */
  const isFod  = () => STADIUM.key === 'fod';
  const bedMid = () => (isFod() ? .028 : .045);   // idle-bed level each reaction releases back to

  /** Shaped-noise voice. Fast linear attack (default 4 ms) then natural
      exponential decay — no instant-on clicks. Optional exponential filter
      sweep, playback-rate randomisation for spectral variety per play. */
  function noise({ buf = 'white', type = 'bandpass', f0 = 1000, f1 = null, q = 1,
                   dur = .1, gain = .3, attack = .004, delay = 0, rate = null, echo = .12 }) {
    if (!ensure()) return;
    const t0 = now() + delay;
    const src = ctx.createBufferSource();
    src.buffer = buf === 'brown' ? brownBuf : whiteBuf;
    src.loop = true;
    src.playbackRate.value = rate ?? rand(.94, 1.06);
    const f = ctx.createBiquadFilter(); f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(Math.max(20, f0), t0);
    if (f1) f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(.0001, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + Math.min(attack, dur * .5));
    g.gain.exponentialRampToValueAtTime(.0001, t0 + dur);
    src.connect(f); f.connect(g); g.connect(master);
    if (echo > 0 && echoIn) sendEcho(g, echo);
    src.start(t0); src.stop(t0 + dur + .05);
  }

  /** Pitched voice with the same fast-attack/exp-decay envelope; optional
      cents detune and a taming lowpass for buzzy waveforms. */
  function tone({ f0 = 440, f1 = null, type = 'sine', dur = .15, gain = .2,
                  attack = .004, delay = 0, detune = 0, echo = .12, lp = 0 }) {
    if (!ensure()) return;
    const t0 = now() + delay;
    const o = ctx.createOscillator(); o.type = type; o.detune.value = detune;
    o.frequency.setValueAtTime(f0, t0);
    if (f1) o.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(.0001, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + Math.min(attack, dur * .5));
    g.gain.exponentialRampToValueAtTime(.0001, t0 + dur);
    let head = o;
    if (lp > 0) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp; o.connect(f); head = f; }
    head.connect(g); g.connect(master);
    if (echo > 0 && echoIn) sendEcho(g, echo);
    o.start(t0); o.stop(t0 + dur + .05);
  }

  /** ONE distinct fan: rising-then-falling formant voice with breath
      noise, random pitch/contour/stereo position — a staggered handful of
      these reads as individuals, not a wall. */
  function cheerVoice({ delay = 0, gain = .055, hi = false, dry = false }) {
    if (!ensure()) return;
    const t0 = now() + delay;
    const fp = (hi ? rand(600, 860) : rand(400, 600)) * rand(.92, 1.08);
    const dur = rand(.32, .55);
    const o = ctx.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(fp * .7, t0);
    o.frequency.linearRampToValueAtTime(fp, t0 + dur * .42);        // "he-e-EY"
    o.frequency.linearRampToValueAtTime(fp * .78, t0 + dur);        // falling tail
    const F1 = ctx.createBiquadFilter(); F1.type = 'bandpass'; F1.frequency.value = rand(620, 780); F1.Q.value = 4;
    const F2 = ctx.createBiquadFilter(); F2.type = 'bandpass'; F2.frequency.value = rand(1150, 1650); F2.Q.value = 6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(.0001, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + .03);
    g.gain.setValueAtTime(gain, t0 + dur * .55);
    g.gain.exponentialRampToValueAtTime(.0001, t0 + dur + .04);
    const br = ctx.createBufferSource(); br.buffer = whiteBuf; br.loop = true; br.playbackRate.value = rand(.95, 1.05);
    const bf = ctx.createBiquadFilter(); bf.type = 'bandpass'; bf.frequency.value = 1800; bf.Q.value = .8;
    const bg = ctx.createGain(); bg.gain.value = gain * .4;
    o.connect(F1); o.connect(F2); F1.connect(g); F2.connect(g);
    br.connect(bf); bf.connect(bg); bg.connect(g);
    let out = g;
    if (ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = rand(-.7, .7); g.connect(p); out = p; }
    out.connect(master);
    sendEcho(g, dry ? .07 : .22);   // dry = close mic: the rustic FOD bleacher
    o.start(t0); o.stop(t0 + dur + .1); br.start(t0); br.stop(t0 + dur + .1);
  }

  /** Fan whistle: sine with an upward bend and a gentle vibrato LFO. */
  function whistle({ delay = 0, gain = .02 }) {
    if (!ensure()) return;
    const t0 = now() + delay;
    const f0 = rand(1750, 2300), dur = rand(.35, .55);
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.linearRampToValueAtTime(f0 * 1.07, t0 + dur);
    const lfo = ctx.createOscillator(); lfo.frequency.value = rand(5.5, 7);
    const la = ctx.createGain(); la.gain.value = f0 * .014;
    lfo.connect(la); la.connect(o.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(.0001, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + .04);
    g.gain.exponentialRampToValueAtTime(.0001, t0 + dur);
    o.connect(g); g.connect(master); sendEcho(g, .25);
    o.start(t0); o.stop(t0 + dur + .05); lfo.start(t0); lfo.stop(t0 + dur + .05);
  }

  /** Applause patch: slow-swelling clap-coloured bandpass wash. With
      `dist:true` it plays darker, slower and further back in the echo —
      the faint-distant-applause texture Field of Dreams gets. */
  function applause({ delay = 0, dur = 1.4, gain = .045, dist = false }) {
    noise({
      dur, f0: rand(950, 1250) * (dist ? .85 : 1), f1: rand(1150, 1450) * (dist ? .85 : 1),
      q:.45, gain, attack: dur * .3, delay,
      rate: dist ? .86 : rand(.96, 1.04), echo: dist ? .3 : .16,
    });
  }

  function swellTo(v, t) {
    crowdGain.gain.cancelScheduledValues(now());
    crowdGain.gain.setValueAtTime(crowdGain.gain.value, now());
    crowdGain.gain.linearRampToValueAtTime(v, now() + t);
  }

  return {
    unlock() { ensure(); if (ctx && ctx.state === 'suspended') ctx.resume(); },

    /* ---- BAT CRACK · exit-vel-scaled wood hit -------------------------
       A  impact transient : ultra-short highpass click (the "crack" edge)
       B  crack band       : 3-4 kHz bandpass snap, brighter when ev rises
       C  wood body        : detuned modal knock partials (~196/388/672 Hz)
       D  handle thump     : 170->66 Hz sine drop gives physical weight
       E  barrel ring      : faint delayed ring, only on solid contact     */
    crack(ev) {
      const v  = Math.max(.18, Math.min(1.05, ev / 45));
      const br = .75 + .4 * v;                    // brightness follows ev
      const dt = rand(-70, 70);                   // per-hit detune, cents
      noise({ dur:.012, type:'highpass', f0:4200 * br, gain:.42 * v, attack:.001, echo:0 });
      noise({ dur:.022, type:'bandpass', f0:rand(3050, 3500) * br, q:.8, gain:.52 * v, attack:.001, echo:.32 });
      [[196, .32, .05], [388, .17, .038], [672, .10, .026]].forEach(([fq, gg, dd]) =>
        tone({ f0:fq, f1:fq * .82, type:'triangle', dur:dd * (.8 + .5 * v), gain:gg * v, attack:.001, detune:dt, echo:.12 }));
      tone({ f0:rand(162, 178), f1:66, type:'sine', dur:.07, gain:.36 * v, attack:.001, echo:.06 });
      if (v > .4) tone({ f0:rand(1080, 1260), type:'sine', dur:.1, gain:.055 * v, delay:.01, detune:dt, echo:.45 });
    },

    /* ---- GLOVE POP · leather catch ------------------------------------
       A  leather snap : 1.4-1.8 kHz bandpass smack (the "pop")
       B  mid smack    : wider 750 Hz band, the mitt leather flap
       C  hand body    : 150->64 Hz sine drop behind the snap
       D  pocket air   : dark brown lowpass puff, the dead-ball cushion
       E  creak tail   : faint high scuff 35 ms in (leather stretch)      */
    pop() {
      const r = rand(.93, 1.07);
      noise({ dur:.03,  f0:rand(1400, 1750) * r, q:1.1, gain:.48, attack:.001, echo:.14 });
      noise({ dur:.05,  f0:750 * r, q:1,   gain:.34, attack:.002, echo:.1 });
      tone ({ f0:150 * r, f1:64 * r, dur:.085, gain:.28, attack:.001, echo:.05 });
      noise({ buf:'brown', dur:.09, type:'lowpass', f0:430, gain:.3, attack:.002, echo:0 });
      noise({ dur:.06, f0:2600, q:2, gain:.045, delay:.035, attack:.004, echo:.1 });
    },

    /* ---- PITCH WHOOSH · rising air, seam whistle ----------------------*/
    whoosh() {
      const d = rand(.3, .38);
      noise({ dur:d, f0:340, f1:2050, q:1,   gain:.12, attack:d * .5, echo:.15 }); // broad air
      noise({ dur:d, f0:850, f1:2500, q:5,   gain:.05, attack:d * .55, echo:.1 }); // seam whistle
      noise({ buf:'brown', dur:d, type:'lowpass', f0:400, f1:900, gain:.05, attack:d * .5, echo:0 });
    },

    /* ---- DIRT THUD · ball bounce, impact-scaled -----------------------
       body puff + sub drop, plus grit scatter on hard hops              */
    thud(v) {
      const vv = Math.max(.06, Math.min(1, v));
      noise({ buf:'brown', dur:.06 + .06 * vv, type:'lowpass', f0:rand(240, 320), gain:.1 + .3 * vv, attack:.002, echo:.06 });
      tone ({ f0:rand(95, 115), f1:rand(44, 52), dur:.1, gain:.28 * vv, attack:.001, echo:0 });
      if (vv > .35) noise({ dur:.03, type:'highpass', f0:2800, gain:.05 * vv, attack:.001, echo:0 });
    },

    /* ---- UI TICK · soft blip + micro click ----------------------------*/
    tick() {
      tone ({ f0:1720 * rand(.98, 1.02), type:'triangle', dur:.032, gain:.07, attack:.002, echo:0 });
      noise({ dur:.008, type:'highpass', f0:6000, gain:.045, attack:.001, echo:0 });
    },

    /* legacy plain calls now route through the richer umpire bark */
    strike()   { SND.umpCall('strike'); },
    ballCall() { SND.umpCall('ball');   },

    /* ---- CROWD REACTION · park-gated, two tiers ------------------------
       BIG moment (v >= .5, or handed off from cheerBuild — HRs, runs
       scored, double plays): Oracle gets a FULL stadium roar — layered
       washes, sub surge, massed voices, whistles, heavy patter; FOD's
       whole little bleacher wakes up. Moderate (v < .5 routine plays):
       a mid-scale Oracle lift with a few fans; FOD stays to its handful. */
    roar(v = 1) {
      if (!ensure()) return;
      const big = v >= .5 || bigNext; bigNext = false;
      v = Math.max(.2, Math.min(2, v));
      holdUntil = Date.now() + 3400 + 2000 * v;
      crowdGain.gain.exponentialRampToValueAtTime(bedMid(), now() + 2.8 + 2 * v);
      if (isFod()) {
        /* the tiny rustic bleacher behind home plate: a dozen-odd period
           fans, CLOSE and human — distinct voices + pairs of hands */
        swellTo(big ? .045 : .034, .25);
        const nv = 3 + ((Math.random() * 2) | 0) + (big ? 1 : 0);      // 3-6 of the dozen
        for (let i = 0; i < nv; i++)
          cheerVoice({ delay:i * rand(.09, .2) + rand(0, .1),
                       gain:(.05 + .02 * Math.min(1, v)) * rand(.85, 1.15),
                       hi:Math.random() < .4, dry:true });
        const nc = 3 + ((Math.random() * 3) | 0) + (big ? 2 : 0);      // few pairs of hands
        for (let i = 0; i < nc; i++) {
          const t = rand(.05, 1.2);
          noise({ dur:.04, f0:rand(1050, 1350), q:1, gain:(.045 + .015 * Math.min(1, v)) * (big ? 1 : .8),
                  delay:t, attack:.001, echo:.06 });
          noise({ dur:.035, f0:rand(1150, 1450), q:1, gain:.03 * (big ? 1 : .8),
                  delay:t + rand(.05, .08), attack:.001, echo:.06 });
        }
        return;
      }
      if (big) {
        /* FULL STADIUM ROAR — layered, genuinely loud, long tail */
        swellTo(Math.min(.42, .08 + .2 * Math.min(v, 2)), .2);
        noise({ dur:1.6 + .8 * v, f0:650, f1:1350, q:.5, gain:.14 * Math.min(1.4, v), attack:.15, echo:.28 });          // main wash
        noise({ dur:1.4 + .7 * v, f0:900, f1:1750, q:.7, gain:.1 * Math.min(1.4, v), attack:.2, delay:.07, echo:.24 }); // bright layer
        noise({ buf:'brown', dur:1.3, type:'lowpass', f0:160, f1:420, gain:.13 * Math.min(1.4, v), attack:.12, echo:.1 }); // sub surge
        const nv = 6 + ((Math.random() * 3) | 0) + (v > 1.4 ? 2 : 0);  // massed individuals on top
        for (let i = 0; i < nv; i++)
          cheerVoice({ delay:i * rand(.06, .14) + rand(0, .12),
                       gain:(.05 + .02 * Math.min(1, v)) * rand(.75, 1.2), hi:Math.random() < .35 });
        whistle({ delay:rand(.15, .5) });
        if (Math.random() < .6) whistle({ delay:rand(.5, .9), gain:.016 });
        for (let i = 0; i < 7; i++)                                    // heavy clap patter
          noise({ dur:.05, f0:rand(1000, 1400), q:.9, gain:.04 * Math.min(1, v), delay:rand(.05, 1.2), attack:.001, echo:.15 });
        return;
      }
      /* moderate routine-play lift */
      swellTo(Math.min(.15, .05 + .09 * v), .25);
      noise({ dur:1.1, f0:750, f1:1400, q:.55, gain:.055 * Math.min(1, v) + .015, attack:.18, echo:.2 });
      const nv = 3 + ((Math.random() * 2) | 0);
      for (let i = 0; i < nv; i++)
        cheerVoice({ delay:i * rand(.1, .22) + rand(0, .15),
                     gain:(.035 + .015 * Math.min(1, v)) * rand(.8, 1.15), hi:Math.random() < .3 });
      for (let i = 0; i < 4; i++)
        noise({ dur:.05, f0:rand(1000, 1400), q:.9, gain:.028, delay:rand(.05, .8), attack:.001, echo:.15 });
    },

    /* ---- CROWD GROAN · bad events --------------------------------------
       oracle: small murmur dip + a couple of disappointed low voices.
       fod:    near-silence — a period crowd barely reacts at all.        */
    groan() {
      if (!ensure()) return;
      holdUntil = Date.now() + 2600;
      if (isFod()) {
        swellTo(.011, .5);
        crowdGain.gain.exponentialRampToValueAtTime(bedMid(), now() + 2);
        return;
      }
      swellTo(.024, .35);
      const nv = 1 + ((Math.random() * 2) | 0);                        // 1-2 voices
      for (let i = 0; i < nv; i++)
        tone({ f0:rand(240, 300), f1:rand(170, 205), type:'sawtooth',
               dur:.32, gain:.03, attack:.03, delay:i * rand(.12, .25), detune:rand(-40, 40), echo:.15, lp:900 });
      crowdGain.gain.exponentialRampToValueAtTime(bedMid(), now() + 2.2);
    },

    /* ---- CHEER BUILD · same timing contract as ever (roar lands at
            1180 ms); flags that incoming roar as a BIG moment ----------*/
    cheerBuild(v = 1) {
      if (!ensure()) return;
      bigNext = true;
      if (isFod()) {
        swellTo(.03, 1.1);
        cheerVoice({ delay:.3, gain:.045, dry:true });                 // a fan senses it coming
        noise({ dur:.5, f0:1100, q:1, gain:.035, delay:.55, attack:.15, echo:.06 }); // hands start up
      } else {
        swellTo(Math.min(.09, .05 + .02 * v), 1.1);
        applause({ dur:1.15, gain:.05 * Math.min(1, v) });
        cheerVoice({ delay:.35, gain:.04 });                           // first fan rises early
      }
      holdUntil = Date.now() + 1300;
      setTimeout(() => SND.roar(v), 1180);
    },

    /* ---- CHANT · modern rally behaviour — Oracle Park only -------------*/
    chant() {
      if (!ensure() || isFod()) return;              // period-quiet in Iowa
      const n = 3 + (Math.random() < .5 ? 1 : 0);
      for (let i = 0; i < n; i++) {
        const t = Math.max(0, i * .5 + rand(-.05, .05));
        noise({ dur:.045, f0:rand(950, 1200), q:.9, gain:.065, delay:t, attack:.002, echo:.18 });
        noise({ dur:.04,  f0:rand(1050, 1300), q:.9, gain:.04, delay:t + .07, attack:.002, echo:.15 });
        noise({ buf:'brown', dur:.13, type:'lowpass', f0:300, gain:.045, delay:t, attack:.004, echo:.05 });
      }
    },

    /* ---- BAT SETTLE · aluminium rattle, inharmonic metallic partials --*/
    batTick() {
      [0, .05].forEach((d, i) => {
        const base = (i ? 1950 : 2320) * rand(.97, 1.03);
        [[1, .028, 'triangle'], [1.505, .016, 'square'], [2.61, .009, 'sine']].forEach(([m, gg, tp]) =>
          tone({ f0:base * m, dur:.028, type:tp, gain:gg, delay:d, echo:0, lp:i ? 5200 : 6800 }));
      });
    },

    /* ---- CLEATS · a full footfall run, not one scuff: 6-8 alternating
            steps at sprint cadence, tapered in/out, L/R colour varied.
            Called once per run-start, so scheduling here is safe. -------*/
    cleats() {
      if (!ensure()) return;
      const n = 6 + ((Math.random() * 3) | 0);
      const cadence = rand(.27, .31);
      for (let i = 0; i < n; i++) {
        const t = i * cadence * rand(.93, 1.07);
        const tap = Math.sin(Math.PI * (i + .5) / n);           // fade edges
        const side = i % 2 ? .92 : 1.08;                        // L/R timbre
        noise({ dur:rand(.045, .07), f0:rand(2300, 2900) * side, q:.7, gain:.042 * tap, delay:t, attack:.003, echo:.12 });
        if (i % 2 === 0)
          noise({ buf:'brown', dur:.05, type:'lowpass', f0:rand(210, 270), gain:.026 * tap, delay:t, attack:.002, echo:0 });
      }
    },

    /* ---- UMPIRE CALL · vowel-barked voice: sawtooth pitch contour run
            through two parallel formant bands, breath onset, slight
            random pitch per game-event so calls never clone -------------*/
    umpCall(kind) {
      if (!ensure()) return;
      const bark = ({ delay = 0, fa, fb, dur, gain }) => {
        const r = rand(.94, 1.06), t0 = now() + delay;
        const o = ctx.createOscillator(); o.type = 'sawtooth';
        o.frequency.setValueAtTime(fa * r, t0);
        o.frequency.exponentialRampToValueAtTime(fb * r, t0 + dur);
        const F1 = ctx.createBiquadFilter(); F1.type = 'bandpass'; F1.frequency.value = rand(600, 700); F1.Q.value = 5;
        const F2 = ctx.createBiquadFilter(); F2.type = 'bandpass'; F2.frequency.value = rand(1050, 1350); F2.Q.value = 7;
        const g = ctx.createGain();
        g.gain.setValueAtTime(.0001, t0);
        g.gain.linearRampToValueAtTime(gain, t0 + .012);
        g.gain.exponentialRampToValueAtTime(.0001, t0 + dur + .03);
        o.connect(F1); o.connect(F2); F1.connect(g); F2.connect(g); g.connect(master);
        sendEcho(g, .12);
        o.start(t0); o.stop(t0 + dur + .08);
      };
      const breath = d => noise({ dur:.02, f0:1500, q:1, gain:.045, delay:d, attack:.001, echo:0 });
      if (kind === 'ball') {
        breath(0);
        bark({ fa:295, fb:242, dur:.21, gain:.115 });
      } else {
        breath(0);    bark({ fa:330, fb:255, dur:.11, gain:.13 });
        breath(.155); bark({ fa:315, fb:200, dur:.14, gain:.115, delay:.155 });
      }
    },

    /* ---- ORGAN · tamed-square arpeggio over a soft root ---------------*/
    organ() {
      [[523, 0], [659, .17], [784, .34], [1046, .51]].forEach(([f, d]) => {
        tone({ f0:f, dur:.16, type:'square', gain:.06, delay:d, echo:.35, lp:1900 });
        tone({ f0:f * 2, dur:.14, type:'triangle', gain:.025, delay:d, echo:.3 });
      });
      tone({ f0:262, dur:.5, type:'triangle', gain:.05, echo:.25, lp:900 });
    },
  };
})();

addEventListener('pointerdown', () => SND.unlock());
