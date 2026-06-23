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
  type Camera,
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Scene,
  SpotLight,
} from 'three';
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
  wallFacesCamera,
  exteriorWallOccludesPlayer,
  wallBetweenPlayerAndCamera,
  clampConeRangeToWall,
  type OcclusionContext,
  type CutawayDepthSettings,
  type VecXZ,
} from '../world/visibility';
import { SceneResources } from './builders/sceneResources';
import type { FadeSurface } from './builders/handles';
import type { BuildContext } from './builders/buildContext';
import { buildGround, buildGroundRects } from './builders/groundBuilder';
import { buildProps } from './builders/propsBuilder';
import { buildContainers } from './builders/containersBuilder';
import { buildPlayer } from './builders/playerBuilder';
import { buildHouses } from './builders/houseBuilder';
import { buildOpenings } from './builders/openingsBuilder';
import { HouseStyleResolver } from './builders/houseStyle';
import { buildingIndexAt } from './systems/playerLocation';
import { BreachSystem } from './systems/breachSystem';
import { DoorSystem } from './systems/doorSystem';
import { WindowSystem } from './systems/windowSystem';
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
import { resolveHouseVariation, hasLineOfSight, rayDistanceToWall } from '../../game/scene';

/** Full-strength accessibility (the reference experience) — the default until the player opts into a reduction. */
const DEFAULT_ACCESSIBILITY: RenderAccessibility = resolveRenderAccessibility({
  goreIntensity: 1,
  outlineStrength: 1,
  targetHighlightStrength: 1,
  cameraShakeScale: 1,
  reduceFlashes: false,
  motionReduction: false,
});


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
  // T87 deterministic per-building house style (V26): owns the variation params + the feature-building index +
  // styleFor(). Assigned in the constructor (needs runtime.scene). Shared by the house + openings builders.
  private readonly houseStyle: HouseStyleResolver;
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
  /** T108 windows: each window's child meshes (glass pane / dark void / boards), keyed by nav cell. syncWindows
   *  toggles their visibility to match the authoritative glass/board state (the render only REFLECTS it, V12). */
  private readonly windowMeshes: { navCell: number; pane: Mesh; voidMesh: Mesh; boards: Mesh[] }[] = [];

  /** Per-frame systems constructed from the builder handles (Phase 2 of the decomposition). */
  private readonly breach = new BreachSystem(this.sectionMeshes);
  private readonly doors = new DoorSystem(this.doorLeaves, {
    swingSpeedRadiansPerSecond: this.structures.doorSwingSpeedRadiansPerSecond,
  });
  private readonly windows = new WindowSystem(this.windowMeshes);

  /** Combat feedback (B7): muzzle flash / tracer / blood / sever, fed by runtime.pollEvents() + fire(). */
  private readonly combat: CombatFeedbackSystem;
  private readonly combatView: CombatFeedbackView;
  /** Smoothed interior/exterior exposure transition 0..1 (B6) — eyes adapting, not a snap. */
  private interiorTransition = 0;
  /** Live tone-mapping exposure (B6) — read by the renderer host each frame. */
  private exposure = 1;

  // shared, tracked GPU-resource factory (V24). Builders create materials/geometries through this; mat/geo/
  // mergeBoxes below delegate to it (kept as thin methods so the many existing call sites stay unchanged).
  // Assigned in the constructor (after `registry`), not as a field initializer — those run before the body.
  private readonly res: SceneResources;

  private tierOf(): QualityTier {
    return this.tier;
  }

  constructor(opts: { runtime: GameRuntime; tier: QualityTier; registry: ResourceRegistry; accessibility?: RenderAccessibility }) {
    this.runtime = opts.runtime;
    this.tier = opts.tier;
    this.registry = opts.registry;
    this.res = new SceneResources(this.registry);
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

    this.houseStyle = new HouseStyleResolver(this.runtime.scene, resolveHouseVariation(this.tier));
    buildGround(this.buildCtx(), { floorThicknessMeters: this.world.floorThicknessMeters });
    buildGroundRects(this.buildCtx());
    const house = buildHouses(this.buildCtx(), this.houseStyle, {
      world: this.world,
      visibility: this.visibility,
      cutawayDepth: this.cutawayDepth,
      wallPanelThickness: this.wallPanelThickness,
      clapboardSpacing: this.clapboardSpacing,
      roofOverhang: this.roofOverhang,
      chimneyMeters: this.chimneyMeters,
      porchHeightMeters: this.porchHeightMeters,
      ivyInstanceCap: this.ivyInstanceCap,
      ivyPatchMeters: this.ivyPatchMeters,
      debrisMeters: this.debrisMeters,
      houseDebrisMaxCount: this.houseDebrisMaxCount,
    });
    this.fadeSurfaces.push(...house.fadeSurfaces);
    this.sectionMeshes.push(...house.sectionMeshes);
    const openings = buildOpenings(this.buildCtx(), this.houseStyle, {
      buildingWallHeightMeters: this.world.buildingWallHeightMeters,
      houseWindowStride: this.world.houseWindowStride,
      windowBoardedFraction: this.windowBoardedFraction,
      openingFrameThicknessMeters: this.structures.openingFrameThicknessMeters,
      doorLeafThicknessMeters: this.structures.doorLeafThicknessMeters,
      doorLeafHeightFraction: this.structures.doorLeafHeightFraction,
      doorLeafWidthFraction: this.structures.doorLeafWidthFraction,
      doorOpenSwingRadians: this.structures.doorOpenSwingRadians,
      maxBoardsPerWindow: this.structures.maxBoardsPerWindow,
    });
    this.doorLeaves.push(...openings.doorLeaves);
    this.windowMeshes.push(...openings.windowMeshes);
    // Prime the visibility from the initial sim state so a window that starts boarded/smashed renders that way.
    this.windows.sync(this.runtime);
    buildProps(this.buildCtx(), {
      fenceMissingChance: this.world.fenceMissingChance,
      fenceBrokenChance: this.world.fenceBrokenChance,
      fenceLeanMaxRadians: this.world.fenceLeanMaxRadians,
      treeDeadChance: this.world.treeDeadChance,
    });
    buildContainers(this.buildCtx(), {
      cupboardWidthMeters: this.structures.cupboardWidthMeters,
      cupboardHeightMeters: this.structures.cupboardHeightMeters,
      cupboardDepthMeters: this.structures.cupboardDepthMeters,
      floorThicknessMeters: this.world.floorThicknessMeters,
    });
    const playerHandles = buildPlayer(this.buildCtx(), {
      bodyRadiusMeters: this.player.bodyRadiusMeters,
      bodyHeightMeters: this.player.bodyHeightMeters,
      baseEmissive: PLAYER_BASE_EMISSIVE,
      outlineStrength: this.accessibility.outlineStrength,
      aoStrength: this.lighting.ambientOcclusionStrength,
      aoRadiusMeters: this.lighting.contactAoRadiusMeters,
    });
    this.playerMesh = playerHandles.mesh;
    this.playerRimMat = playerHandles.rimMat;
    this.aoContact = playerHandles.aoContact;

    this.crowd = new Crowd(resolveCrowdSettings(this.tier), this.registry);
    this.crowd.mesh.castShadow = true; // B13: the horde casts shadows too (was unset → zombies floated shadowless)
    this.crowd.mesh.receiveShadow = true;
    this.scene.add(this.crowd.mesh);

    // Combat feedback (B7): pooled gore + muzzle/tracer, tracked for disposal (V24) and added to the graph.
    const combatSettings = resolveCombatFeedbackSettings(this.tier);
    this.combat = new CombatFeedbackSystem(combatSettings);
    this.combatView = new CombatFeedbackView(combatSettings, this.registry);
    this.combatView.attachTo(this.scene);

    this.breach.sync(this.runtime.scene);
    this.syncFrame(0, undefined);
  }

  /** Narrow build handle handed to the extracted builders (Phase 1 of the decomposition). */
  private buildCtx(): BuildContext {
    return { root: this.scene, res: this.res, town: this.runtime.scene, navCellSize: this.navCellSize };
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
    this.breach.sync(this.runtime.scene);
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

    this.breach.sync(this.runtime.scene);
    this.doors.sync(this.runtime, dtSeconds);
    this.windows.sync(this.runtime);
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
    const maxRange = this.perception.playerVisionRange + this.lighting.flashlightRangeMarginMeters;
    // V67: RAYCAST-CLAMPED cone — clip the beam reach to the first STRUCTURAL wall along the aim so it never shines
    // THROUGH/past a wall the player faces (no light spilling outside the building). Reuses the SAME nav-grid wall
    // raycast the shots (rayDistanceToWall) + perception LOS use — not a second wall representation. A small margin
    // keeps the struck wall face itself lit; a clear aim returns maxRange so the cone is never shortened needlessly.
    const wallDist = rayDistanceToWall(this.runtime.scene, p.x, p.z, aim, maxRange);
    const range = clampConeRangeToWall(maxRange, wallDist, this.lighting.flashlightWallClampMarginMeters);
    f.distance = range;
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
        // Occupied building (V58/V59): roof always occludes from above. A wall fades when it turns toward the
        // camera (V58 directional test) OR — GENERIC player↔camera occlusion (V66) — when its plane actually lies
        // between the player and the camera. The second term catches INTERIOR walls (whose guessed outward normal
        // need not point at the camera) that hide the player on the sightline; the directional term preserves the
        // existing whole-near-side exterior fade. Either making it true fades the wall to the sliver (V65).
        occludesPlayerView = s.kind === 'roof' || s.outwardNormal === null
          ? true
          : wallFacesCamera({
              outwardNormal: s.outwardNormal,
              towardCamera,
              facingDotThreshold: this.visibility.cameraFacingDotThreshold,
            }) ||
            wallBetweenPlayerAndCamera({
              outwardNormal: s.outwardNormal,
              wallCenter: { x: s.centerX, z: s.centerZ },
              player: { x: player.x, z: player.z },
              camera: { x: camera.position.x, z: camera.position.z },
              lateralSpanMeters: this.visibility.occluderLateralSpanMeters,
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
    return buildingIndexAt(this.runtime.scene, this.navCellSize, p.x, p.z);
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
    return { fadeSurfaces: this.fadeSurfaces.length, materials: this.res.materialCount, geometries: this.res.geometryCount, sectionGroups: this.sectionMeshes.length };
  }

  /** Test/diagnostics: current opacity of each cutaway surface (roof + upper walls). */
  get debugFadeOpacity(): number[] {
    return this.fadeSurfaces.map((s) => s.opacity);
  }

  /** Test/diagnostics: whether every section mesh for a structural cell is currently hidden (breached). */
  isSectionHidden(structuralCell: number): boolean {
    return this.breach.isSectionHidden(structuralCell);
  }
}
