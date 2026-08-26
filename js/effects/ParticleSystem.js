/* =====================================================================
   ParticleSystem.js — pooled sprite particles: dust, contact sparks, trail
   Part of the Lincoln Red Gauntlet engine · js/effects/
===================================================================== */
import * as THREE from 'three';
import { scene, camera } from '../core/SceneManager.js';
import { rand, clamp } from '../utils/MathUtils.js';
import { softCircleTexture } from '../utils/MathUtils.js';

function makePool(n, base) {
  const pool = [];
  for (let i = 0; i < n; i++) {
    const s = new THREE.Sprite(base.clone()); s.visible = false; scene.add(s);
    pool.push({ s, life:0, max:1, vel:new THREE.Vector3(), grow:0 });
  }
  return {
    n, i:0, grav:3, op0:.8,
    spawn(pos, o = {}) {
      const p = pool[this.i = (this.i + 1) % n];
      p.s.visible = true; p.s.position.copy(pos); p.life = p.max = o.life || .7;
      p.vel.set(rand(-1,1), rand(0,1), rand(-1,1)).normalize().multiplyScalar(o.speed || 2);
      p.vel.y += o.up ?? 1;
      p.s.scale.setScalar(o.size || .3); p.grow = o.grow || 0;
      p.s.material.opacity = o.opacity ?? this.op0;
      if (o.color) p.s.material.color.set(o.color);
    },
    update(dt) {
      for (const p of pool) {
        if (!p.s.visible) continue;
        p.life -= dt;
        if (p.life <= 0) { p.s.visible = false; continue; }
        p.vel.y -= this.grav * dt;
        p.s.position.addScaledVector(p.vel, dt);
        if (p.s.position.y < .05) { p.s.position.y = .05; p.vel.y *= -.3; p.vel.x *= .8; p.vel.z *= .8; }
        const t = 1 - p.life / p.max;
        /* Near-lens fade: a puff crossing the tracker cam otherwise reads as
           a giant brown blob swallowing the frame (dolly cams fly close).
           6 m ramp keeps mid-field dust honest while anything inside ~2 m of
           the lens is fully invisible. */
        const near = p.s.position.distanceTo(camera.position);
        p.s.material.opacity = (1 - t) * this.op0 * clamp((near - 2) / 4, 0, 1);
        if (p.grow) p.s.scale.addScalar(p.grow * dt);
      }
    }
  };
}

export const FX = {
  dust : makePool(90, new THREE.SpriteMaterial({ map:softCircleTexture('rgba(196,170,124,1)','rgba(196,170,124,0)'), transparent:true, depthWrite:false })),
  spark: makePool(60, new THREE.SpriteMaterial({ map:softCircleTexture('rgba(255,240,170,1)','rgba(255,200,60,0)'), transparent:true, depthWrite:false, blending:THREE.AdditiveBlending })),
  trail: makePool(50, new THREE.SpriteMaterial({ map:softCircleTexture('rgba(255,255,255,.9)','rgba(255,255,255,0)'), transparent:true, depthWrite:false })),
};
FX.dust.grav = 2.2; FX.spark.grav = 7; FX.trail.grav = 0; FX.trail.op0 = .5;

/** Burst of dust kicked up by a ground/ball impact. */
FX.dust.spawnCluster = (pos, n) => {
  for (let i = 0; i < n; i++)
    FX.dust.spawn(pos, { life:rand(.4,.9), size:rand(.25,.6), speed:rand(1,3), up:rand(.5,2), grow:1.1 });
};

export function updateParticles(dt) {
  FX.dust.update(dt); FX.spark.update(dt); FX.trail.update(dt);
}
