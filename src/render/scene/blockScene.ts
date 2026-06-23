// T38/T87 — the district render scene: the place the direct Three.js engine finally DRAWS the assembled
// systems. Iterates `buildingsOf(scene)` so a LARGE multi-building suburban district renders as MANY separate
// houses — each with its own perimeter walls, interior floor slab, shaped roof, windows + door, deterministic
// clapboard/decay variation (V26) and a PER-BUILDING cutaway (only the building the player occupies fades —
// neighbours stay opaque, V59). Suburban ground paint + instanced district dressing (fences/cars/trees/ivy/
// debris) are drawn over the base ground. An InstancedMesh crowd is fed by the SoA via the existing packing
// path, and sun/moon + ambient lighting are driven by the sim clock. All GPU resources are tracked in the
// injected ResourceRegistry for explicit disposal (V24). React never reads world state back through this (V1).

import {
  AmbientLight,
  BoxGeometry,
  type BufferGeometry,
  type Camera,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  Euler,
  Float32BufferAttribute,
  Fog,
  Group,
  HemisphereLight,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  CapsuleGeometry,
  Quaternion,
  Scene,
  SpotLight,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { resolve } from '../../config/spec';
import { resolveDomain } from '../../config/registry';
import { worldConfig } from '../../config/domains/world';
import { structuresConfig } from '../../config/domains/structures';
import { playerConfig } from '../../config/domains/player';
import { lightingConfig } from '../../config/domains/lighting';
import { weatherConfig } from '../../config/domains/weather';
import { renderingConfig } from '../../config/domains/rendering';
import { perceptionConfig } from '../../config/domains/perception';
import { postFXConfig } from '../../config/domains/postFX';
import { shadowsConfig } from '../../config/domains/shadows';
import type { QualityTier } from '../../config/types';
import type { ResourceRegistry } from '../engine/resources';
import type { ToneMappingMode } from '../engine/renderer';
import { Crowd, resolveCrowdSettings } from '../crowd/crowd';
import type { VisionCull } from '../crowd/visionCull';
import { instantaneousReveal, PerceptionMemory, type RevealParams } from '../crowd/perceptionMemory';
import { ZombieState } from '../../game/simulation';
import type { DebugFlags } from '../../diagnostics/flags';
import {
  resolveSurfaceVisibility,
  resolveVisibilitySettings,
  resolveCutawayDepthSettings,
  resolveCutawayDepthOffset,
  wallFacesCamera,
  exteriorWallOccludesPlayer,
  type OcclusionContext,
  type CutawayDepthSettings,
  type VecXZ,
} from '../world/visibility';
import { resolveFogDistances, approach, resolveToneExposure, interiorExposure } from '../lighting/lighting';
import {
  CombatFeedbackSystem,
  CombatFeedbackView,
  resolveCombatFeedbackSettings,
} from '../effects/combatFeedback';
import type { VisualEvent } from '../../game/core/contracts/events';
import { computeSkyState } from './sky';
import { resolveRenderAccessibility, type RenderAccessibility } from '../accessibility';
import type { GameRuntime } from '../../game/runtime';
import {
  buildingsOf,
  lootableContainerCells,
  authorHouseStyle,
  resolveHouseVariation,
  windowState,
  roofHoles,
  hash01,
  doorAxis,
  hasLineOfSight,
  type GroundKind,
  type BuildingFootprint,
  type HouseStyle,
  type CellRect,
} from '../../game/scene';
import { makeRoofGeometry } from './houseGeometry';
import type { NavGrid } from '../../game/navigation';

/** Full-strength accessibility (the reference experience) — the default until the player opts into a reduction. */
const DEFAULT_ACCESSIBILITY: RenderAccessibility = resolveRenderAccessibility({
  goreIntensity: 1,
  outlineStrength: 1,
  targetHighlightStrength: 1,
  cameraShakeScale: 1,
  reduceFlashes: false,
  motionReduction: false,
});

/**
 * A roof / upper-wall surface that fades for the cutaway (V20/V58). Each surface is tagged with the
 * `buildingIndex` that owns it so ONLY the building the player currently occupies fades (per-building cutaway,
 * V59) — neighbours stay opaque so the district reads solid. An upper-wall group also carries the shared
 * outward horizontal normal of its panels so the DIRECTIONAL cutaway (V58) fades only the side(s) turned
 * toward the camera; the far walls stay to read enclosure. `outwardNormal` is null for the roof.
 */
interface FadeSurface {
  readonly object: Object3D;
  readonly material: MeshStandardMaterial;
  readonly kind: 'roof' | 'upperWall';
  readonly outwardNormal: VecXZ | null;
  readonly heightMeters: number;
  readonly buildingIndex: number;
  /** World-XZ centre of the surface (on the wall plane) — used by the OUTSIDE-WALL cutaway (V62). */
  readonly centerX: number;
  readonly centerZ: number;
  opacity: number;
}

const PLAYER_BASE_EMISSIVE = 0.4; // authored player-rim glow at full outline strength (scaled by V29 setting)
// Authored cool-grey fog/atmosphere hue (relative channel weights); luminance is lifted off near-black to
// the configured floor so the far plane never reads as a black void (B5). Slightly warmer/brighter by day.
const FOG_HUE = { r: 0.62, g: 0.68, b: 0.78 } as const;
const FOG_DAY_LUMINANCE_BONUS = 0.06;

export class BlockScene {
  readonly scene = new Scene();
  readonly crowd: Crowd;

  private runtime: GameRuntime;
  private readonly tier: QualityTier;
  private readonly registry: ResourceRegistry;
  /** Live accessibility params (V29) — drives player-rim outline strength + motion-reduced cutaway fades. */
  private accessibility: RenderAccessibility = DEFAULT_ACCESSIBILITY;
  private playerRimMat: MeshStandardMaterial | null = null;
  private readonly basePlayerEmissive: number;

  private readonly world = resolveDomain(worldConfig, this.tierOf());
  private readonly structures = resolveDomain(structuresConfig, this.tierOf());
  private readonly player = resolveDomain(playerConfig, this.tierOf());
  private readonly lighting = resolveDomain(lightingConfig, this.tierOf());
  private readonly weatherCfg = resolveDomain(weatherConfig, this.tierOf());
  private readonly shadows = resolveDomain(shadowsConfig, this.tierOf());
  private readonly perception = resolveDomain(perceptionConfig, this.tierOf());
  private readonly visibility = resolveVisibilitySettings(this.tierOf());
  private readonly cutawayDepth: CutawayDepthSettings = resolveCutawayDepthSettings(this.tierOf());
  private readonly roofFadeSeconds = resolve(renderingConfig.roofFadeSeconds, this.tierOf());
  private readonly wallPanelThickness = resolve(renderingConfig.wallPanelThicknessMeters, this.tierOf());
  // T87 house render dims + deterministic variation params (drives believable varied + decayed houses, V26).
  private readonly houseVar = resolveHouseVariation(this.tierOf());
  private readonly clapboardSpacing = resolve(renderingConfig.houseClapboardSpacingMeters, this.tierOf());
  private readonly ivyPatchMeters = resolve(renderingConfig.houseIvyPatchMeters, this.tierOf());
  private readonly debrisMeters = resolve(renderingConfig.houseDebrisMeters, this.tierOf());
  private readonly porchHeightMeters = resolve(renderingConfig.housePorchHeightMeters, this.tierOf());
  private readonly chimneyMeters = resolve(renderingConfig.houseChimneyMeters, this.tierOf());
  private readonly windowBoardedFraction = this.world.houseWindowBoardedFraction;
  private readonly roofOverhang = this.world.houseRoofOverhangMeters;
  private readonly houseDebrisMaxCount = this.world.houseDebrisMaxCount;
  /** Soft cap on instanced ivy patches across the whole district (logged if hit). */
  private readonly ivyInstanceCap = 4000;
  /** Tone-mapping operator + base exposure (B6) — applied to the renderer by the host each frame. */
  readonly toneMappingMode = resolve(postFXConfig.toneMappingMode, this.tierOf()) as ToneMappingMode;
  private readonly baseExposure = resolve(postFXConfig.baseExposure, this.tierOf());
  private readonly exposureTransitionSeconds = resolve(lightingConfig.exposureTransitionSeconds, this.tierOf());

  private readonly navCellSize: number;
  private readonly sun: DirectionalLight;
  private readonly ambient: AmbientLight;
  private readonly hemi: HemisphereLight;
  /** Player flashlight (T98) — a SpotLight at the player aimed along playerAim(), lighting the revealed wedge.
   *  Owned/tracked by the ResourceRegistry (V24). Driven each frame in syncFlashlight; toggled via F / dev. */
  private readonly flashlight: SpotLight;
  /** Live render-feature toggles (mirrored from the debug-flag store each frame by syncFrame). */
  private flashlightOn = true;
  private visionConeCullOn = true;
  private readonly fog: Fog;
  private readonly playerMesh: Object3D;
  /** Cheap contact-AO / grounding disc that follows the player (T45/V36) — soft dark radial gradient. */
  private aoContact: Mesh | null = null;
  private readonly fadeSurfaces: FadeSurface[] = [];
  /** PLAYER PERCEPTION v2 (V62): RENDER-side recently-seen memory + a per-slot reveal scratch buffer. Both are
   *  view state only (fed by frame dt) and NEVER read back into the deterministic sim (V26). Sized to the SoA
   *  capacity so a reveal exists for every possible zombie slot with no per-frame allocation (V24). */
  private readonly perceptionMemory: PerceptionMemory;
  private readonly perceptionReveal: Float32Array;
  /** structuralCell -> the section meshes to hide once that cell is breached. */
  private readonly sectionMeshes: { cell: number; objects: Object3D[] }[] = [];
  /** T46 door leaves: each leaf hangs off a hinge PIVOT group; syncDoors rotates the pivot toward the door's
   *  authoritative open/closed target (the render only REFLECTS sim state, V12). Keyed by nav cell index. */
  private readonly doorLeaves: { navCell: number; pivot: Object3D; openTarget: number; current: number }[] = [];
  /** The building that owns the destructible §G section — kept lightly weathered + readable (set at build). */
  private featureBuildingIndex = -1;

  /** Combat feedback (B7): muzzle flash / tracer / blood / sever, fed by runtime.pollEvents() + fire(). */
  private readonly combat: CombatFeedbackSystem;
  private readonly combatView: CombatFeedbackView;
  /** Smoothed interior/exterior exposure transition 0..1 (B6) — eyes adapting, not a snap. */
  private interiorTransition = 0;
  /** Live tone-mapping exposure (B6) — read by the renderer host each frame. */
  private exposure = 1;

  // shared, tracked GPU resources (V24)
  private readonly mats: MeshStandardMaterial[] = [];
  private readonly geos: BufferGeometry[] = [];

  private tierOf(): QualityTier {
    return this.tier;
  }

  constructor(opts: { runtime: GameRuntime; tier: QualityTier; registry: ResourceRegistry; accessibility?: RenderAccessibility }) {
    this.runtime = opts.runtime;
    this.tier = opts.tier;
    this.registry = opts.registry;
    this.accessibility = opts.accessibility ?? DEFAULT_ACCESSIBILITY;
    this.basePlayerEmissive = PLAYER_BASE_EMISSIVE;
    this.navCellSize = this.runtime.scene.navGrid.settings.navCellSize;
    const zombieCapacity = this.runtime.zombies.capacity;
    this.perceptionMemory = new PerceptionMemory(zombieCapacity);
    this.perceptionReveal = new Float32Array(zombieCapacity);

    this.scene.background = new Color(0x0b0d0a);
    this.fog = new Fog(0x0b0d0a, 1, 400);
    this.scene.fog = this.fog;

    this.ambient = new AmbientLight(0xffffff, this.lighting.ambientIntensity);
    this.hemi = new HemisphereLight(0xa7b8c8, 0x2a2620, this.lighting.ambientIntensity * 0.5);
    this.sun = new DirectionalLight(0xfff2dc, this.lighting.sunIntensity);
    this.sun.castShadow = true;
    // B13/T45/V36: size the directional shadow ortho frustum (per-tier, config-driven — no literals/V4) so
    // the key casts readable shadows. The frustum is re-centred on the player each frame (syncLighting) so it
    // always covers the play area without a hard cut-off; far reaches from the light past the receive band.
    {
      const half = this.shadows.shadowOrthoHalfExtentMeters;
      const sc = this.sun.shadow.camera;
      sc.left = -half;
      sc.right = half;
      sc.top = half;
      sc.bottom = -half;
      sc.near = this.shadows.shadowCameraNearMeters;
      sc.far = this.shadows.shadowLightDistanceMeters + this.shadows.shadowMaxDistanceMeters;
      sc.updateProjectionMatrix();
      this.sun.shadow.mapSize.set(this.shadows.shadowMapResolution, this.shadows.shadowMapResolution);
      this.sun.shadow.bias = this.shadows.shadowDepthBias;
    }
    this.scene.add(this.ambient, this.hemi, this.sun, this.sun.target);

    // T98: player flashlight — a SpotLight at the player aimed along playerAim(), its cone matched to the
    // player vision wedge (so the lit area == the fog-of-war-revealed area). Pooled + tracked for disposal
    // (V24); all tunables typed config (V4). Position/target/intensity are driven each frame in syncFlashlight.
    const fovHalf = (this.perception.playerFieldOfViewDegrees * Math.PI) / 360;
    const angleMargin = (this.lighting.flashlightAngleMarginDegrees * Math.PI) / 180;
    this.flashlight = this.registry.track(
      new SpotLight(
        this.lighting.flashlightColor,
        this.lighting.flashlightIntensity,
        this.perception.playerVisionRange + this.lighting.flashlightRangeMarginMeters,
        Math.min(Math.PI / 2 - 0.01, fovHalf + angleMargin),
        this.lighting.flashlightPenumbra,
        this.lighting.flashlightDecay,
      ),
      'effect',
      'block.flashlight',
    );
    // V63: the flashlight casts shadows — a torch that doesn't occlude reads as a flat wash. SpotLight gets its
    // own shadow map (the spot camera's fov auto-tracks the cone angle); near/far bound to the flashlight reach
    // so the depth range stays tight. Tunables reuse the typed shadow domain (V4).
    this.flashlight.castShadow = true;
    this.flashlight.shadow.mapSize.set(this.shadows.shadowMapResolution, this.shadows.shadowMapResolution);
    this.flashlight.shadow.bias = this.shadows.shadowDepthBias;
    this.flashlight.shadow.camera.near = this.shadows.shadowCameraNearMeters;
    this.flashlight.shadow.camera.far = this.perception.playerVisionRange + this.lighting.flashlightRangeMarginMeters;
    this.scene.add(this.flashlight, this.flashlight.target);

    this.featureBuildingIndex = this.computeFeatureBuildingIndex();
    this.buildGround();
    this.buildGroundRects();
    this.buildWallsAndRoof();
    this.buildDoorsAndWindows();
    this.buildProps();
    this.buildContainers();
    this.playerMesh = this.buildPlayer();
    this.scene.add(this.playerMesh);
    this.buildContactAo();

    this.crowd = new Crowd(resolveCrowdSettings(this.tier), this.registry);
    this.crowd.mesh.castShadow = true; // B13: the horde casts shadows too (was unset → zombies floated shadowless)
    this.crowd.mesh.receiveShadow = true;
    this.scene.add(this.crowd.mesh);

    // Combat feedback (B7): pooled gore + muzzle/tracer, tracked for disposal (V24) and added to the graph.
    const combatSettings = resolveCombatFeedbackSettings(this.tier);
    this.combat = new CombatFeedbackSystem(combatSettings);
    this.combatView = new CombatFeedbackView(combatSettings, this.registry);
    this.combatView.attachTo(this.scene);

    this.syncBreach();
    this.syncFrame(0, undefined);
  }

  // ---- geometry construction ----

  private mat(label: string, opts: ConstructorParameters<typeof MeshStandardMaterial>[0]): MeshStandardMaterial {
    const m = this.registry.track(new MeshStandardMaterial(opts), 'material', `block.${label}`);
    this.mats.push(m);
    return m;
  }

  private geo<T extends BufferGeometry>(label: string, g: T): T {
    this.registry.track(g, 'geometry', `block.${label}`);
    this.geos.push(g);
    return g;
  }

  /** Merge a batch of throwaway BoxGeometries into ONE tracked geometry (cuts per-cell wall draw calls). */
  private mergeBoxes(label: string, boxes: BoxGeometry[]): BufferGeometry | null {
    if (boxes.length === 0) return null;
    const merged = mergeGeometries(boxes, false);
    for (const b of boxes) b.dispose();
    return merged ? this.geo(label, merged) : null;
  }

  private worldExtent(): { width: number; depth: number } {
    return {
      width: this.runtime.scene.navGrid.width * this.navCellSize,
      depth: this.runtime.scene.navGrid.height * this.navCellSize,
    };
  }

  /** Which building (if any) holds the destructible §G section cells — kept readable (less decay). */
  private computeFeatureBuildingIndex(): number {
    const ts = this.runtime.scene;
    const buildings = buildingsOf(ts);
    for (let z = 0; z < ts.wall.sizeZ; z++) {
      const cell = ts.navCellForStructuralCell(ts.wall.packCell(0, 0, z));
      for (let i = 0; i < buildings.length; i++) {
        const b = buildings[i]!.bounds;
        if (cell.cx >= b.minCx && cell.cx <= b.maxCx && cell.cy >= b.minCy && cell.cy <= b.maxCy) return i;
      }
    }
    return -1;
  }

  private buildGround(): void {
    const { width, depth } = this.worldExtent();
    const margin = this.navCellSize * 4;
    // Base ground = grass/dirt verge under the whole district; the suburban paint (asphalt street, concrete
    // sidewalk, grass yards) is layered on top by buildGroundRects.
    const ground = new Mesh(
      this.geo('ground.geo', new PlaneGeometry(width + margin, depth + margin)),
      this.mat('ground', { color: 0x57564a, roughness: 0.98 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(width / 2, 0, depth / 2);
    ground.receiveShadow = true;
    this.scene.add(ground);

    // Per-building interior floor slab — slightly raised + lighter so each house's rooms read (multi-building).
    const floorMat = this.mat('floor', { color: 0x6b6e64, roughness: 0.9 });
    buildingsOf(this.runtime.scene).forEach((bld, i) => {
      const b = bld.bounds;
      const fw = (b.maxCx - b.minCx + 1) * this.navCellSize;
      const fd = (b.maxCy - b.minCy + 1) * this.navCellSize;
      const floor = new Mesh(this.geo(`floor.geo.${i}`, new PlaneGeometry(fw, fd)), floorMat);
      floor.rotation.x = -Math.PI / 2;
      floor.position.set(((b.minCx + b.maxCx + 1) / 2) * this.navCellSize, this.world.floorThicknessMeters, ((b.minCy + b.maxCy + 1) / 2) * this.navCellSize);
      floor.receiveShadow = true;
      this.scene.add(floor);
    });
  }

  /** Suburban ground paint (T87): asphalt street, concrete sidewalk, grass yards as flat coloured quads
   *  layered by a small per-kind Y offset (highest kind wins on overlap). Pure dressing; no nav effect. */
  private buildGroundRects(): void {
    const rects = this.runtime.scene.groundRects;
    if (!rects || rects.length === 0) return;
    const cs = this.navCellSize;
    const color: Record<GroundKind, number> = { asphalt: 0x26282c, sidewalk: 0x6a6c6e, grass: 0x3b4a2c };
    const yOf: Record<GroundKind, number> = { asphalt: 0.012, sidewalk: 0.02, grass: 0.028 };
    const mats: Record<GroundKind, MeshStandardMaterial> = {
      asphalt: this.mat('ground.asphalt', { color: color.asphalt, roughness: 0.96 }),
      sidewalk: this.mat('ground.sidewalk', { color: color.sidewalk, roughness: 0.9 }),
      grass: this.mat('ground.grass', { color: color.grass, roughness: 1 }),
    };
    const group = new Group();
    rects.forEach((r, i) => {
      const w = (r.rect.maxCx - r.rect.minCx + 1) * cs;
      const d = (r.rect.maxCy - r.rect.minCy + 1) * cs;
      const m = new Mesh(this.geo(`groundRect.${i}`, new PlaneGeometry(w, d)), mats[r.kind]);
      m.rotation.x = -Math.PI / 2;
      m.position.set(((r.rect.minCx + r.rect.maxCx + 1) / 2) * cs, yOf[r.kind], ((r.rect.minCy + r.rect.maxCy + 1) / 2) * cs);
      m.receiveShadow = true;
      group.add(m);
    });
    this.scene.add(group);
  }

  /** A deterministic, replay-stable HouseStyle for a building (V26): seeded off the building's STABLE footprint
   *  so the same lot always authors the same house without widening the frozen scene contract. The §G feature
   *  building is kept lightly weathered + un-collapsed so its interior stays readable + navigable. */
  private styleFor(bld: BuildingFootprint, bi: number): HouseStyle {
    const b = bld.bounds;
    const seed = (Math.imul(b.minCx + 1, 73856093) ^ Math.imul(b.minCy + 1, 19349663) ^ Math.imul(bi + 1, 83492791)) | 0;
    const base = authorHouseStyle(seed, this.houseVar);
    const storeys = Math.max(1, bld.storeys ?? base.storeys);
    if (bi === this.featureBuildingIndex) {
      // keep the §G house legible: clean tint, light damage, no roof collapse.
      const damage = Math.min(base.damage, this.houseVar.roofHoleDamageThreshold * 0.6);
      return { ...base, storeys, wallColor: base.wallColorClean, damage, ivy: 0, collapsed: false };
    }
    return { ...base, storeys };
  }

  private buildWallsAndRoof(): void {
    const ts = this.runtime.scene;
    const grid = ts.navGrid;
    const buildings = buildingsOf(ts);
    const th = Math.min(this.wallPanelThickness, this.navCellSize); // thin shell, never wider than the cell
    const baseHeightCap = this.visibility.baseHeightMeters;

    // destructible section keeps its distinct tinted, hideable material (never per-house tinted).
    const sectionMat = this.mat('section', { color: 0xb04a32, roughness: 0.7 });

    // B3: bias fading upper-wall + roof faces back + lift them off the retained base so reveal faces never
    // z-fight the coplanar base top / ground (cutaway). Decisions are pure (resolveCutawayDepthOffset).
    const upperOffset = resolveCutawayDepthOffset('upperWall', this.cutawayDepth);
    const roofOffset = resolveCutawayDepthOffset('roof', this.cutawayDepth);

    // structural-section nav cells get distinct, hideable meshes; everything else is a plain wall.
    const sectionByNav = new Map<number, number>(); // navIndex -> structuralCell
    for (let z = 0; z < ts.wall.sizeZ; z++) {
      const sc = ts.wall.packCell(0, 0, z);
      const cell = ts.navCellForStructuralCell(sc);
      sectionByNav.set(grid.index(cell.cx, cell.cy), sc);
    }

    // T46: a DOOR cell is a real opening — OMIT its wall panel even when the door is currently closed (the
    // door leaf, built in buildDoorsAndWindows, fills the gap). This cuts the doorway so the leaf no longer
    // floats on a solid wall. Open door cells are already unblocked (no panel); this also covers closed ones.
    const doorNav = new Set<number>();
    for (const e of ts.exitCells) doorNav.add(grid.index(e.cx, e.cy));

    // The exposed edges of a blocked cell (neighbor open or out of bounds): where a real wall face lives.
    const edges = (cx: number, cy: number): { dx: number; dz: number; along: 'x' | 'z' }[] => {
      const open = (nx: number, ny: number): boolean =>
        nx < 0 || ny < 0 || nx >= grid.width || ny >= grid.height || !grid.isBlocked(grid.index(nx, ny));
      const out: { dx: number; dz: number; along: 'x' | 'z' }[] = [];
      if (open(cx, cy - 1)) out.push({ dx: 0, dz: -1, along: 'x' });
      if (open(cx, cy + 1)) out.push({ dx: 0, dz: 1, along: 'x' });
      if (open(cx + 1, cy)) out.push({ dx: 1, dz: 0, along: 'z' });
      if (open(cx - 1, cy)) out.push({ dx: -1, dz: 0, along: 'z' });
      return out;
    };

    const wallsGroup = new Group();
    this.scene.add(wallsGroup);
    const ivyMatrices: Matrix4[] = []; // accrued across every house → ONE instanced ivy mesh (perf, V2-style)
    const debrisMatrices: Matrix4[] = [];
    const debrisColors: Color[] = [];

    buildings.forEach((bld, bi) => {
      const style = this.styleFor(bld, bi);
      const wallH = this.world.buildingWallHeightMeters * Math.max(1, style.storeys);
      const baseH = Math.min(baseHeightCap, wallH);
      const upperH = Math.max(0, wallH - baseH);
      const upperBottomY = baseH + upperOffset.verticalInsetMeters;

      const b = bld.bounds;
      const centerX = ((b.minCx + b.maxCx + 1) / 2) * this.navCellSize;
      const centerZ = ((b.minCy + b.maxCy + 1) / 2) * this.navCellSize;

      // per-house clapboard tint (weathered); each building owns its base + per-direction upper + roof
      // materials so the cutaway fades ONLY this house and neighbours keep their colour (per-building, V59).
      const baseMat = this.mat(`wallBase.${bi}`, { color: style.wallColor, roughness: 0.92 });
      const baseParts: BoxGeometry[] = [];
      // T82/V58 DIRECTIONAL cutaway: bucket non-section upper walls by their cardinal OUTWARD normal so each
      // side fades INDEPENDENTLY — only the side(s) turned toward the camera fade. One merged mesh + one
      // transparent material per (building, direction).
      const upperByDir = new Map<string, { boxes: BoxGeometry[]; normal: VecXZ }>();
      const upperDir = (normal: VecXZ): { boxes: BoxGeometry[]; normal: VecXZ } => {
        const key = `${normal.x},${normal.z}`;
        let g = upperByDir.get(key);
        if (!g) {
          g = { boxes: [], normal };
          upperByDir.set(key, g);
        }
        return g;
      };

      for (let cy = b.minCy; cy <= b.maxCy; cy++) {
        for (let cx = b.minCx; cx <= b.maxCx; cx++) {
          const idx = grid.index(cx, cy);
          if (!grid.isBlocked(idx)) continue;
          if (doorNav.has(idx)) continue; // T46: leave the doorway open — the door leaf fills it
          const wx = (cx + 0.5) * this.navCellSize;
          const wz = (cy + 0.5) * this.navCellSize;
          const sc = sectionByNav.get(idx);
          const faces = edges(cx, cy);
          // T70/B12: emit ONE panel per RUN orientation, CENTRED on the cell (X-run when a N/S face is exposed,
          // Z-run when an E/W face is exposed; a corner cell gets both → an L). No doubled wall, no gap.
          const orientations: ('x' | 'z')[] = [];
          if (faces.some((f) => f.along === 'x')) orientations.push('x');
          if (faces.some((f) => f.along === 'z')) orientations.push('z');
          if (orientations.length === 0) orientations.push('x');
          const sectionObjs: Object3D[] = [];

          for (const along of orientations) {
            if (sc !== undefined) {
              // Destructible section: individual hideable meshes that stay opaque (do NOT fade with cutaway).
              const baseGeo = this.geo(`section.base.${bi}.${cx}.${cy}.${along}`, along === 'x'
                ? new BoxGeometry(this.navCellSize, baseH, th)
                : new BoxGeometry(th, baseH, this.navCellSize));
              const base = new Mesh(baseGeo, sectionMat);
              base.position.set(wx, baseH / 2, wz);
              base.castShadow = true;
              base.receiveShadow = true;
              wallsGroup.add(base);
              sectionObjs.push(base);
              if (upperH > 0) {
                const upperGeo = this.geo(`section.upper.${bi}.${cx}.${cy}.${along}`, along === 'x'
                  ? new BoxGeometry(this.navCellSize, upperH, th)
                  : new BoxGeometry(th, upperH, this.navCellSize));
                const upper = new Mesh(upperGeo, sectionMat);
                upper.position.set(wx, upperBottomY + upperH / 2, wz);
                upper.castShadow = true;
                wallsGroup.add(upper);
                sectionObjs.push(upper);
              }
            } else {
              // Plain wall: accrue into the merged base batch + the directional upper batch for this house.
              const baseBox = along === 'x'
                ? new BoxGeometry(this.navCellSize, baseH, th)
                : new BoxGeometry(th, baseH, this.navCellSize);
              baseBox.translate(wx, baseH / 2, wz);
              baseParts.push(baseBox);
              if (upperH > 0) {
                const upperBox = along === 'x'
                  ? new BoxGeometry(this.navCellSize, upperH, th)
                  : new BoxGeometry(th, upperH, this.navCellSize);
                upperBox.translate(wx, upperBottomY + upperH / 2, wz);
                upperDir(this.upperWallOutwardNormal(along, faces, wx, wz, centerX, centerZ)).boxes.push(upperBox);
              }
            }
          }
          if (sc !== undefined) this.sectionMeshes.push({ cell: sc, objects: sectionObjs });
        }
      }

      // one merged base-wall mesh for the whole house (section cells excluded — they stay individual).
      const baseGeoMerged = this.mergeBoxes(`wallBase.geo.${bi}`, baseParts);
      if (baseGeoMerged) {
        const baseWall = new Mesh(baseGeoMerged, baseMat);
        baseWall.castShadow = true;
        baseWall.receiveShadow = true;
        wallsGroup.add(baseWall);
      }
      // one merged upper-wall mesh per direction → the per-side, per-building cutaway fade surface (V58/V59).
      if (upperH > 0) {
        for (const [key, g] of upperByDir) {
          const upperGeoMerged = this.mergeBoxes(`wallUpper.geo.${bi}.${key}`, g.boxes);
          if (!upperGeoMerged) continue;
          const upperMat = this.mat(`wallUpper.${bi}.${key}`, { color: style.wallColor, roughness: 0.92, transparent: true, opacity: 1 });
          upperMat.polygonOffset = upperOffset.polygonOffset;
          upperMat.polygonOffsetFactor = upperOffset.polygonOffsetFactor;
          upperMat.polygonOffsetUnits = upperOffset.polygonOffsetUnits;
          const upperWall = new Mesh(upperGeoMerged, upperMat);
          upperWall.castShadow = true;
          upperWall.renderOrder = upperOffset.renderOrder;
          this.scene.add(upperWall);
          // World-XZ centre of this side's merged upper wall (its geometry is already in world coords) — the
          // OUTSIDE-WALL cutaway projects player + camera onto the wall plane through this point (V62).
          upperGeoMerged.computeBoundingBox();
          const bb = upperGeoMerged.boundingBox;
          const sideCenterX = bb ? (bb.min.x + bb.max.x) / 2 : 0;
          const sideCenterZ = bb ? (bb.min.z + bb.max.z) / 2 : 0;
          this.fadeSurfaces.push({ object: upperWall, material: upperMat, kind: 'upperWall', outwardNormal: g.normal, heightMeters: wallH, buildingIndex: bi, centerX: sideCenterX, centerZ: sideCenterZ, opacity: 1 });
        }
      }

      this.buildClapboard(b, bi, wallH, style, wallsGroup);
      this.buildRoofAssembly(b, bi, wallH, style, roofOffset);
      this.buildPorch(b, bi, style);
      this.collectIvy(b, style, grid, ivyMatrices);
      this.collectDebris(b, style, debrisMatrices, debrisColors);
    });

    this.buildIvy(ivyMatrices);
    this.buildDebris(debrisMatrices, debrisColors);
  }

  /**
   * The cardinal OUTWARD horizontal normal of an upper-wall panel (T82/V58). For a panel running along X the
   * normal is ±Z (the open/exterior side); along Z it is ±X. A perimeter wall has exactly one open side so
   * the exposed-edge sign decides; a free-standing interior wall (open on both sides) falls back to pointing
   * away from the building centre. Pure helper — feeds the directional cutaway's per-side fade buckets.
   */
  private upperWallOutwardNormal(
    along: 'x' | 'z',
    faces: { dx: number; dz: number; along: 'x' | 'z' }[],
    wx: number,
    wz: number,
    centerX: number,
    centerZ: number,
  ): VecXZ {
    if (along === 'x') {
      const north = faces.some((f) => f.along === 'x' && f.dz < 0);
      const south = faces.some((f) => f.along === 'x' && f.dz > 0);
      const sz = north && !south ? -1 : south && !north ? 1 : wz < centerZ ? -1 : 1;
      return { x: 0, z: sz };
    }
    const west = faces.some((f) => f.along === 'z' && f.dx < 0);
    const east = faces.some((f) => f.along === 'z' && f.dx > 0);
    const sx = west && !east ? -1 : east && !west ? 1 : wx < centerX ? -1 : 1;
    return { x: sx, z: 0 };
  }

  /** Horizontal clapboard/lap-siding read: a stack of thin lap lines + base skirt + eave fascia, emitted PER SIDE
   *  so each side's siding is a cutaway FADE SURFACE that fades in lockstep with that side's wall (V64). Before,
   *  the lines were ONE non-fading mesh standing 4 cm proud — so when a wall faded for the cutaway the siding
   *  stayed put as a floating "fence" detached from the wall. Now: nearly flush (polygon-offset, no gap) and
   *  fades WITH the wall, so the wall + its siding read as ONE surface. Corner boards stay solid (building edge). */
  private buildClapboard(b: CellRect, bi: number, wallH: number, style: HouseStyle, parent: Group): void {
    const cs = this.navCellSize;
    const minX = b.minCx * cs;
    const maxX = (b.maxCx + 1) * cs;
    const minZ = b.minCy * cs;
    const maxZ = (b.maxCy + 1) * cs;
    const rw = maxX - minX;
    const rd = maxZ - minZ;
    const cxw = (minX + maxX) / 2;
    const czw = (minZ + maxZ) / 2;
    const proud = 0.012; // nearly flush with the wall plane (polygon offset keeps it off the wall, no 4 cm gap)
    const lineH = 0.05;
    const lineT = 0.03;
    const lines = Math.max(2, Math.round(wallH / this.clapboardSpacing));
    const upperOffset = resolveCutawayDepthOffset('upperWall', this.cutawayDepth);
    // One transparent, fadeable lap-line mesh per exterior side (normal = the side it faces).
    const buildSide = (key: string, normal: VecXZ, centerX: number, centerZ: number, boxes: BoxGeometry[]): void => {
      const merged = this.mergeBoxes(`clapboard.${bi}.${key}`, boxes);
      if (!merged) return;
      const mat = this.mat(`trim.${bi}.${key}`, { color: style.trimColor, roughness: 0.85, transparent: true, opacity: 1 });
      mat.polygonOffset = upperOffset.polygonOffset;
      mat.polygonOffsetFactor = upperOffset.polygonOffsetFactor;
      mat.polygonOffsetUnits = upperOffset.polygonOffsetUnits;
      const mesh = new Mesh(merged, mat);
      mesh.castShadow = true;
      mesh.renderOrder = upperOffset.renderOrder;
      this.scene.add(mesh);
      this.fadeSurfaces.push({ object: mesh, material: mat, kind: 'upperWall', outwardNormal: normal, heightMeters: wallH, buildingIndex: bi, centerX, centerZ, opacity: 1 });
    };
    const sides: { key: string; normal: VecXZ; centerX: number; centerZ: number; boxes: BoxGeometry[] }[] = [
      { key: 'n', normal: { x: 0, z: -1 }, centerX: cxw, centerZ: minZ, boxes: [] },
      { key: 's', normal: { x: 0, z: 1 }, centerX: cxw, centerZ: maxZ, boxes: [] },
      { key: 'w', normal: { x: -1, z: 0 }, centerX: minX, centerZ: czw, boxes: [] },
      { key: 'e', normal: { x: 1, z: 0 }, centerX: maxX, centerZ: czw, boxes: [] },
    ];
    const add = (arr: BoxGeometry[], geoW: number, geoH: number, geoD: number, x: number, y: number, z: number): void => {
      const box = new BoxGeometry(geoW, geoH, geoD);
      box.translate(x, y, z);
      arr.push(box);
    };
    for (let k = 0; k <= lines; k++) {
      const y = (k / lines) * (wallH - 0.1) + 0.05;
      const h = k === 0 ? 0.18 : k === lines ? 0.12 : lineH; // fat skirt + fascia
      add(sides[0]!.boxes, rw + proud * 2, h, lineT, cxw, y, minZ - proud);
      add(sides[1]!.boxes, rw + proud * 2, h, lineT, cxw, y, maxZ + proud);
      add(sides[2]!.boxes, lineT, h, rd + proud * 2, minX - proud, y, czw);
      add(sides[3]!.boxes, lineT, h, rd + proud * 2, maxX + proud, y, czw);
    }
    for (const s of sides) buildSide(s.key, s.normal, s.centerX, s.centerZ, s.boxes);
    // corner boards (vertical trim) — solid, at the building corners (not part of a single side's fade).
    const cornerParts: BoxGeometry[] = [];
    for (const [x, z] of [[minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ]] as const) {
      const c = new BoxGeometry(lineT * 1.6, wallH, lineT * 1.6);
      c.translate(x, wallH / 2, z);
      cornerParts.push(c);
    }
    const corners = this.mergeBoxes(`clapboard.corners.${bi}`, cornerParts);
    if (corners) {
      const cmesh = new Mesh(corners, this.mat(`trim.${bi}`, { color: style.trimColor, roughness: 0.85 }));
      cmesh.castShadow = true;
      parent.add(cmesh);
    }
  }

  /** Shaped roof (gable / hip / flat) + chimney + decay holes, grouped so the whole assembly is the building's
   *  cutaway fade surface (V20). A collapsed house sags its roof. */
  private buildRoofAssembly(
    b: CellRect,
    bi: number,
    wallH: number,
    style: HouseStyle,
    roofOffset: ReturnType<typeof resolveCutawayDepthOffset>,
  ): void {
    const cs = this.navCellSize;
    const rw = (b.maxCx - b.minCx + 1) * cs;
    const rd = (b.maxCy - b.minCy + 1) * cs;
    const cxw = ((b.minCx + b.maxCx + 1) / 2) * cs;
    const czw = ((b.minCy + b.maxCy + 1) / 2) * cs;

    const roofMat = this.mat(`roof.${bi}`, { color: style.roofColor, roughness: 0.95, transparent: true, opacity: 1, side: DoubleSide });
    roofMat.polygonOffset = roofOffset.polygonOffset;
    roofMat.polygonOffsetFactor = roofOffset.polygonOffsetFactor;
    roofMat.polygonOffsetUnits = roofOffset.polygonOffsetUnits;

    const group = new Group();
    const roofGeo = this.geo(`roof.geo.${bi}`, makeRoofGeometry(style.roofShape, rw, rd, style.roofPitchMeters, this.roofOverhang, style.ridgeAlongX));
    const roof = new Mesh(roofGeo, roofMat);
    roof.renderOrder = roofOffset.renderOrder;
    roof.castShadow = true;
    group.add(roof);

    // roof decay — caved-in / missing-shingle patches near the ridge (dark voids reading as holes).
    const holes = roofHoles(style, this.houseVar.roofHoleDamageThreshold, this.houseVar.roofHoleMaxCount);
    if (holes.length > 0) {
      const holeMat = this.mat(`roofHole.${bi}`, { color: 0x0d0c0a, roughness: 1, side: DoubleSide });
      const ridgeLen = style.roofShape === 'gable' ? (style.ridgeAlongX ? rw : rd) : Math.max(rw, rd);
      const ridgeAlongX = style.roofShape === 'gable' ? style.ridgeAlongX : rw >= rd;
      for (let h = 0; h < holes.length; h++) {
        const hole = holes[h]!;
        const along = (hole.t - 0.5) * ridgeLen;
        const size = Math.min(hole.radiusMeters * 2, Math.min(rw, rd) * 0.8);
        const box = new Mesh(this.geo(`roofHole.geo.${bi}.${h}`, new BoxGeometry(size, 0.14, size)), holeMat);
        const y = Math.max(0.2, style.roofPitchMeters - 0.25);
        box.position.set(ridgeAlongX ? along : 0, y, ridgeAlongX ? 0 : along);
        group.add(box);
      }
    }

    if (style.hasChimney) {
      const c = this.chimneyMeters;
      const chimneyH = style.roofPitchMeters + this.world.buildingWallHeightMeters * 0.5;
      const chimney = new Mesh(this.geo(`chimney.geo.${bi}`, new BoxGeometry(c, chimneyH, c)), this.mat(`chimney.${bi}`, { color: 0x6e4a3a, roughness: 0.95 }));
      const sx = (hash01(style.seed, 71) - 0.5) * (rw - c - 0.6);
      const sz = (hash01(style.seed, 72) - 0.5) * (rd - c - 0.6);
      chimney.position.set(sx, chimneyH / 2, sz);
      chimney.castShadow = true;
      group.add(chimney);
    }

    group.position.set(cxw, wallH, czw);
    if (style.collapsed) group.rotation.z = (hash01(style.seed, 80) < 0.5 ? 1 : -1) * 0.14; // sagging caved roof
    this.scene.add(group);
    this.fadeSurfaces.push({ object: group, material: roofMat, kind: 'roof', outwardNormal: null, heightMeters: wallH, buildingIndex: bi, centerX: cxw, centerZ: czw, opacity: 1 });
  }

  /** A covered front porch at the house's street door: deck + posts + a low shed roof. Always visible (it sits
   *  outside the footprint, so it is not a cutaway occluder). */
  private buildPorch(b: CellRect, bi: number, style: HouseStyle): void {
    if (!style.hasPorch) return;
    const cs = this.navCellSize;
    const door = this.runtime.scene.exitCells.find((e) => e.cx >= b.minCx && e.cx <= b.maxCx && e.cy >= b.minCy && e.cy <= b.maxCy);
    if (!door) return;
    const depth = Math.min(this.world.housePorchDepthMeters, cs * 1.2); // porch run out from the wall
    const width = cs * 2.2;
    const dx = (door.cx + 0.5) * cs;
    const southZ = (b.maxCy + 1) * cs; // door is on the south perimeter
    const outZ = southZ + depth / 2;
    const mat = this.mat(`porch.${bi}`, { color: style.trimColor, roughness: 0.9 });
    const group = new Group();
    // deck
    const deck = new Mesh(this.geo(`porch.deck.${bi}`, new BoxGeometry(width, 0.16, depth)), mat);
    deck.position.set(dx, 0.08, outZ);
    deck.receiveShadow = true;
    group.add(deck);
    // roof
    const roofY = this.porchHeightMeters;
    const proof = new Mesh(this.geo(`porch.roof.${bi}`, new BoxGeometry(width + 0.3, 0.12, depth + 0.2)), mat);
    proof.position.set(dx, roofY, outZ);
    proof.castShadow = true;
    group.add(proof);
    // posts at the outer corners
    const postGeo = this.geo(`porch.post.${bi}`, new BoxGeometry(0.14, roofY, 0.14));
    for (const ox of [-width / 2 + 0.1, width / 2 - 0.1]) {
      const post = new Mesh(postGeo, mat);
      post.position.set(dx + ox, roofY / 2, southZ + depth - 0.15);
      post.castShadow = true;
      group.add(post);
    }
    this.scene.add(group);
  }

  /** Accrue per-house ivy/overgrowth instances climbing the EXTERIOR wall faces, scaled by style.ivy. The
   *  caller flushes one shared instanced mesh for the whole district. */
  private collectIvy(b: CellRect, style: HouseStyle, grid: NavGrid, out: Matrix4[]): void {
    if (style.ivy <= 0) return;
    const cs = this.navCellSize;
    const wallH = this.world.buildingWallHeightMeters * Math.max(1, style.storeys);
    const reach = style.ivy * wallH;
    const patches = Math.max(1, Math.round(reach / this.ivyPatchMeters));
    const q = new Quaternion();
    const s = new Vector3(1, 1, 1);
    const pos = new Vector3();
    for (let cy = b.minCy; cy <= b.maxCy; cy++) {
      for (let cx = b.minCx; cx <= b.maxCx; cx++) {
        if (cx !== b.minCx && cx !== b.maxCx && cy !== b.minCy && cy !== b.maxCy) continue; // perimeter only
        const idx = grid.index(cx, cy);
        if (!grid.isBlocked(idx)) continue;
        const cellRoll = hash01(style.seed, 5100 + cx * 31 + cy * 7);
        if (cellRoll > style.ivy) continue; // denser ivy on more overgrown houses
        // outward face normal: pick the first open neighbour direction.
        let nx = 0;
        let nz = 0;
        if (cx === b.minCx) nx = -1;
        else if (cx === b.maxCx) nx = 1;
        else if (cy === b.minCy) nz = -1;
        else nz = 1;
        const wx = (cx + 0.5) * cs + nx * (cs / 2);
        const wz = (cy + 0.5) * cs + nz * (cs / 2);
        for (let p = 0; p < patches; p++) {
          if (out.length >= this.ivyInstanceCap) {
            console.warn(`[BlockScene] ivy instance cap (${this.ivyInstanceCap}) hit — capping district overgrowth`);
            return;
          }
          const y = (p + 0.5) * this.ivyPatchMeters * 0.85;
          pos.set(wx + nx * 0.06, y, wz + nz * 0.06);
          out.push(new Matrix4().compose(pos, q, s));
        }
      }
    }
  }

  /** One shared instanced ivy mesh for the whole district (flattened green patches; 1 draw call). */
  private buildIvy(matrices: Matrix4[]): void {
    if (matrices.length === 0) return;
    const geo = this.geo('ivy.geo', new IcosahedronGeometry(this.ivyPatchMeters * 0.5, 0));
    geo.scale(1, 1, 0.4); // flattened against the wall
    const mat = this.mat('ivy', { color: 0x35501f, roughness: 1 });
    const mesh = new InstancedMesh(geo, mat, matrices.length);
    this.registry.track(mesh, 'buffer', 'block.ivy.instanced');
    for (let i = 0; i < matrices.length; i++) mesh.setMatrixAt(i, matrices[i]!);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
  }

  /** Accrue base debris/rubble clumps strewn around a ruined house's perimeter, count scaled by damage. */
  private collectDebris(b: CellRect, style: HouseStyle, out: Matrix4[], colors: Color[]): void {
    const count = Math.round(style.damage * this.houseDebrisMaxCount);
    if (count <= 0) return;
    const cs = this.navCellSize;
    const minX = b.minCx * cs;
    const maxX = (b.maxCx + 1) * cs;
    const minZ = b.minCy * cs;
    const maxZ = (b.maxCy + 1) * cs;
    const _p = new Vector3();
    const _q = new Quaternion();
    const _s = new Vector3();
    const _e = new Euler();
    for (let i = 0; i < count; i++) {
      const side = Math.floor(hash01(style.seed, 6100 + i * 5) * 4);
      const along = hash01(style.seed, 6101 + i * 5);
      const out2 = 0.3 + hash01(style.seed, 6102 + i * 5) * 0.6; // distance just outside the wall
      let x: number;
      let z: number;
      if (side === 0) { x = minX + along * (maxX - minX); z = minZ - out2; }
      else if (side === 1) { x = minX + along * (maxX - minX); z = maxZ + out2; }
      else if (side === 2) { x = minX - out2; z = minZ + along * (maxZ - minZ); }
      else { x = maxX + out2; z = minZ + along * (maxZ - minZ); }
      const sc = 0.55 + hash01(style.seed, 6103 + i * 5) * 0.7;
      _q.setFromEuler(_e.set(0, hash01(style.seed, 6104 + i * 5) * Math.PI, 0));
      out.push(new Matrix4().compose(_p.set(x, this.debrisMeters * 0.35 * sc, z), _q, _s.set(sc, sc * 0.7, sc)));
      colors.push(new Color(0x4a463f).offsetHSL(0, 0, (hash01(style.seed, 6105 + i * 5) - 0.5) * 0.14));
    }
  }

  /** One shared instanced debris mesh for the whole district (faceted rubble lumps; 1 draw call). */
  private buildDebris(matrices: Matrix4[], colors: Color[]): void {
    if (matrices.length === 0) return;
    const geo = this.geo('debris.geo', new IcosahedronGeometry(this.debrisMeters * 0.6, 0));
    const mat = this.mat('debris', { color: 0xffffff, roughness: 1 });
    const mesh = new InstancedMesh(geo, mat, matrices.length);
    this.registry.track(mesh, 'buffer', 'block.debris.instanced');
    for (let i = 0; i < matrices.length; i++) {
      mesh.setMatrixAt(i, matrices[i]!);
      mesh.setColorAt(i, colors[i]!);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
  }

  /** Decorative district dressing (T87): picket fences in varied disarray (missing spans → gaps, broken →
   *  partial height, leaning), abandoned cars, tires, bushes, and live + dead trees. EVERY repeated prop is
   *  drawn as ONE InstancedMesh per batch so the whole district stays draw-call-cheap (≈1 call/kind). The
   *  per-span fence/tree decay is derived deterministically from the prop's cell (V26) — no contract change. */
  private buildProps(): void {
    const props = this.runtime.scene.props;
    if (!props || props.length === 0) return;
    const cs = this.navCellSize;
    const group = new Group();

    const B = {
      fence: [] as Matrix4[],
      tire: [] as Matrix4[],
      bush: [] as Matrix4[],
      trunkLive: [] as Matrix4[],
      foliage: [] as Matrix4[],
      trunkDead: [] as Matrix4[],
      branch: [] as Matrix4[],
      carBody: [] as Matrix4[],
      carCabin: [] as Matrix4[],
    };
    const bushColors: Color[] = [];

    const _p = new Vector3();
    const _q = new Quaternion();
    const _s = new Vector3();
    const _e = new Euler();
    const mk = (x: number, y: number, z: number, rotY: number, tiltX: number, sx: number, sy: number, sz: number): Matrix4 =>
      new Matrix4().compose(_p.set(x, y, z), _q.setFromEuler(_e.set(tiltX, rotY, 0)), _s.set(sx, sy, sz));

    for (const p of props) {
      const rot = p.rot ?? 0;
      const variant = p.variant ?? 0;
      const x = (p.cx + 0.5) * cs;
      const z = (p.cy + 0.5) * cs;
      const seed = (Math.imul(p.cx + 1, 73856093) ^ Math.imul(p.cy + 1, 19349663)) | 0;
      switch (p.kind) {
        case 'fence': {
          if (hash01(seed, 5000) < this.world.fenceMissingChance) break; // missing span → a gap in the run
          const broken = hash01(seed, 5001) < this.world.fenceBrokenChance;
          const tilt = (hash01(seed, 5002) - 0.5) * 2 * this.world.fenceLeanMaxRadians;
          const sy = broken ? 0.55 : 1;
          B.fence.push(mk(x, 0.5 * sy, z, rot, tilt, 1, sy, 1));
          break;
        }
        case 'tire':
          B.tire.push(mk(x, 0.19, z, rot + variant, 0, 1, 1, 1));
          break;
        case 'bush': {
          const s = 0.8 + variant * 0.25;
          B.bush.push(mk(x, 0.5 * s, z, rot, 0, s, s * 0.8, s));
          bushColors.push(new Color(0x33491f).offsetHSL(0, 0, (hash01(seed, 1) - 0.5) * 0.12));
          break;
        }
        case 'tree': {
          const s = 1 + variant * 0.3;
          if (hash01(seed, 22) < this.world.treeDeadChance) {
            const tilt = (hash01(seed, 24) - 0.5) * 0.5;
            B.trunkDead.push(mk(x, 1.1, z, 0, tilt, 1, 1, 1));
            for (let br = 0; br < 3; br++) {
              const ang = hash01(seed, 10 + br) * Math.PI * 2;
              B.branch.push(mk(x, 1.9 + br * 0.3, z, ang, 0.7 + tilt, 1, 1, 1));
            }
          } else {
            B.trunkLive.push(mk(x, 1.1, z, 0, 0, 1, 1, 1));
            B.foliage.push(mk(x, 2.6, z, hash01(seed, 7) * Math.PI, 0, s, s, s));
          }
          break;
        }
        case 'car': {
          B.carBody.push(mk(x, 0.55, z, rot, 0, 1, 1, 1));
          B.carCabin.push(mk(x, 1.3, z, rot, 0, 1, 1, 1));
          break;
        }
      }
    }

    const flush = (label: string, geo: BufferGeometry, mat: MeshStandardMaterial, mats: Matrix4[], colors?: Color[]): void => {
      if (mats.length === 0) return;
      const mesh = new InstancedMesh(geo, mat, mats.length);
      this.registry.track(mesh, 'buffer', `block.prop.${label}.instanced`);
      for (let i = 0; i < mats.length; i++) mesh.setMatrixAt(i, mats[i]!);
      if (colors) {
        for (let i = 0; i < colors.length; i++) mesh.setColorAt(i, colors[i]!);
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    };

    // shared geometries (length along X for the fence; tire baked flat) + weathered materials.
    const fenceGeo = this.geo('prop.fence.geo', new BoxGeometry(cs * 0.92, 1.0, 0.08));
    const tireGeo = this.geo('prop.tire.geo', new CylinderGeometry(0.34, 0.34, 0.38, 12).rotateX(Math.PI / 2));
    const bushGeo = this.geo('prop.bush.geo', new IcosahedronGeometry(0.75, 0));
    const trunkGeo = this.geo('prop.trunk.geo', new CylinderGeometry(0.18, 0.24, 2.2, 7));
    const foliageGeo = this.geo('prop.foliage.geo', new IcosahedronGeometry(1.5, 0));
    const branchGeo = this.geo('prop.branch.geo', new BoxGeometry(0.08, 1.2, 0.08));
    const carBodyGeo = this.geo('prop.carBody.geo', new BoxGeometry(2.0, 0.9, 4.2));
    const carCabinGeo = this.geo('prop.carCabin.geo', new BoxGeometry(1.8, 0.8, 2.0));

    flush('fence', fenceGeo, this.mat('prop.fence', { color: 0x6b5a44, roughness: 0.95 }), B.fence);
    flush('tire', tireGeo, this.mat('prop.tire', { color: 0x161616, roughness: 0.95 }), B.tire);
    flush('bush', bushGeo, this.mat('prop.bush', { color: 0xffffff, roughness: 1 }), B.bush, bushColors);
    flush('trunkLive', trunkGeo, this.mat('prop.trunk', { color: 0x39281a, roughness: 0.95 }), B.trunkLive);
    flush('foliage', foliageGeo, this.mat('prop.foliage', { color: 0x2c4a24, roughness: 1 }), B.foliage);
    flush('trunkDead', trunkGeo, this.mat('prop.trunkDead', { color: 0x4a443a, roughness: 0.95 }), B.trunkDead);
    flush('branch', branchGeo, this.mat('prop.branch', { color: 0x4a443a, roughness: 0.95 }), B.branch);
    flush('carBody', carBodyGeo, this.mat('prop.carBody', { color: 0x5a5247, roughness: 0.7, metalness: 0.2 }), B.carBody);
    flush('carCabin', carCabinGeo, this.mat('prop.carCabin', { color: 0x2b3036, roughness: 0.5, metalness: 0.2 }), B.carCabin);

    this.scene.add(group);
  }

  /**
   * Lootable kitchen cupboard meshes (T85): a simple wood-toned cabinet box at EACH authored container cell
   * (the same `lootableContainerCells` source the runtime anchors the container interactable to, so the visible
   * cabinet and the interactable hotspot coincide). Data-driven — one cabinet per container cell. Cast shadows
   * + tracked in the ResourceRegistry for disposal (V24). Dims come from typed structures config (V4), shared
   * with the container's highlight box so the outline hugs the cabinet.
   */
  private buildContainers(): void {
    const placements = lootableContainerCells(this.runtime.scene);
    if (placements.length === 0) return;
    const w = this.structures.cupboardWidthMeters;
    const h = this.structures.cupboardHeightMeters;
    const d = this.structures.cupboardDepthMeters;
    const floorY = this.world.floorThicknessMeters; // cabinets stand on the interior floor slab
    // Shared materials + geometries across every cabinet (one wood body tone + a darker door/face + brass pulls).
    const bodyMat = this.mat('cupboard.body', { color: 0x6b4a2e, roughness: 0.78 });
    const faceMat = this.mat('cupboard.face', { color: 0x573a23, roughness: 0.7 });
    const topMat = this.mat('cupboard.top', { color: 0x8a8378, roughness: 0.55 });
    const pullMat = this.mat('cupboard.pull', { color: 0xb9a05a, roughness: 0.4, metalness: 0.6 });
    const topThick = Math.min(0.06, h * 0.1);
    const bodyGeo = this.geo('cupboard.body.geo', new BoxGeometry(w, h - topThick, d));
    const topGeo = this.geo('cupboard.top.geo', new BoxGeometry(w + 0.06, topThick, d + 0.06));
    const doorGeo = this.geo('cupboard.door.geo', new BoxGeometry(w * 0.46, (h - topThick) * 0.86, 0.03));
    const pullGeo = this.geo('cupboard.pull.geo', new BoxGeometry(0.03, 0.12, 0.04));
    const group = new Group();
    for (const placement of placements) {
      const c = this.runtime.scene.cellCenter(placement.cell);
      const bodyCy = floorY + (h - topThick) / 2;
      const body = new Mesh(bodyGeo, bodyMat);
      body.position.set(c.x, bodyCy, c.z);
      body.castShadow = true;
      body.receiveShadow = true;
      group.add(body);
      const top = new Mesh(topGeo, topMat);
      top.position.set(c.x, floorY + h - topThick / 2, c.z);
      top.castShadow = true;
      group.add(top);
      // two front door panels (toward +Z) with a centre reveal + a brass pull on each.
      const faceZ = c.z + d / 2 + 0.015;
      for (const sx of [-1, 1] as const) {
        const door = new Mesh(doorGeo, faceMat);
        door.position.set(c.x + sx * w * 0.24, bodyCy, faceZ);
        group.add(door);
        const pull = new Mesh(pullGeo, pullMat);
        pull.position.set(c.x + sx * w * 0.04, bodyCy, faceZ + 0.02);
        group.add(pull);
      }
    }
    this.scene.add(group);
  }

  /**
   * Cheap contact-AO grounding disc (T45/V36): a soft dark radial gradient laid flat under the player that
   * follows them each frame. Reads as ambient occlusion / contact darkening even when the sun shadow is faint
   * (overcast / night / interior), so the diorama always feels grounded. Pure geometry (per-vertex alpha,
   * NO texture binding → zero WebGPU validation cost); strength + radius are per-tier config (V4/V8).
   */
  private buildContactAo(): void {
    const strength = this.lighting.ambientOcclusionStrength;
    const radius = this.lighting.contactAoRadiusMeters;
    if (strength <= 0 || radius <= 0) return; // disabled by tier/config — skip cleanly (no empty mesh)
    const segments = 32;
    const geo = this.geo('contactAo.geo', new CircleGeometry(radius, segments));
    // Per-vertex RGBA: opaque-dark centre (alpha = strength) fading to fully transparent at the rim.
    const count = geo.getAttribute('position').count;
    const colors = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const center = i === 0; // CircleGeometry vertex 0 is the centre; 1..n are the rim ring
      colors[i * 4 + 3] = center ? strength : 0;
    }
    geo.setAttribute('color', new Float32BufferAttribute(colors, 4));
    // Tracked for disposal (V24); not pushed into `mats` (that array is typed to the lit standard materials).
    const mat = this.registry.track(
      new MeshBasicMaterial({ color: 0x000000, transparent: true, vertexColors: true, depthWrite: false }),
      'material',
      'block.contactAo',
    );
    const disc = new Mesh(geo, mat);
    disc.rotation.x = -Math.PI / 2; // lay flat on the ground plane
    disc.renderOrder = 1; // draw after opaque ground/floor so the soft darkening composites cleanly
    this.aoContact = disc;
    this.scene.add(disc);
  }

  /**
   * T70 — doors + windows so each shell reads as a house. Additive render pass (does not alter the wall
   * grid): a framed door leaf at each exit gap, and per-building windows on a deterministic subset of facade
   * (perimeter) wall cells whose decay state (intact glass / smashed-open void / boarded over) is derived from
   * the house seed (T87/V26). Pure content from the authored grid — no magic placement.
   */
  private buildDoorsAndWindows(): void {
    const ts = this.runtime.scene;
    const grid = ts.navGrid;
    const cs = this.navCellSize;
    const wallH = this.world.buildingWallHeightMeters;
    const group = new Group();

    const frameMat = this.mat('opening.frame', { color: 0x2e2118, roughness: 0.8 });
    const leafMat = this.mat('door.leaf', { color: 0x5a3d24, roughness: 0.65 });
    const glassMat = this.mat('window.glass', {
      color: 0x9fc6e0,
      roughness: 0.08,
      metalness: 0,
      transparent: true,
      opacity: 0.34,
      emissive: 0x10212e,
    });
    // T87 window decay: painted frame trim, a dark void behind smashed glass, and weathered boards.
    const winFrameMat = this.mat('window.frame', { color: 0xcfc7b4, roughness: 0.85 });
    const voidMat = this.mat('window.void', { color: 0x0c0d0e, roughness: 1 });
    const boardMat = this.mat('window.board', { color: 0x6b5640, roughness: 0.95 });
    const winH = this.world.buildingWallHeightMeters * 0.42; // taller, residential-scale (was a small slit)
    const winSpan = cs * 0.85; // wide picture window filling most of the cell — reads as a real opening to see through
    // shared window geometries (thickness on local X; the caller rotates for N/S walls).
    const paneGeo = this.geo('window.pane.geo', new BoxGeometry(0.08, winH, winSpan));
    const frameGeo = this.geo('window.frame.geo', new BoxGeometry(0.05, winH + 0.16, winSpan + 0.18));
    const voidGeo = this.geo('window.void.geo', new BoxGeometry(0.04, winH, winSpan));
    const boardGeo = this.geo('window.board.geo', new BoxGeometry(0.06, winH * 0.26, winSpan + 0.1));

    // ---- DOORS (T46): the wall panel at a door cell is OMITTED (buildWallsAndRoof) so a real doorway GAP
    // exists. Here we frame it (posts + lintel), fill the wall ABOVE the header back up to the building height
    // (so a tall storey leaves no hole over the door), and hang a flat LEAF off a hinge pivot. Closed, the leaf
    // lies in the wall plane and fills the opening; open, syncDoors swings the pivot ~90°. Orientation follows
    // the wall run (doorAxis): a leaf in an X-running wall spans X and faces ±Z, and vice-versa. ----
    const frameTh = this.structures.openingFrameThicknessMeters;
    const leafTh = this.structures.doorLeafThicknessMeters;
    const leafHeight = wallH * this.structures.doorLeafHeightFraction;
    const buildingsForDoors = buildingsOf(ts);
    for (const cell of ts.exitCells) {
      const wx = (cell.cx + 0.5) * cs;
      const wz = (cell.cy + 0.5) * cs;
      const navCell = grid.index(cell.cx, cell.cy);
      const axis = doorAxis(grid, cell.cx, cell.cy); // 'x' = wall runs along X (leaf faces ±Z)
      // the building this door belongs to → full wall height (for the header fill) + wall tint. Every exit cell
      // lies on a building perimeter, so the lookup always resolves; the initial values are overwritten.
      let bWallH = wallH;
      let wallColor = 0x6b6e64;
      for (let bi = 0; bi < buildingsForDoors.length; bi++) {
        const bb = buildingsForDoors[bi]!.bounds;
        if (cell.cx >= bb.minCx && cell.cx <= bb.maxCx && cell.cy >= bb.minCy && cell.cy <= bb.maxCy) {
          const style = this.styleFor(buildingsForDoors[bi]!, bi);
          bWallH = wallH * Math.max(1, style.storeys);
          wallColor = style.wallColor;
          break;
        }
      }
      const leafW = cs * this.structures.doorLeafWidthFraction;
      const headerY = leafHeight; // top of the doorway opening
      const half = cs / 2; // opening half-width along the wall run

      // frame posts at the opening edges + a lintel across the header.
      const postGeo = this.geo(`door.post.${cell.cx}.${cell.cy}`, new BoxGeometry(frameTh, headerY, frameTh));
      const mkPost = (ox: number, oz: number): Mesh => {
        const p = new Mesh(postGeo, frameMat);
        p.position.set(wx + ox, headerY / 2, wz + oz);
        p.castShadow = true;
        return p;
      };
      const lintelLen = cs + frameTh * 2;
      const lintelGeo = this.geo(`door.lintel.${cell.cx}.${cell.cy}`, axis === 'x'
        ? new BoxGeometry(lintelLen, frameTh, frameTh)
        : new BoxGeometry(frameTh, frameTh, lintelLen));
      const lintel = new Mesh(lintelGeo, frameMat);
      lintel.position.set(wx, headerY + frameTh / 2, wz);
      lintel.castShadow = true;
      group.add(lintel);
      if (axis === 'x') group.add(mkPost(-half, 0), mkPost(half, 0));
      else group.add(mkPost(0, -half), mkPost(0, half));

      // wall fill ABOVE the header up to the building height (covers the omitted panel over the door).
      const fillH = Math.max(0, bWallH - (headerY + frameTh));
      if (fillH > 0.01) {
        const fillGeo = this.geo(`door.header.${cell.cx}.${cell.cy}`, axis === 'x'
          ? new BoxGeometry(cs, fillH, frameTh)
          : new BoxGeometry(frameTh, fillH, cs));
        const fill = new Mesh(fillGeo, this.mat(`doorHeader.${cell.cx}.${cell.cy}`, { color: wallColor, roughness: 0.92 }));
        fill.position.set(wx, headerY + frameTh + fillH / 2, wz);
        fill.castShadow = true;
        fill.receiveShadow = true;
        group.add(fill);
      }

      // the hinged leaf: a flat slab on a PIVOT group at one vertical edge of the opening. Local leaf origin is
      // offset by half its width so the pivot sits exactly on the hinge edge; closed = pivot rotation 0.
      const leafGeo = this.geo(`door.leaf.${cell.cx}.${cell.cy}`, axis === 'x'
        ? new BoxGeometry(leafW, leafHeight, leafTh)
        : new BoxGeometry(leafTh, leafHeight, leafW));
      const leaf = new Mesh(leafGeo, leafMat);
      leaf.castShadow = true;
      const pivot = new Group();
      if (axis === 'x') {
        pivot.position.set(wx - leafW / 2, 0, wz);
        leaf.position.set(leafW / 2, leafHeight / 2, 0);
      } else {
        pivot.position.set(wx, 0, wz - leafW / 2);
        leaf.position.set(0, leafHeight / 2, leafW / 2);
      }
      pivot.add(leaf);
      group.add(pivot);
      this.doorLeaves.push({ navCell, pivot, openTarget: this.structures.doorOpenSwingRadians, current: 0 });
    }

    // ---- WINDOWS: a framed opening on a deterministic subset of facade cells, per building, with a decay
    // state (intact glass / smashed-open void / boarded over) derived from the house seed (T87/V26). ----
    const doorAdjacent = (cx: number, cy: number): boolean =>
      ts.exitCells.some((e) => Math.abs(e.cx - cx) + Math.abs(e.cy - cy) <= 1);
    /** Place a framed window of the given decay state at (wx, sillY, wz), rotated for a N/S wall. */
    const placeWindow = (wx: number, sillY: number, wz: number, ns: boolean, state: ReturnType<typeof windowState>): void => {
      const rotY = ns ? Math.PI / 2 : 0;
      const yc = sillY + winH / 2;
      const place = (geo: BufferGeometry, mat: MeshStandardMaterial, dx: number, dy: number, rz = 0): void => {
        const m = new Mesh(geo, mat);
        m.position.set(wx + (ns ? 0 : dx), yc + dy, wz + (ns ? dx : 0));
        m.rotation.y = rotY;
        m.rotation.z = rz;
        m.castShadow = true;
        group.add(m);
      };
      place(frameGeo, winFrameMat, -0.01, 0); // painted frame trim (recessed backing)
      if (state === 'intact') {
        place(paneGeo, glassMat, 0.02, 0);
      } else if (state === 'broken') {
        place(voidGeo, voidMat, 0.0, 0); // dark smashed-open opening
      } else {
        // boarded: two crossing weathered planks over the opening.
        place(boardGeo, boardMat, 0.03, winH * 0.18, 0.18);
        place(boardGeo, boardMat, 0.03, -winH * 0.16, -0.14);
      }
    };

    buildingsOf(ts).forEach((bld, bi) => {
      const b = bld.bounds;
      const style = this.styleFor(bld, bi);
      const bWallH = wallH * Math.max(1, style.storeys);
      const sillH = this.world.buildingWallHeightMeters * 0.45; // ground-floor sill height (consistent)
      const sills = bWallH > this.world.buildingWallHeightMeters * 1.1 ? [sillH, sillH + this.world.buildingWallHeightMeters] : [sillH];
      // `wi` counts only ELIGIBLE facade cells (not corners/door-adjacent), incremented ONCE per cell so the
      // stride is consistent. A window goes on every Nth eligible cell (houseWindowStride) → sparse, believable
      // walls instead of the old every-other band that read as a greenhouse.
      const stride = this.world.houseWindowStride;
      let wi = 0;
      for (let cy = b.minCy; cy <= b.maxCy; cy++) {
        for (let cx = b.minCx; cx <= b.maxCx; cx++) {
          const onEdge = cx === b.minCx || cx === b.maxCx || cy === b.minCy || cy === b.maxCy;
          if (!onEdge || !grid.isBlocked(grid.index(cx, cy))) continue;
          const corner = (cx === b.minCx || cx === b.maxCx) && (cy === b.minCy || cy === b.maxCy);
          if (corner || doorAdjacent(cx, cy)) continue; // not a window slot — don't count it toward the stride
          const place = wi % stride === 0;
          const slot = wi;
          wi += 1;
          if (!place) continue;
          const ns = cy === b.minCy || cy === b.maxCy;
          const wx = (cx + 0.5) * cs;
          const wz = (cy + 0.5) * cs;
          for (const sy of sills) {
            placeWindow(wx, sy, wz, ns, windowState(style, slot, this.windowBoardedFraction));
          }
        }
      }
    });

    this.scene.add(group);
  }

  private buildPlayer(): Object3D {
    const group = new Group();
    const bodyMat = this.mat('player', {
      color: 0x9cc4ff,
      roughness: 0.5,
      emissive: 0x16324f,
      // V29: the player's strongest-silhouette rim scales with the outline-strength accessibility setting.
      emissiveIntensity: PLAYER_BASE_EMISSIVE * this.accessibility.outlineStrength,
    });
    this.playerRimMat = bodyMat;
    const body = new Mesh(
      this.geo('player.geo', new CapsuleGeometry(this.player.bodyRadiusMeters, this.player.bodyHeightMeters - 2 * this.player.bodyRadiusMeters, 6, 12)),
      bodyMat,
    );
    body.castShadow = true;
    body.position.y = this.player.bodyHeightMeters / 2;
    group.add(body);
    // Facing marker so aim direction reads at a glance.
    const nose = new Mesh(
      this.geo('playerNose.geo', new BoxGeometry(this.player.bodyRadiusMeters * 1.4, 0.12, this.player.bodyRadiusMeters * 0.5)),
      this.mat('playerNose', { color: 0xffffff }),
    );
    nose.position.set(this.player.bodyRadiusMeters, this.player.bodyHeightMeters * 0.6, 0);
    group.add(nose);
    return group;
  }

  // ---- per-frame sync ----

  /**
   * Apply updated accessibility params live (V29) — scales the player-rim outline strength now; the
   * motion-reduction flag is read each frame by the cutaway. Other params (gore intensity, shake) are
   * consumed by their own systems via the shared RenderAccessibility object.
   */
  setAccessibility(a: RenderAccessibility): void {
    this.accessibility = a;
    if (this.playerRimMat) this.playerRimMat.emissiveIntensity = this.basePlayerEmissive * a.outlineStrength;
  }

  /** The live accessibility params (test/diagnostics — proves settings propagate into the scene). */
  get accessibilityParams(): RenderAccessibility {
    return this.accessibility;
  }

  /** Re-point at a freshly loaded runtime (save/load rebuild) and resync breach + crowd. */
  rebindRuntime(runtime: GameRuntime): void {
    this.runtime = runtime;
    this.syncBreach();
    this.syncFrame(0, undefined);
  }

  /**
   * Sync the scene to the authoritative state for this rendered frame: pack the live crowd, move the
   * player avatar, hide breached section cells, drive the sun/moon from the clock, and run the cutaway.
   * `camera` is optional only for the construction-time prime; the live loop always passes it.
   */
  syncFrame(dtSeconds: number, camera: Camera | undefined, flags?: DebugFlags): void {
    // Mirror the live render-feature toggles (vision-cone fog-of-war + flashlight). At the construction-time
    // prime (no flags) the defaults stand. The flags drive both the crowd cull and the flashlight below.
    if (flags) {
      this.flashlightOn = flags.flashlight;
      this.visionConeCullOn = flags.cullToVisionCone;
    }
    // Compact live crowd inputs into the GPU storage buffers; the transform mat4 + animation phase are
    // assembled by renderer.compute(crowd.computeNode) in the frame loop (wired in GameViewport). When the
    // vision-cone fog-of-war is on, only members inside the player's wedge (cone+range+LOS) are packed (T98).
    // The construction-time prime / rebind (no flags) packs the FULL crowd — the cull is a live-loop concern.
    const visibility = flags && this.visionConeCullOn ? this.buildVisionCull(dtSeconds) : undefined;
    this.crowd.update(this.runtime.zombies.views, this.runtime.zombies.count, dtSeconds, visibility);

    const p = this.runtime.player();
    this.playerMesh.position.set(p.x, 0, p.z);
    // T45/V36: keep the contact-AO grounding disc under the player, resting just above the local ground/floor.
    if (this.aoContact) {
      const groundY = this.isPlayerInsideBuilding() ? this.world.floorThicknessMeters : 0;
      this.aoContact.position.set(p.x, groundY + this.lighting.contactAoGroundLiftMeters, p.z);
    }
    // B8/V41: single-source the aim heading. playerAim() is atan2(dz,dx); the avatar's nose is local +x,
    // so the Y-rotation that points +x at world heading h is exactly -h (NO +π/2 offset — that bug left
    // the player facing 90° off the cursor).
    this.playerMesh.rotation.y = -this.runtime.playerAim();

    this.syncBreach();
    this.syncDoors(dtSeconds);
    this.syncLighting(dtSeconds);
    this.syncCutaway(dtSeconds, camera);

    // Combat feedback (B7): age pulses + gore, then reflect onto the GPU objects.
    this.combat.update(Math.max(0, dtSeconds));
    this.combatView.sync(this.combat, this.accessibility.feedback.reduceFlashes);
  }

  /**
   * Consume this frame's drained VisualEvents (B7) — feeds the pooled GoreSystem so hits produce blood /
   * sever feedback. `cameraPos` lets distant gore simplify (V8). Called by the viewport after pollEvents().
   */
  ingestCombatEvents(events: readonly VisualEvent[], cameraPos: { x: number; y: number; z: number }): void {
    this.combat.ingest(events, {
      cameraX: cameraPos.x,
      cameraY: cameraPos.y,
      cameraZ: cameraPos.z,
      goreIntensity: this.accessibility.goreIntensity,
    });
  }

  /** Player fired (B7) — flash the muzzle + draw a tracer from the player's muzzle along the aim direction. */
  fireFeedback(dirX: number, dirZ: number, stopDistanceMeters?: number): void {
    const p = this.runtime.player();
    const muzzleY = this.player.bodyHeightMeters * 0.6;
    // Pass the authoritative shot stop distance (struck body OR first wall) so the tracer terminates there
    // and never draws through a wall when no zombie was hit (V49/V53/B20).
    this.combat.fire(p.x, muzzleY, p.z, dirX, dirZ, stopDistanceMeters);
  }

  /** Live tone-mapping exposure (B6) — read by the renderer host each frame to apply interior/night lift. */
  get currentExposure(): number {
    return this.exposure;
  }

  /**
   * Build this frame's player vision wedge for the crowd fog-of-war cull (T98): the forward cone (player FOV)
   * + reveal range + a wall line-of-sight test, all from typed config + the live player pose. Reuses the
   * canonical V14 cone predicate (via visionCullFade) + the scene LOS walk so it matches the dev overlay cone.
   */
  private buildVisionCull(dtSeconds: number): VisionCull {
    const p = this.runtime.player();
    const scene = this.runtime.scene;
    const los = (x0: number, z0: number, x1: number, z1: number): boolean => hasLineOfSight(scene, x0, z0, x1, z1);
    // PLAYER PERCEPTION v2 (V62): the cone wedge PLUS the near/noise reveal params. The combined per-slot reveal
    // is max(cone, near, memory, noise) — see perceptionMemory.ts. LOS routes through the STRUCTURAL hasLineOfSight
    // (nav grid), never mesh opacity, so a faded cutaway wall can't reveal the zombies behind it (V63).
    const params: RevealParams = {
      px: p.x,
      pz: p.z,
      heading: this.runtime.playerAim(),
      fovHalf: (this.perception.playerFieldOfViewDegrees * Math.PI) / 360,
      range: this.perception.playerVisionRange,
      edgeBandMeters: this.perception.playerVisionRangeFadeMeters,
      edgeBandRadians: (this.perception.playerVisionConeFadeDegrees * Math.PI) / 180,
      nearRadiusMeters: this.perception.playerNearAwarenessRadiusMeters,
      hearingRange: this.perception.hearingRange,
      soundWallOcclusion: this.perception.soundWallOcclusion,
      lineOfSight: los,
    };

    // Precompute the per-slot reveal once per frame (read by BOTH packing paths so they always agree), folding in
    // the stateful recently-seen memory. RENDER-side only — no sim state touched (V26). Matches packing's slot
    // iteration (0..count) exactly so reveal[slot] aligns with the slot each packer reads.
    const zombies = this.runtime.zombies;
    const count = zombies.count;
    const views = zombies.views;
    const position = views.position as Float32Array;
    const alive = views.alive as Uint8Array;
    const state = views.state as Uint8Array;
    const memSec = this.perception.playerSightMemorySeconds;
    const reveal = this.perceptionReveal;
    for (let slot = 0; slot < count; slot++) {
      let inst = 0;
      if (alive[slot] === 1) {
        const x = position[slot * 3]!;
        const z = position[slot * 3 + 2]!;
        const st = state[slot]!;
        const loud = st === ZombieState.Pursue || st === ZombieState.Attack;
        inst = instantaneousReveal(x, z, loud, params);
      }
      reveal[slot] = this.perceptionMemory.step(slot, inst, dtSeconds, memSec);
    }

    return {
      px: params.px,
      pz: params.pz,
      heading: params.heading,
      fovHalf: params.fovHalf,
      range: params.range,
      edgeBandMeters: params.edgeBandMeters,
      edgeBandRadians: params.edgeBandRadians,
      lineOfSight: los,
      reveal,
    };
  }

  /**
   * Drive the player flashlight (T98): anchor it at the player, aim it along playerAim() so its cone covers
   * the same wedge the fog-of-war reveals, and scale its intensity by scene brightness — at night it is the
   * main light, by day it is subtle. Off (or zero intensity) hides it cleanly. `sceneBrightness` is the
   * 0..1 day/night key+ambient level resolved in syncLighting.
   */
  private updateFlashlight(sceneBrightness: number): void {
    const f = this.flashlight;
    if (!this.flashlightOn) {
      f.visible = false;
      return;
    }
    const p = this.runtime.player();
    const aim = this.runtime.playerAim();
    const range = this.perception.playerVisionRange + this.lighting.flashlightRangeMarginMeters;
    f.position.set(p.x, this.lighting.flashlightHeightMeters, p.z);
    // Aim the target forward along the ground (cos/sin aim = the same forward the avatar nose + fire dir use)
    // so the cone rakes from torso height down across the revealed wedge.
    f.target.position.set(p.x + Math.cos(aim) * range, 0, p.z + Math.sin(aim) * range);
    f.target.updateMatrixWorld();
    const dayScale = this.lighting.flashlightDayIntensityScale;
    const brightness = Math.min(1, Math.max(0, sceneBrightness));
    f.intensity = this.lighting.flashlightIntensity * (dayScale + (1 - dayScale) * (1 - brightness));
    f.visible = f.intensity > 0;
  }

  private syncBreach(): void {
    for (const s of this.sectionMeshes) {
      const breached = this.runtime.scene.wall.isBreached(s.cell);
      for (const o of s.objects) o.visible = !breached;
    }
  }

  /**
   * T46 — reflect the authoritative door state onto the rendered leaves: a CLOSED door's leaf lies in the wall
   * plane (rotation 0); an OPEN one is swung ~90° about its hinge. The render only READS sim state (V12) —
   * the pivot eases toward its target at a configured angular speed so the swing animates (snaps at dt<=0,
   * e.g. the construction-time prime, so a door that starts open renders open immediately).
   */
  private syncDoors(dtSeconds: number): void {
    if (this.doorLeaves.length === 0) return;
    const access = new Map<number, string>();
    for (const d of this.runtime.doorViews()) access.set(this.runtime.scene.navGrid.index(d.cx, d.cy), d.access);
    const speed = this.structures.doorSwingSpeedRadiansPerSecond;
    for (const leaf of this.doorLeaves) {
      const target = access.get(leaf.navCell) === 'open' ? leaf.openTarget : 0;
      leaf.current = dtSeconds > 0 ? approach(leaf.current, target, speed, dtSeconds) : target;
      leaf.pivot.rotation.y = leaf.current;
    }
  }

  private syncLighting(dtSeconds: number): void {
    const severity = this.runtime.weatherSeverity;
    const sky = computeSkyState(this.runtime.timeOfDay(), this.lighting, this.weatherCfg, severity);

    const dist = this.shadows.shadowLightDistanceMeters;
    // B13: anchor the key + its shadow frustum to the player so cast shadows always cover the play area
    // (the frustum is capped for sharpness; pinning it to world origin produced a hard shadow cut-off as
    // the player walked away). Sun keeps its sky-driven direction, just translated onto the player.
    const pl = this.runtime.player();
    this.sun.position.set(pl.x - sky.direction.x * dist, -sky.direction.y * dist, pl.z - sky.direction.z * dist);
    this.sun.target.position.set(pl.x, 0, pl.z);
    this.sun.target.updateMatrixWorld();
    this.sun.intensity = sky.keyIntensity;
    this.sun.color.setHex(sky.isDay ? 0xfff2dc : 0xaebed8);
    // B6: floor the ambient/hemisphere fill so a low-key night spawn never crushes unlit faces to black.
    const ambient = Math.max(sky.ambientIntensity, this.lighting.minAmbientIntensity);
    this.ambient.intensity = ambient;
    this.hemi.intensity = ambient * 0.5;

    // B5: analytic, clamped fog distances (no per-frame stepping-loop banding), smoothed toward target so a
    // weather change never sweeps the fog boundary across the near-ortho frame as bands.
    const target = resolveFogDistances(severity, this.tier);
    const rate = this.lighting.fogDistanceSmoothingPerSecond;
    this.fog.far = approach(this.fog.far, target.far, rate, dtSeconds);
    this.fog.near = approach(this.fog.near, target.near, rate, dtSeconds);

    // B5: lift the fog/background colour off near-black to the configured luminance floor (brighter by day)
    // so distant geometry fades into atmosphere instead of a black void.
    const lum = this.lighting.fogFloorLuminance + (sky.isDay ? FOG_DAY_LUMINANCE_BONUS : 0);
    this.fog.color.setRGB(FOG_HUE.r * lum, FOG_HUE.g * lum, FOG_HUE.b * lum);
    (this.scene.background as Color).copy(this.fog.color);

    // B6: resolve the renderer tone-mapping exposure — interior compensation + a night floor so the scene
    // stays viewable after AgX/ACES tone mapping. Smooth the interior transition (eyes adapting).
    const insideTarget = this.isPlayerInsideBuilding() ? 1 : 0;
    const transitionRate = this.exposureTransitionSeconds > 0 ? 1 / this.exposureTransitionSeconds : Infinity;
    this.interiorTransition = approach(this.interiorTransition, insideTarget, transitionRate, dtSeconds);
    const dayMax = this.lighting.sunIntensity + this.lighting.ambientIntensity;
    const sceneBrightness = dayMax > 0 ? Math.min(1, Math.max(0, (sky.keyIntensity + sky.ambientIntensity) / dayMax)) : 0;
    this.exposure = resolveToneExposure({
      baseExposure: this.baseExposure,
      interiorStops: interiorExposure(Math.min(1, Math.max(0, this.interiorTransition)), this.tier),
      sceneBrightness,
      nightBoostStops: this.lighting.nightExposureBoostStops,
    });

    // T98: the flashlight is the main light at night and subtle by day — drive it off the same scene
    // brightness so it coordinates with the player-anchored sun + the floored ambient fill.
    this.updateFlashlight(sceneBrightness);
  }

  private syncCutaway(dtSeconds: number, camera: Camera | undefined): void {
    // PER-BUILDING cutaway (V59): only the building the player currently occupies fades; its neighbours stay
    // opaque so the district still reads as solid streets of houses.
    const insideIndex = this.playerBuildingIndex();
    // V29 motion reduction: cut roofs/upper walls instantly rather than animating the fade (less motion).
    const fadeRate = this.accessibility.feedback.reduceMotion
      ? 1
      : this.roofFadeSeconds > 0
        ? dtSeconds / this.roofFadeSeconds
        : 1;
    // T82/V58 DIRECTIONAL cutaway: derive the horizontal player→camera direction from the camera position. A
    // wall fades only when its outward normal turns toward the camera; the roof always occludes from above.
    const player = this.runtime.player();
    let towardCamera: VecXZ | null = null;
    if (camera) {
      const dx = camera.position.x - player.x;
      const dz = camera.position.z - player.z;
      if (Math.hypot(dx, dz) > 1e-6) towardCamera = { x: dx, z: dz };
    }
    for (const s of this.fadeSurfaces) {
      const playerInside = insideIndex >= 0 && s.buildingIndex === insideIndex;
      let occludesPlayerView: boolean;
      if (towardCamera === null || camera === undefined) {
        occludesPlayerView = false; // no camera (construction prime) → stay opaque
      } else if (playerInside) {
        // Occupied building (V58/V59): roof always occludes from above; a wall fades when it turns toward camera.
        occludesPlayerView = s.kind === 'roof' || s.outwardNormal === null
          ? true
          : wallFacesCamera({
              outwardNormal: s.outwardNormal,
              towardCamera,
              facingDotThreshold: this.visibility.cameraFacingDotThreshold,
            });
      } else if (s.kind === 'upperWall' && s.outwardNormal !== null) {
        // OUTSIDE-WALL cutaway (V62): the player is OUTSIDE this building — fade an exterior wall only when the
        // player hugs it AND it lies between the camera and the player, so it never hides the player. Roofs of
        // un-occupied buildings stay opaque (the player isn't under them). VIEW-only — structural LOS unchanged.
        occludesPlayerView = exteriorWallOccludesPlayer({
          outwardNormal: s.outwardNormal,
          wallCenter: { x: s.centerX, z: s.centerZ },
          player: { x: player.x, z: player.z },
          camera: { x: camera.position.x, z: camera.position.z },
          adjacencyMeters: this.visibility.exteriorCutawayAdjacencyMeters,
        });
      } else {
        occludesPlayerView = false;
      }
      const ctx: OcclusionContext = {
        playerInside,
        occludesPlayerView,
        roomEnclosed: true,
        portalOrLosToCamera: false,
        surfaceHeightMeters: s.heightMeters,
      };
      const decision = resolveSurfaceVisibility(s.kind, ctx, this.visibility);
      const target = decision.visible ? decision.targetOpacity : 0;
      if (dtSeconds <= 0) s.opacity = target;
      else s.opacity += (target - s.opacity) * Math.min(1, fadeRate);
      s.material.opacity = s.opacity;
      // V20 layering: a FADED roof/upper-wall must not depth-occlude the interior floor, blood decals, or units
      // below it (the "blood invisible indoors" root cause). Stop writing depth while faded; restore it when
      // fully opaque so a non-cutaway roof occludes normally.
      s.material.depthWrite = s.opacity >= 0.99;
      // V60: the cutaway is a VIEW AID ONLY — hiding a surface for the camera must NOT change the sim's physical
      // light. A faded roof/wall stays in the scene (visible=true) so it KEEPS casting shadows + occluding light
      // exactly as if solid; only the CAMERA sees through it (opacity). The shadow pass renders it via the depth
      // material, which ignores opacity, so a hidden roof still shadows the interior as a real roof would. (Sound
      // + physics already key off the structural/nav grid, never this mesh, so they were never affected.)
      s.object.visible = true;
    }
  }

  /** Index of the building the player currently occupies, or -1 if they are out on the street/yard. */
  private playerBuildingIndex(): number {
    const p = this.runtime.player();
    const cx = Math.floor(p.x / this.navCellSize);
    const cy = Math.floor(p.z / this.navCellSize);
    const buildings = buildingsOf(this.runtime.scene);
    for (let i = 0; i < buildings.length; i++) {
      const b = buildings[i]!.bounds;
      if (cx >= b.minCx && cx <= b.maxCx && cy >= b.minCy && cy <= b.maxCy) return i;
    }
    return -1;
  }

  private isPlayerInsideBuilding(): boolean {
    return this.playerBuildingIndex() >= 0;
  }

  /** Detach the scene graph. The injected registry owns disposal of tracked geometries/materials (V24). */
  dispose(): void {
    this.scene.clear();
    this.fadeSurfaces.length = 0;
    this.sectionMeshes.length = 0;
    this.aoContact = null;
  }

  /** Test/diagnostics: number of fadeable cutaway surfaces + tracked GPU resources. */
  get debugInfo(): { fadeSurfaces: number; materials: number; geometries: number; sectionGroups: number } {
    return { fadeSurfaces: this.fadeSurfaces.length, materials: this.mats.length, geometries: this.geos.length, sectionGroups: this.sectionMeshes.length };
  }

  /** Test/diagnostics: current opacity of each cutaway surface (roof + upper walls). */
  get debugFadeOpacity(): number[] {
    return this.fadeSurfaces.map((s) => s.opacity);
  }

  /** Test/diagnostics: whether every section mesh for a structural cell is currently hidden (breached). */
  isSectionHidden(structuralCell: number): boolean {
    const s = this.sectionMeshes.find((m) => m.cell === structuralCell);
    return s ? s.objects.every((o) => !o.visible) : false;
  }
}
