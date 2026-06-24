// T76 / V52 — pooled GIB system. Flung faceted meat chunks: a sever (or a strong hit) throws low-poly
// lumps that arc out under gravity + air drag, tumble, LAND on the floor, settle (kill motion + flatten),
// then dry + shrink away. Sibling to the blood spray (bloodView) but SOLID matter — a lit
// MeshStandardMaterial with a LOW emissive so the dark gore reads on the dark floor (B6) without glowing
// like a pickup. Pure-view (V2): driven by the drained VisualEvent stream, never feeds the sim back.
// Pooled + HARD-capped ring buffer, no per-frame allocation (V24).
//
// Our triggers (no death/corpseblast VisualEvent exists yet): partDetached → a clutch of limb chunks at the
// last impact point (sever-driven); a hitReaction whose energy clears the fleck threshold also flings a few
// small flecks (hit-driven). The death-clutch burst is DEFERRED until a positioned death VisualEvent exists
// (needs T70 — noted in the report; tie T54/T55).
//
// r184 binding-safe (V33): solid IcosahedronGeometry + a PRE-CREATED instanceColor InstancedBufferAttribute.

import {
  InstancedMesh,
  IcosahedronGeometry,
  MeshStandardMaterial,
  Object3D,
  Color,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  type Scene,
} from 'three';
import type { AnatomyRegion, VisualEvent } from '../../game/core/contracts/events';
import { resolve } from '../../config/spec';
import { renderingConfig } from '../../config/domains/rendering';
import type { QualityTier } from '../../config/types';
import type { ResourceRegistry } from '../engine/resources';
import { regionImpactHeight, type RegionHeights } from './combatFeedback';
import type { GoreType } from './bloodView';

// Dark dried-gore matter — pulled darker than the blood DECAL so a wet chunk reads as a solid lump.
const GIB_BLOOD = new Color(0.42, 0.035, 0.035);
const GIB_ICHOR = new Color(0.22, 0.34, 0.06);
const GIB_BURNED = new Color(0.1, 0.09, 0.09);

function gibColor(kind: GoreType): Color {
  // Structured to mirror bloodView.goreColor so ichor/burned plug in once archetype rides the event.
  return kind === 'ichor' ? GIB_ICHOR : kind === 'burned' ? GIB_BURNED : GIB_BLOOD;
}

export interface GibSettings {
  readonly poolSize: number;
  readonly gravityMps2: number;
  readonly airDragPerSecond: number;
  readonly floorYMeters: number;
  readonly settleLifeSeconds: number;
  readonly fadeFraction: number;
  readonly baseSizeMeters: number;
  readonly severChunkCountMin: number;
  readonly severChunkCountMax: number;
  readonly severSpeedMinMps: number;
  readonly severSpeedMaxMps: number;
  readonly severUpwardMps: number;
  readonly spinMaxRadPerSec: number;
  readonly hitFleckEnergyThreshold: number;
  readonly hitFleckCount: number;
  readonly hitFleckChance: number;
  readonly severLimbDropChance: number;
  readonly severLimbSizeMul: number;
  readonly emissiveIntensity: number;
  readonly distantSimplifyMeters: number;
  readonly distantCountScale: number;
  readonly regionHeights: RegionHeights;
}

export function resolveGibSettings(tier: QualityTier): GibSettings {
  return {
    poolSize: resolve(renderingConfig.gibPoolSize, tier),
    gravityMps2: resolve(renderingConfig.gibGravityMps2, tier),
    airDragPerSecond: resolve(renderingConfig.gibAirDragPerSecond, tier),
    floorYMeters: resolve(renderingConfig.gibFloorYMeters, tier),
    settleLifeSeconds: resolve(renderingConfig.gibSettleLifeSeconds, tier),
    fadeFraction: resolve(renderingConfig.gibFadeFraction, tier),
    baseSizeMeters: resolve(renderingConfig.gibBaseSizeMeters, tier),
    severChunkCountMin: resolve(renderingConfig.gibSeverChunkCountMin, tier),
    severChunkCountMax: resolve(renderingConfig.gibSeverChunkCountMax, tier),
    severSpeedMinMps: resolve(renderingConfig.gibSeverSpeedMinMps, tier),
    severSpeedMaxMps: resolve(renderingConfig.gibSeverSpeedMaxMps, tier),
    severUpwardMps: resolve(renderingConfig.gibSeverUpwardMps, tier),
    spinMaxRadPerSec: resolve(renderingConfig.gibSpinMaxRadPerSec, tier),
    hitFleckEnergyThreshold: resolve(renderingConfig.gibHitFleckEnergyThreshold, tier),
    hitFleckCount: resolve(renderingConfig.gibHitFleckCount, tier),
    hitFleckChance: resolve(renderingConfig.gibHitFleckChance, tier),
    severLimbDropChance: resolve(renderingConfig.gibSeverLimbDropChance, tier),
    severLimbSizeMul: resolve(renderingConfig.gibSeverLimbSizeMul, tier),
    emissiveIntensity: resolve(renderingConfig.gibEmissiveIntensity, tier),
    distantSimplifyMeters: resolve(renderingConfig.gibDistantSimplifyMeters, tier),
    distantCountScale: resolve(renderingConfig.gibDistantCountScale, tier),
    regionHeights: {
      head: resolve(renderingConfig.combatGoreHeightHeadMeters, tier),
      torso: resolve(renderingConfig.combatGoreHeightTorsoMeters, tier),
      leg: resolve(renderingConfig.combatGoreHeightLegMeters, tier),
    },
  };
}

export interface GibIngestContext {
  readonly cameraX: number;
  readonly cameraY: number;
  readonly cameraZ: number;
  readonly goreIntensity: number;
  readonly reduceFlashes: boolean;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

let _seed = 0x1234567 >>> 0;
function rnd(): number {
  _seed = (_seed * 1664525 + 1013904223) >>> 0;
  return _seed / 0xffffffff;
}

/**
 * Pure gib simulation (no GPU — unit-tested). One SoA ring-buffer pool: airborne chunks arc + tumble until
 * they land, then settle and dry/shrink out, recycling past their lifetime. The view reads the public SoA
 * each frame to lay out the instanced batch.
 */
export class GibSim {
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly vz: Float32Array;
  readonly rx: Float32Array;
  readonly ry: Float32Array;
  readonly rz: Float32Array;
  readonly size: Float32Array; // CURRENT (fade-applied) display scale, recomputed each update
  readonly cr: Float32Array; // CURRENT (dim-applied) display colour
  readonly cg: Float32Array;
  readonly cb: Float32Array;
  private readonly spinX: Float32Array;
  private readonly spinY: Float32Array;
  private readonly spinZ: Float32Array;
  private readonly baseSize: Float32Array; // spawn scale the fade window shrinks from
  private readonly r: Float32Array;
  private readonly g: Float32Array;
  private readonly b: Float32Array;
  private readonly restY: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly grounded: Uint8Array;
  private head = 0;
  private _count = 0;

  // hitReaction is position-less; pair with the following bloodSpray (emission order, like combatFeedback).
  private pending: { energy: number; dirX: number; dirZ: number; region: AnatomyRegion } | null = null;
  private lastImpact: { x: number; y: number; z: number } | null = null;

  constructor(readonly settings: GibSettings) {
    const N = Math.max(1, settings.poolSize);
    this.px = new Float32Array(N);
    this.py = new Float32Array(N);
    this.pz = new Float32Array(N);
    this.vx = new Float32Array(N);
    this.vy = new Float32Array(N);
    this.vz = new Float32Array(N);
    this.rx = new Float32Array(N);
    this.ry = new Float32Array(N);
    this.rz = new Float32Array(N);
    this.size = new Float32Array(N);
    this.cr = new Float32Array(N);
    this.cg = new Float32Array(N);
    this.cb = new Float32Array(N);
    this.spinX = new Float32Array(N);
    this.spinY = new Float32Array(N);
    this.spinZ = new Float32Array(N);
    this.baseSize = new Float32Array(N);
    this.r = new Float32Array(N);
    this.g = new Float32Array(N);
    this.b = new Float32Array(N);
    this.restY = new Float32Array(N);
    this.age = new Float32Array(N);
    this.life = new Float32Array(N);
    this.grounded = new Uint8Array(N);
  }

  /** Number of live (non-expired) chunks currently rendered. */
  get count(): number {
    return this._count;
  }

  consume(events: readonly VisualEvent[], ctx: GibIngestContext): void {
    if (ctx.goreIntensity <= 0) {
      this.pending = null;
      return; // V29 — fully suppressed.
    }
    for (const e of events) {
      switch (e.kind) {
        case 'hitReaction':
          this.pending = { energy: clamp01(e.energy), dirX: e.dirX, dirZ: e.dirZ, region: e.region };
          break;
        case 'bloodSpray': {
          // Hit-driven flecks: a strong hit (energy over the threshold) also flings a few small chunks.
          const dist = Math.hypot(e.x - ctx.cameraX, e.y - ctx.cameraY, e.z - ctx.cameraZ);
          const energy = this.pending ? this.pending.energy : 1;
          const region = this.pending ? this.pending.region : 'torsoUpper';
          const y = e.y + regionImpactHeight(region, this.settings.regionHeights);
          this.lastImpact = { x: e.x, y, z: e.z };
          // Hit-driven flecks are the EXCEPTION, not every shot: roll a low probability (hit energy saturates
          // at 1, so the energy threshold alone fired on every hit — that was the "gibs every shot" bug). Most
          // shots just spray blood; occasionally a tiny meat fleck. Flecks are small (sizeMul 0.35).
          if (energy >= this.settings.hitFleckEnergyThreshold && this.settings.hitFleckCount > 0 && rnd() < this.settings.hitFleckChance) {
            this.burst(e.x, y, e.z, gibColor('blood'), this.settings.hitFleckCount, dist, ctx, 0.35);
          }
          this.pending = null;
          break;
        }
        case 'partDetached': {
          // Sever-driven (V17): a small spray of meat bits at the cut, PLUS — with a decent probability — the
          // limb itself DROPS as a flung limb chunk that lands + bleeds (the bloodView partDetached spray is the
          // bleed), instead of just vanishing. Otherwise the part silently disappears (clean amputation).
          const at = this.lastImpact;
          if (at) {
            const dist = Math.hypot(at.x - ctx.cameraX, at.y - ctx.cameraY, at.z - ctx.cameraZ);
            const s = this.settings;
            const span = Math.max(0, s.severChunkCountMax - s.severChunkCountMin);
            const count = s.severChunkCountMin + Math.round(rnd() * span);
            this.burst(at.x, at.y, at.z, gibColor('blood'), count, dist, ctx, 0.6);
            if (rnd() < s.severLimbDropChance) {
              this.burst(at.x, at.y, at.z, gibColor('blood'), 1, dist, ctx, s.severLimbSizeMul); // the limb itself
            }
          }
          break;
        }
        case 'soundEmitted':
          break;
      }
    }
  }

  /** Throw `baseCount` chunks from (x,y,z). `sizeMul` scales the chunk volume (flecks are small). */
  private burst(x: number, y: number, z: number, color: Color, baseCount: number, dist: number, ctx: GibIngestContext, sizeMul: number): void {
    const s = this.settings;
    let n = baseCount;
    if (dist > s.distantSimplifyMeters) n = Math.max(1, Math.round(n * s.distantCountScale)); // V8
    if (ctx.reduceFlashes) n = Math.max(1, Math.round(n * 0.5)); // V29 — thin counts
    n = Math.max(1, Math.round(n * ctx.goreIntensity)); // V29 — intensity scales volume
    for (let k = 0; k < n; k++) {
      const i = this.head;
      this.head = (this.head + 1) % this.px.length; // ring buffer — oldest recycled (V24)
      if (this._count < this.px.length) this._count++;
      const chunk = (0.55 + rnd() * rnd() * 1.1) * sizeMul;
      const sz = s.baseSizeMeters * chunk;
      const ang = rnd() * Math.PI * 2;
      const sp = s.severSpeedMinMps + rnd() * (s.severSpeedMaxMps - s.severSpeedMinMps);
      this.px[i] = x;
      this.py[i] = y;
      this.pz[i] = z;
      this.vx[i] = Math.cos(ang) * sp;
      this.vy[i] = s.severUpwardMps * (0.6 + 0.6 * rnd());
      this.vz[i] = Math.sin(ang) * sp;
      this.rx[i] = rnd() * Math.PI * 2;
      this.ry[i] = rnd() * Math.PI * 2;
      this.rz[i] = rnd() * Math.PI * 2;
      this.spinX[i] = (rnd() - 0.5) * 2 * s.spinMaxRadPerSec;
      this.spinY[i] = (rnd() - 0.5) * 2 * s.spinMaxRadPerSec;
      this.spinZ[i] = (rnd() - 0.5) * 2 * s.spinMaxRadPerSec;
      this.baseSize[i] = sz;
      this.size[i] = sz;
      this.restY[i] = s.floorYMeters + sz * 0.5; // sit the lump ON the floor, not sunk in
      this.age[i] = 0;
      this.life[i] = s.settleLifeSeconds * (0.8 + rnd() * 0.5); // stagger so a clutch doesn't vanish in lockstep
      this.grounded[i] = 0;
      this.r[i] = color.r;
      this.g[i] = color.g;
      this.b[i] = color.b;
      this.cr[i] = color.r;
      this.cg[i] = color.g;
      this.cb[i] = color.b;
    }
  }

  update(dt: number): void {
    if (dt < 0) throw new Error(`dt must be non-negative, got ${dt}`);
    const s = this.settings;
    const drag = Math.max(0, 1 - s.airDragPerSecond * dt);
    for (let i = 0; i < this._count; i++) {
      this.age[i]! += dt;
      const t = this.age[i]! / this.life[i]!;
      if (t >= 1) {
        this.size[i] = 0; // expired — collapse it (ring buffer reuses the slot)
        continue;
      }
      if (!this.grounded[i]) {
        this.vy[i]! -= s.gravityMps2 * dt;
        this.vx[i]! *= drag;
        this.vz[i]! *= drag;
        this.px[i]! += this.vx[i]! * dt;
        this.py[i]! += this.vy[i]! * dt;
        this.pz[i]! += this.vz[i]! * dt;
        this.rx[i]! += this.spinX[i]! * dt;
        this.ry[i]! += this.spinY[i]! * dt;
        this.rz[i]! += this.spinZ[i]! * dt;
        if (this.py[i]! <= this.restY[i]!) {
          this.py[i] = this.restY[i]!;
          this.grounded[i] = 1;
          this.vx[i] = this.vy[i] = this.vz[i] = 0;
          this.spinX[i] = this.spinY[i] = this.spinZ[i] = 0;
          this.rx[i] = Math.PI / 2; // lie a facet flattish against the ground
        }
      }
      // Hold full size until the fade window, then shrink + dim out (dries/sinks away).
      let scale = this.baseSize[i]!;
      let dim = 1;
      if (t > 1 - s.fadeFraction) {
        const k = (1 - t) / s.fadeFraction;
        scale *= k;
        dim = 0.6 + 0.4 * k;
      }
      this.size[i] = Math.max(0.0001, scale);
      this.cr[i] = this.r[i]! * dim;
      this.cg[i] = this.g[i]! * dim;
      this.cb[i] = this.b[i]! * dim;
    }
  }

  /** Number of currently live (non-collapsed) chunks — the rendered subset of the ring fill. */
  get liveCount(): number {
    let live = 0;
    for (let i = 0; i < this._count; i++) if (this.size[i]! > 0.0001) live++;
    return live;
  }
}

/**
 * Thin GPU view: owns ONE InstancedMesh of faceted chunks and mirrors the pure GibSim state onto it each
 * frame. Lit MeshStandardMaterial with a low emissive (B6) + a pre-created instanceColor (V33). Every
 * resource is tracked for disposal (V24).
 */
export class GibView {
  readonly sim: GibSim;
  private readonly mesh: InstancedMesh;
  private readonly dummy = new Object3D();
  private readonly tmp = new Color();

  constructor(settings: GibSettings, registry: ResourceRegistry) {
    this.sim = new GibSim(settings);
    // Sharp faceted lump (detail 0 = 20 flat faces) → reads as torn meat, not a ball. Unit radius; the
    // per-instance scale carries the real chunk size.
    const geo = registry.track(new IcosahedronGeometry(1, 0), 'geometry', 'gib.geo');
    const mat = registry.track(
      new MeshStandardMaterial({
        name: 'gib.material',
        roughness: 0.92,
        metalness: 0.05,
        emissive: new Color(0x3a0805),
        emissiveIntensity: settings.emissiveIntensity,
      }),
      'material',
      'gib.material',
    );
    this.mesh = registry.track(new InstancedMesh(geo, mat, Math.max(1, settings.poolSize)), 'buffer', 'gib.mesh');
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    const buf = new Float32Array(this.mesh.count * 3).fill(1);
    this.mesh.instanceColor = new InstancedBufferAttribute(buf, 3);
    this.mesh.instanceColor.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.count = 0;
  }

  attachTo(scene: Scene | Object3D): void {
    scene.add(this.mesh);
  }

  consume(events: readonly VisualEvent[], ctx: GibIngestContext): void {
    this.sim.consume(events, ctx);
  }

  update(dt: number): void {
    this.sim.update(dt);
    const sim = this.sim;
    let live = 0;
    for (let i = 0; i < sim.count; i++) {
      if (sim.size[i]! <= 0.0001) continue; // expired/collapsed — skip
      this.dummy.position.set(sim.px[i]!, sim.py[i]!, sim.pz[i]!);
      this.dummy.rotation.set(sim.rx[i]!, sim.ry[i]!, sim.rz[i]!);
      this.dummy.scale.setScalar(sim.size[i]!);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(live, this.dummy.matrix);
      this.mesh.setColorAt(live, this.tmp.setRGB(sim.cr[i]!, sim.cg[i]!, sim.cb[i]!));
      live++;
    }
    this.mesh.count = live;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}
