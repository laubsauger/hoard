// T149 — procedural VOLUMETRIC fire (dialed-down from the three.js webgpu_volume_fire example: a raymarched box,
// but a PROCEDURAL noise field rather than a GPU fluid sim, so several can run + tier by distance). Each hero
// fire is a Box mesh with a MeshBasicNodeMaterial whose colorNode RAYMARCHES the box in world space, sampling a
// time-scrolled value-noise FBM shaped into a flame (vertical taper + radial falloff), mapping a temperature ramp
// to emissive fire colour, accumulated additively. Per-fire uniforms (base/centre/height/radius) let the same
// shader serve any fire; the view assigns the nearest M pools to a small mesh pool. Render-only (V2).
//
// TSL caveat: the `.d.ts` doesn't type `Fn([args])`, so the noise/ramp helpers are plain JS functions that COMPOSE
// node ops inline (typed `any` — the node graph is built at call time). Authored against three r184 `three/tsl`.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { AdditiveBlending, BoxGeometry, FrontSide, Mesh, MeshBasicNodeMaterial } from 'three/webgpu';
import { Fn, Loop, cameraPosition, floor, fract, mix, positionWorld, smoothstep, uniform, vec3 } from 'three/tsl';

/** Per-fire uniforms — UniformNodes (usable directly as shader nodes AND `.value`-settable each frame). */
export interface VolumetricFireUniforms {
  readonly time: { value: number };
  readonly baseY: { value: number };
  readonly centreX: { value: number };
  readonly centreZ: { value: number };
  readonly height: { value: number };
  readonly radius: { value: number };
  readonly strength: { value: number };
}

/** 1D hash of a 3D cell corner. */
function hash31(p: any): any {
  return fract(p.dot(vec3(127.1, 311.7, 74.7)).sin().mul(43758.5453));
}

/** 3D value noise, trilinearly interpolated (the FBM building block — no texture needed). */
function valueNoise(p: any): any {
  const i: any = floor(p);
  const f: any = fract(p);
  const u: any = f.mul(f).mul(f.mul(-2.0).add(3.0)); // smootherstep weights
  const x00 = mix(hash31(i.add(vec3(0, 0, 0))), hash31(i.add(vec3(1, 0, 0))), u.x);
  const x10 = mix(hash31(i.add(vec3(0, 1, 0))), hash31(i.add(vec3(1, 1, 0))), u.x);
  const x01 = mix(hash31(i.add(vec3(0, 0, 1))), hash31(i.add(vec3(1, 0, 1))), u.x);
  const x11 = mix(hash31(i.add(vec3(0, 1, 1))), hash31(i.add(vec3(1, 1, 1))), u.x);
  return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z);
}

/** Three-octave FBM (more detail in the flame). */
function fbm(p: any): any {
  return valueNoise(p)
    .mul(0.55)
    .add(valueNoise(p.mul(2.03).add(17.3)).mul(0.3))
    .add(valueNoise(p.mul(4.11).add(41.7)).mul(0.15));
}

/** Black → deep red → orange → yellow → near-white, by normalized temperature t. */
function fireRamp(t: any): any {
  const c = mix(vec3(0.05, 0.0, 0.0), vec3(0.85, 0.12, 0.0), smoothstep(0.0, 0.35, t)).toVar();
  c.assign(mix(c, vec3(1.0, 0.5, 0.06), smoothstep(0.35, 0.62, t)));
  c.assign(mix(c, vec3(1.0, 0.88, 0.38), smoothstep(0.62, 0.86, t)));
  c.assign(mix(c, vec3(1.0, 0.98, 0.85), smoothstep(0.86, 1.0, t)));
  return c;
}

const STEPS = 16;

/** Build one volumetric-fire material + its per-fire uniforms (set each frame by the view). */
export function buildVolumetricFireMaterial(): { material: MeshBasicNodeMaterial; uniforms: VolumetricFireUniforms } {
  const time = uniform(0);
  const baseY = uniform(0);
  const centreX = uniform(0);
  const centreZ = uniform(0);
  const height = uniform(2.4);
  const radius = uniform(0.9);
  const strength = uniform(1);

  const material = new MeshBasicNodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.blending = AdditiveBlending;
  material.side = FrontSide; // march from the front faces inward
  material.toneMapped = true;

  material.colorNode = (Fn as any)(() => {
    const rd = positionWorld.sub(cameraPosition).normalize();
    const stepLen = (height as any).mul(2.4).div(STEPS); // march ~2.4× the height through the box
    const pos = (positionWorld as any).toVar();
    const acc = (vec3(0) as any).toVar();

    Loop(STEPS, () => {
      const h = (pos as any).y.sub(baseY).div(height).clamp(0, 1); // 0 base → 1 tip
      const rx = (pos as any).x.sub(centreX);
      const rz = (pos as any).z.sub(centreZ);
      const rad = rx.mul(rx).add(rz.mul(rz)).sqrt().div(radius);

      // domain warp: sway the sample horizontally by a low-freq noise of height+time → wispy licking motion.
      const sway = (valueNoise(vec3((pos as any).y.mul(0.7).sub((time as any).mul(2.0)), 4.0, 0.0)) as any).sub(0.5).mul(0.9);
      // scrolled FBM in a vertically-stretched, swayed sample space (taller flame features, rising fast)
      const samp = vec3(
        (pos as any).x.mul(1.7).add(sway),
        (pos as any).y.mul(0.9).sub((time as any).mul(2.2)),
        (pos as any).z.mul(1.7).add(sway.mul(0.7)),
      );
      const n = fbm(samp);
      const taper = smoothstep(1.05, 0.15, h); // strong at the base, gone at the tip
      const narrow = smoothstep(1.0, 0.0, rad.add(h.mul(0.55))); // column narrows with height
      // SHARPEN: square the shaped density so flame tongues read crisp, not a soft haze
      const raw = n.mul(taper).mul(narrow).sub(0.16).max(0.0);
      const density = raw.mul(raw).mul(2.4).mul(strength);

      // temperature: a HOT inner core at the base, cooling toward the tip; noise adds licks of heat
      const core = smoothstep(0.5, 0.0, rad).mul(h.oneMinus());
      const temp = h.oneMinus().mul(0.5).add(core.mul(0.35)).add(n.mul(0.22)).clamp(0, 1);
      acc.addAssign(fireRamp(temp).mul(density).mul(0.95));

      pos.addAssign(rd.mul(stepLen));
    });

    return acc;
  })();

  return {
    material,
    uniforms: { time, baseY, centreX, centreZ, height, radius, strength } as unknown as VolumetricFireUniforms,
  };
}

/** A box mesh carrying a volumetric-fire material (one hero fire). */
export function buildVolumetricFireMesh(): { mesh: Mesh; uniforms: VolumetricFireUniforms } {
  const { material, uniforms } = buildVolumetricFireMaterial();
  const geo = new BoxGeometry(1, 1, 1);
  const mesh = new Mesh(geo, material);
  mesh.frustumCulled = false;
  mesh.visible = false;
  return { mesh, uniforms };
}
