// FIRE visuals (RENDER lane). The sim's destruction layer carries a COMPACT burning-cell set (T26/V18) and
// the runtime's "Ignite route" emits a `fireIgnited` WorldEvent per ignited structural cell — but nothing
// drew it. FireView is the missing render: a pooled, capped, additive billboard FLAME column at each burning
// cell, a small pool of flickering point LIGHTS at the strongest nearby fires, and an optional faint drifting
// SMOKE billboard above strong fires. It is a pure visual MIRROR of the burning-cell set (V2/V3) — it never
// touches the sim; the burning cells + their world positions are fed in each frame (the wire reads them from
// the drained `fireIgnited` WorldEvents + maps the structural cell to a world position via the scene's
// `navCellForStructuralCell` + `cellCenter`, the same mapping blockScene uses).
//
//   FLAMES — ONE InstancedMesh of additive billboard quads. Each fire stacks a few jittered quads (volume);
//            quad count + size + brightness scale with the fire's (ramped) burn intensity. Per-quad flicker
//            (independent phase) animates scale + brightness over time so the fire reads as alive. A vertical
//            colour gradient is baked into the quad (deep-orange BASE → yellow TIP); per-instance brightness
//            (intensity * flicker) rides on top via a pre-created instanceColor (r184 binding-safe, V33).
//            Distance-simplified (V8): full quad count near the camera, down to a single quad far away, culled
//            past a cull radius.
//   LIGHTS — a small, hard-capped pool of warm PointLights placed at the N STRONGEST nearby fires (V8/V22) so
//            fire dynamically lights the scene at night; each light's intensity flickers.
//   SMOKE  — (optional, cheap) a faint dark billboard drifting up above fires past a strength threshold (V56).
//
// reduce-flashes (V29) damps the flame + light flicker amplitude. Gore-intensity is irrelevant to fire. All
// GPU resources are tracked in the ResourceRegistry for disposal (V24). The pure FireField holds NO GPU
// objects so the add/remove/flicker/intensity/cap/simplify logic is unit-tested without a renderer.
//
// V56 depth policy: flames use AdditiveBlending with depthWrite OFF + depthTest ON (default) so walls/roofs
// correctly OCCLUDE the fire — never depthTest:false. Smoke uses NormalBlending with the same depth policy.

import {
  AdditiveBlending,
  Color,
  DynamicDrawUsage,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshBasicMaterial,
  NormalBlending,
  Object3D,
  PlaneGeometry,
  PointLight,
  type Scene,
} from 'three';
import { resolve } from '../../config/spec';
import { renderingConfig } from '../../config/domains/rendering';
import type { QualityTier } from '../../config/types';
import type { ResourceRegistry } from '../engine/resources';

interface RGB {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface FireSettings {
  readonly maxCells: number;
  readonly quadsPerCell: number;
  readonly quadCapacity: number;
  readonly baseSizeMeters: number;
  readonly sizeJitter: number;
  readonly quadRiseMeters: number;
  readonly quadJitterMeters: number;
  readonly baseHeightMeters: number;
  readonly baseOpacity: number;
  readonly growthPerSec: number;
  readonly flickerHz: number;
  readonly flickerAmount: number;
  readonly reduceFlashesFlicker: number;
  readonly colorHot: RGB;
  readonly colorTip: RGB;
  readonly simplifyStartMeters: number;
  readonly simplifyEndMeters: number;
  readonly cullDistanceMeters: number;
  readonly lightCount: number;
  readonly lightIntensity: number;
  readonly lightRangeMeters: number;
  readonly lightHeightMeters: number;
  readonly lightFlickerAmount: number;
  readonly lightColor: RGB;
  readonly smokeEnabled: boolean;
  readonly smokeIntensityThreshold: number;
  readonly smokeSizeMeters: number;
  readonly smokeOpacity: number;
  readonly smokeRiseMeters: number;
  readonly smokeColor: RGB;
}

/** Resolve every FireView tunable for a tier (V4 — no magic numbers in this module). */
export function resolveFireSettings(tier: QualityTier): FireSettings {
  return {
    maxCells: resolve(renderingConfig.fireMaxCells, tier),
    quadsPerCell: resolve(renderingConfig.fireQuadsPerCell, tier),
    quadCapacity: resolve(renderingConfig.fireQuadCapacity, tier),
    baseSizeMeters: resolve(renderingConfig.fireBaseSizeMeters, tier),
    sizeJitter: resolve(renderingConfig.fireSizeJitter, tier),
    quadRiseMeters: resolve(renderingConfig.fireQuadRiseMeters, tier),
    quadJitterMeters: resolve(renderingConfig.fireQuadJitterMeters, tier),
    baseHeightMeters: resolve(renderingConfig.fireBaseHeightMeters, tier),
    baseOpacity: resolve(renderingConfig.fireBaseOpacity, tier),
    growthPerSec: resolve(renderingConfig.fireGrowthPerSec, tier),
    flickerHz: resolve(renderingConfig.fireFlickerHz, tier),
    flickerAmount: resolve(renderingConfig.fireFlickerAmount, tier),
    reduceFlashesFlicker: resolve(renderingConfig.fireReduceFlashesFlicker, tier),
    colorHot: {
      r: resolve(renderingConfig.fireColorHotR, tier),
      g: resolve(renderingConfig.fireColorHotG, tier),
      b: resolve(renderingConfig.fireColorHotB, tier),
    },
    colorTip: {
      r: resolve(renderingConfig.fireColorTipR, tier),
      g: resolve(renderingConfig.fireColorTipG, tier),
      b: resolve(renderingConfig.fireColorTipB, tier),
    },
    simplifyStartMeters: resolve(renderingConfig.fireSimplifyStartMeters, tier),
    simplifyEndMeters: resolve(renderingConfig.fireSimplifyEndMeters, tier),
    cullDistanceMeters: resolve(renderingConfig.fireCullDistanceMeters, tier),
    lightCount: resolve(renderingConfig.fireLightCount, tier),
    lightIntensity: resolve(renderingConfig.fireLightIntensity, tier),
    lightRangeMeters: resolve(renderingConfig.fireLightRangeMeters, tier),
    lightHeightMeters: resolve(renderingConfig.fireLightHeightMeters, tier),
    lightFlickerAmount: resolve(renderingConfig.fireLightFlickerAmount, tier),
    lightColor: {
      r: resolve(renderingConfig.fireLightColorR, tier),
      g: resolve(renderingConfig.fireLightColorG, tier),
      b: resolve(renderingConfig.fireLightColorB, tier),
    },
    smokeEnabled: resolve(renderingConfig.fireSmokeEnabled, tier),
    smokeIntensityThreshold: resolve(renderingConfig.fireSmokeIntensityThreshold, tier),
    smokeSizeMeters: resolve(renderingConfig.fireSmokeSizeMeters, tier),
    smokeOpacity: resolve(renderingConfig.fireSmokeOpacity, tier),
    smokeRiseMeters: resolve(renderingConfig.fireSmokeRiseMeters, tier),
    smokeColor: {
      r: resolve(renderingConfig.fireSmokeColorR, tier),
      g: resolve(renderingConfig.fireSmokeColorG, tier),
      b: resolve(renderingConfig.fireSmokeColorB, tier),
    },
  };
}

/** A burning cell the FireView should draw flames/light for (cell id + world position of its centre). */
export interface FireIgnition {
  readonly cell: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** A fire the light pool selected this frame (already offset to the light height). */
export interface FireLightPick {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly intensity: number;
  readonly phase: number;
}

/** Per-fire render state. Per-quad phase/jitter/size are precomputed once so update() is allocation-free. */
interface FireEntry {
  readonly cell: number;
  x: number;
  y: number;
  z: number;
  /** Visual burn intensity (0..1) — ramps up after ignition (catch-in) and scales count/size/brightness. */
  intensity: number;
  readonly phase: Float32Array;
  readonly jitterX: Float32Array;
  readonly jitterZ: Float32Array;
  readonly rise: Float32Array;
  readonly sizeFactor: Float32Array;
  /** Stable flicker phase for this fire's point light + smoke billboard. */
  readonly lightPhase: number;
  readonly smokeJitterX: number;
  readonly smokeJitterZ: number;
}

// Render-local PRNG — VISUAL only, never touches the sim or determinism (V2/V3).
let _seed = 0x1f123bb5 >>> 0;
function rnd(): number {
  _seed = (_seed * 1664525 + 1013904223) >>> 0;
  return _seed / 0xffffffff;
}

const TWO_PI = Math.PI * 2;
const SPAWN_INTENSITY = 0.2; // a freshly-lit cell starts faint, then ramps to full (mirrors fire.ts intensity 0.2)

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Pure fire field (no GPU — unit-tested). Owns the set of burning cells, ramps each one's visual intensity,
 * advances a shared flicker clock, and answers the per-frame render queries (flicker multiplier, flame
 * size/brightness, distance-simplified quad count, and the N-strongest light selection). The view mirrors it
 * onto GPU instances. Never allocates per frame beyond the light-selection result.
 */
export class FireField {
  readonly settings: FireSettings;
  private readonly fires = new Map<number, FireEntry>();
  private _time = 0;
  private _reduceFlashes = false;

  constructor(settings: FireSettings) {
    this.settings = settings;
  }

  /** Live burning-cell count (number of flame columns). */
  get count(): number {
    return this.fires.size;
  }

  /** Shared flicker clock (seconds). Advances every update — drives the per-quad/light flicker. */
  get time(): number {
    return this._time;
  }

  get reduceFlashes(): boolean {
    return this._reduceFlashes;
  }

  /** Read-only view of the live fires (the GPU view iterates this each frame). */
  entries(): readonly FireEntry[] {
    return [...this.fires.values()];
  }

  /** V29 — damp the flame/light flicker amplitude when the player has reduce-flashes enabled. */
  setReduceFlashes(v: boolean): void {
    this._reduceFlashes = v;
  }

  /**
   * Add a flame column for each newly-burning cell (idempotent per cell — a re-reported ignition just refreshes
   * its world position). Capped at `maxCells` (V24): once full, further ignitions are dropped (the sim keeps
   * the truth; this is only the visual budget).
   */
  ingest(ignitions: readonly FireIgnition[]): void {
    for (const ig of ignitions) {
      const existing = this.fires.get(ig.cell);
      if (existing) {
        existing.x = ig.x;
        existing.y = ig.y;
        existing.z = ig.z;
        continue;
      }
      if (this.fires.size >= this.settings.maxCells) continue;
      this.fires.set(ig.cell, this.makeEntry(ig));
    }
  }

  /** Remove flame columns whose cell is no longer burning (driven by the sim's current burning set). */
  retain(isBurning: (cell: number) => boolean): void {
    for (const cell of this.fires.keys()) {
      if (!isBurning(cell)) this.fires.delete(cell);
    }
  }

  /** Advance the flicker clock and ramp each fire's intensity toward full (catch-in). */
  update(dt: number): void {
    if (dt < 0 || Number.isNaN(dt)) throw new Error(`dt must be >= 0, got ${dt}`);
    this._time += dt;
    const step = this.settings.growthPerSec * dt;
    for (const f of this.fires.values()) {
      if (f.intensity < 1) f.intensity = Math.min(1, f.intensity + step);
    }
  }

  /** Effective flicker amplitude after reduce-flashes damping (V29). */
  private effectiveAmount(base: number): number {
    return this._reduceFlashes ? base * this.settings.reduceFlashesFlicker : base;
  }

  /** Per-quad flame flicker multiplier (>0): an animated wobble around 1 from the shared clock + the quad phase. */
  flameFlicker(phase: number): number {
    const amt = this.effectiveAmount(this.settings.flickerAmount);
    return 1 + amt * Math.sin(TWO_PI * this.settings.flickerHz * this._time + phase);
  }

  /** Point-light flicker multiplier (>0) — same clock, separate (usually gentler) amplitude. */
  lightFlicker(phase: number): number {
    const amt = this.effectiveAmount(this.settings.lightFlickerAmount);
    return Math.max(0, 1 + amt * Math.sin(TWO_PI * this.settings.flickerHz * this._time + phase));
  }

  /** Flame quad world size (m): scales with burn intensity, the quad's size jitter, and the flicker. */
  flameSize(intensity: number, sizeFactor: number, flicker: number): number {
    return this.settings.baseSizeMeters * sizeFactor * (0.4 + 0.6 * clamp01(intensity)) * Math.max(0, flicker);
  }

  /** Per-instance flame brightness (0..~1): scales with burn intensity, base opacity, and the flicker. */
  flameBrightness(intensity: number, flicker: number): number {
    return clamp01(clamp01(intensity) * this.settings.baseOpacity * Math.max(0, flicker));
  }

  /**
   * Distance-simplified quad count for a fire (V8): full count (scaled by intensity) within the simplify-start
   * radius, falling linearly to a single quad by simplify-end, and 0 (culled) past the cull radius.
   */
  quadCountFor(intensity: number, distance: number): number {
    if (distance >= this.settings.cullDistanceMeters) return 0;
    const base = Math.max(1, Math.round(this.settings.quadsPerCell * clamp01(intensity)));
    const { simplifyStartMeters: start, simplifyEndMeters: end } = this.settings;
    let t = 0;
    if (distance > start) t = end > start ? clamp01((distance - start) / (end - start)) : 1;
    return Math.max(1, Math.round(base * (1 - t)));
  }

  /**
   * Select the N STRONGEST fires for the light pool (V8/V22). Ranked by burn intensity (brighter fires light
   * the scene), ties broken by nearness to the camera; fires past the cull radius are excluded. Returns at
   * most `lightCount` picks, already lifted to the light height.
   */
  selectLights(cameraX: number, cameraZ: number): FireLightPick[] {
    const cap = this.settings.cullDistanceMeters * this.settings.cullDistanceMeters;
    const scored: { entry: FireEntry; d2: number }[] = [];
    for (const f of this.fires.values()) {
      const dx = f.x - cameraX;
      const dz = f.z - cameraZ;
      const d2 = dx * dx + dz * dz;
      if (d2 > cap) continue;
      scored.push({ entry: f, d2 });
    }
    scored.sort((a, b) => (b.entry.intensity - a.entry.intensity) || (a.d2 - b.d2));
    const n = Math.min(this.settings.lightCount, scored.length);
    const out: FireLightPick[] = [];
    for (let i = 0; i < n; i++) {
      const e = scored[i]!.entry;
      out.push({ x: e.x, y: e.y + this.settings.lightHeightMeters, z: e.z, intensity: e.intensity, phase: e.lightPhase });
    }
    return out;
  }

  private makeEntry(ig: FireIgnition): FireEntry {
    const q = this.settings.quadsPerCell;
    const phase = new Float32Array(q);
    const jitterX = new Float32Array(q);
    const jitterZ = new Float32Array(q);
    const rise = new Float32Array(q);
    const sizeFactor = new Float32Array(q);
    for (let i = 0; i < q; i++) {
      phase[i] = rnd() * TWO_PI;
      jitterX[i] = (rnd() * 2 - 1) * this.settings.quadJitterMeters;
      jitterZ[i] = (rnd() * 2 - 1) * this.settings.quadJitterMeters;
      // Stack upward by index with a little per-quad slop so the column is uneven.
      rise[i] = i * this.settings.quadRiseMeters + (rnd() * 2 - 1) * this.settings.quadRiseMeters * 0.3;
      sizeFactor[i] = 1 + (rnd() * 2 - 1) * this.settings.sizeJitter;
    }
    return {
      cell: ig.cell,
      x: ig.x,
      y: ig.y,
      z: ig.z,
      intensity: SPAWN_INTENSITY,
      phase,
      jitterX,
      jitterZ,
      rise,
      sizeFactor,
      lightPhase: rnd() * TWO_PI,
      smokeJitterX: (rnd() * 2 - 1) * this.settings.quadJitterMeters,
      smokeJitterZ: (rnd() * 2 - 1) * this.settings.quadJitterMeters,
    };
  }
}

/**
 * GPU fire view: ONE additive flame InstancedMesh, an optional NormalBlending smoke InstancedMesh, and a hard
 * pool of warm PointLights, all mirroring the pure FireField each frame. r184 binding-safe (V33): solid
 * PlaneGeometry with a baked vertical colour gradient + a PRE-CREATED instanceColor binding (per-instance
 * brightness), dynamic-usage matrices. Every resource is tracked in the registry for disposal (V24).
 */
export class FireView {
  readonly field: FireField;
  private readonly flameMesh: InstancedMesh;
  private readonly flameMat: MeshBasicMaterial;
  private readonly smokeMesh: InstancedMesh | null;
  private readonly smokeMat: MeshBasicMaterial | null;
  private readonly lights: PointLight[] = [];
  private readonly dummy = new Object3D();
  private readonly tmpColor = new Color();

  constructor(settings: FireSettings, registry: ResourceRegistry) {
    this.field = new FireField(settings);

    // ---- FLAMES: a vertical quad with a baked deep-orange (base) → yellow (tip) gradient. Per-instance
    // brightness rides on top via instanceColor; the additive blend makes overlapping quads glow.
    const flameGeo = registry.track(new PlaneGeometry(1, 1, 1, 1), 'geometry', 'fire.flameGeo');
    const pos = flameGeo.getAttribute('position');
    const colors = new Float32Array(pos.count * 3);
    const hot = settings.colorHot;
    const tip = settings.colorTip;
    for (let i = 0; i < pos.count; i++) {
      // PlaneGeometry is centred at the origin; y in [-0.5, +0.5]. Map the top half toward the tip colour.
      const t = clamp01(pos.getY(i) + 0.5);
      colors[i * 3] = hot.r + (tip.r - hot.r) * t;
      colors[i * 3 + 1] = hot.g + (tip.g - hot.g) * t;
      colors[i * 3 + 2] = hot.b + (tip.b - hot.b) * t;
    }
    flameGeo.setAttribute('color', new Float32BufferAttribute(colors, 3));

    this.flameMat = registry.track(
      new MeshBasicMaterial({
        name: 'fire.flame',
        vertexColors: true,
        toneMapped: false,
        transparent: true,
        opacity: settings.baseOpacity,
        blending: AdditiveBlending,
        depthWrite: false, // V56 — depthTest stays ON (default) so walls/roofs occlude flames; never depthTest:false
      }),
      'material',
      'fire.flameMat',
    );
    const flameCap = Math.max(1, settings.quadCapacity);
    this.flameMesh = registry.track(new InstancedMesh(flameGeo, this.flameMat, flameCap), 'buffer', 'fire.flameMesh');
    this.flameMesh.instanceMatrix.setUsage(DynamicDrawUsage);
    const flameColors = new Float32Array(flameCap * 3).fill(1);
    this.flameMesh.instanceColor = new InstancedBufferAttribute(flameColors, 3);
    this.flameMesh.instanceColor.setUsage(DynamicDrawUsage);
    this.flameMesh.frustumCulled = false; // columns are scattered + animated; cheap capped count
    this.flameMesh.renderOrder = 5; // after opaque + decals/rain; an additive overlay
    this.flameMesh.count = 0;

    // ---- SMOKE (optional): a faint dark billboard above strong fires. One per fire, capped at maxCells.
    if (settings.smokeEnabled) {
      const smokeGeo = registry.track(new PlaneGeometry(1, 1, 1, 1), 'geometry', 'fire.smokeGeo');
      this.smokeMat = registry.track(
        new MeshBasicMaterial({
          name: 'fire.smoke',
          color: new Color(settings.smokeColor.r, settings.smokeColor.g, settings.smokeColor.b),
          toneMapped: false,
          transparent: true,
          opacity: settings.smokeOpacity,
          blending: NormalBlending, // dark smoke darkens — NOT additive (V56)
          depthWrite: false, // V56 — depthTest ON so structure occludes smoke
        }),
        'material',
        'fire.smokeMat',
      );
      const smokeCap = Math.max(1, settings.maxCells);
      this.smokeMesh = registry.track(new InstancedMesh(smokeGeo, this.smokeMat, smokeCap), 'buffer', 'fire.smokeMesh');
      this.smokeMesh.instanceMatrix.setUsage(DynamicDrawUsage);
      this.smokeMesh.frustumCulled = false;
      this.smokeMesh.renderOrder = 4; // under the flames
      this.smokeMesh.count = 0;
    } else {
      this.smokeMesh = null;
      this.smokeMat = null;
    }

    // ---- LIGHTS: a hard pool (V8/V22). PointLights are Disposable (Light.dispose) so they're registry-tracked.
    for (let i = 0; i < settings.lightCount; i++) {
      const light = registry.track(
        new PointLight(
          new Color(settings.lightColor.r, settings.lightColor.g, settings.lightColor.b),
          0,
          settings.lightRangeMeters,
        ),
        'other',
        `fire.light.${i}`,
      );
      light.castShadow = false; // cheap fill light; the sun owns shadows
      light.visible = false;
      this.lights.push(light);
    }
  }

  /** Add the flame/smoke meshes + light pool to the scene graph (parent owns membership; registry owns disposal). */
  attachTo(scene: Scene | Object3D): void {
    scene.add(this.flameMesh);
    if (this.smokeMesh) scene.add(this.smokeMesh);
    for (const l of this.lights) scene.add(l);
  }

  /**
   * Drive the fire visuals from the CURRENT burning-cell set. `ignitions` carries the cells reported burning
   * this frame (newly-ignited get a flame column); `isBurning` is the live truth used to retire columns whose
   * cell stopped burning. `cameraPos` is the camera EYE (drives the billboard facing). `focusPos` is the
   * look-at / player position used for distance-simplify + light selection — NOT the eye, which in the
   * near-ortho tactical rig sits ~100m+ away and would cull every fire. Pure mirror of the sim (V2/V3).
   */
  update(
    dt: number,
    ignitions: readonly FireIgnition[],
    isBurning: (cell: number) => boolean,
    cameraPos: { readonly x: number; readonly y: number; readonly z: number },
    focusPos: { readonly x: number; readonly y: number; readonly z: number },
    reduceFlashes: boolean,
  ): void {
    this.field.setReduceFlashes(reduceFlashes);
    this.field.ingest(ignitions);
    this.field.retain(isBurning);
    this.field.update(dt);

    const s = this.field.settings;

    // ---- flames ----
    let fi = 0;
    let smoke = 0;
    const flameCapacity = (this.flameMesh.instanceColor as InstancedBufferAttribute).count;
    for (const f of this.field.entries()) {
      const dx = f.x - focusPos.x;
      const dy = f.y + s.baseHeightMeters - focusPos.y;
      const dz = f.z - focusPos.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const quads = this.field.quadCountFor(f.intensity, dist);
      if (quads <= 0) continue;
      // Cylindrical billboard: rotate the upright quad around Y so its +Z face turns toward the camera.
      const yaw = Math.atan2(cameraPos.x - f.x, cameraPos.z - f.z);
      for (let q = 0; q < quads && fi < flameCapacity; q++) {
        const flick = this.field.flameFlicker(f.phase[q]!);
        const size = this.field.flameSize(f.intensity, f.sizeFactor[q]!, flick);
        const bright = this.field.flameBrightness(f.intensity, flick);
        this.dummy.position.set(
          f.x + f.jitterX[q]!,
          f.y + s.baseHeightMeters + f.rise[q]! + size * 0.5,
          f.z + f.jitterZ[q]!,
        );
        this.dummy.rotation.set(0, yaw, 0);
        this.dummy.scale.set(size, size, 1);
        this.dummy.updateMatrix();
        this.flameMesh.setMatrixAt(fi, this.dummy.matrix);
        this.tmpColor.setRGB(bright, bright, bright);
        this.flameMesh.setColorAt(fi, this.tmpColor);
        fi++;
      }

      // ---- smoke: one faint drifting billboard above sufficiently strong fires ----
      if (this.smokeMesh && f.intensity >= s.smokeIntensityThreshold && smoke < this.smokeMesh.instanceMatrix.count) {
        // slow upward drift cycling within one smokeRise span (no per-frame allocation)
        const driftT = (this.field.time * 0.2 + f.lightPhase) % 1;
        const sm = s.smokeSizeMeters * (0.7 + 0.3 * f.intensity);
        this.dummy.position.set(
          f.x + f.smokeJitterX + driftT * 0.3,
          f.y + s.baseHeightMeters + s.smokeRiseMeters + driftT * s.smokeRiseMeters,
          f.z + f.smokeJitterZ,
        );
        this.dummy.rotation.set(0, yaw, 0);
        this.dummy.scale.set(sm, sm, 1);
        this.dummy.updateMatrix();
        this.smokeMesh.setMatrixAt(smoke, this.dummy.matrix);
        smoke++;
      }
    }
    this.flameMesh.count = fi;
    this.flameMesh.visible = fi > 0;
    this.flameMesh.instanceMatrix.needsUpdate = true;
    if (this.flameMesh.instanceColor) this.flameMesh.instanceColor.needsUpdate = true;
    if (this.smokeMesh) {
      this.smokeMesh.count = smoke;
      this.smokeMesh.visible = smoke > 0;
      this.smokeMesh.instanceMatrix.needsUpdate = true;
    }

    // ---- lights: place the pool on the N strongest nearby fires; flicker their intensity ----
    const picks = this.field.selectLights(focusPos.x, focusPos.z);
    for (let i = 0; i < this.lights.length; i++) {
      const light = this.lights[i]!;
      const pick = picks[i];
      if (!pick) {
        light.visible = false;
        light.intensity = 0;
        continue;
      }
      light.visible = true;
      light.position.set(pick.x, pick.y, pick.z);
      light.intensity = s.lightIntensity * pick.intensity * this.field.lightFlicker(pick.phase);
    }
  }
}
