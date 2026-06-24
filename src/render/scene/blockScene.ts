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
import type { DebugFlags } from '../../diagnostics/flags';
import {
  resolveVisibilitySettings,
  resolveCutawayDepthSettings,
  type CutawayDepthSettings,
} from '../world/visibility';
import { SceneResources } from './builders/sceneResources';
import type { FadeSurface } from './builders/handles';
import { worldExtent, type BuildContext } from './builders/buildContext';
import { passiveRadiusFromAmbient } from '../world/passiveAwareness';
import { buildGround, buildGroundRects } from './builders/groundBuilder';
import { buildProps } from './builders/propsBuilder';
import { buildContainers } from './builders/containersBuilder';
import { buildFurniture } from './builders/furnitureBuilder';
import { buildPlayer } from './builders/playerBuilder';
import { buildHouses } from './builders/houseBuilder';
import { buildOpenings } from './builders/openingsBuilder';
import { HouseStyleResolver } from './builders/houseStyle';
import { buildingIndexAt } from './systems/playerLocation';
import { BreachSystem } from './systems/breachSystem';
import { DoorSystem } from './systems/doorSystem';
import { WindowSystem } from './systems/windowSystem';
import { VisionCullSystem } from './systems/visionCullSystem';
import { FogOfWarSystem } from './systems/fogOfWarSystem';
import { LightingSystem } from './systems/lightingSystem';
import { FlashlightSystem } from './systems/flashlightSystem';
import { CutawaySystem } from './systems/cutawaySystem';
import {
  CombatFeedbackSystem,
  CombatFeedbackView,
  resolveCombatFeedbackSettings,
} from '../effects/combatFeedback';
import type { VisualEvent } from '../../game/core/contracts/events';
import { resolveRenderAccessibility, type RenderAccessibility } from '../accessibility';
import type { GameRuntime } from '../../game/runtime';
import { resolveHouseVariation } from '../../game/scene';

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
  private readonly clapboardGrooveDarken = resolve(renderingConfig.houseClapboardGrooveDarken, this.tierOf());
  private readonly clapboardGrooveWidthRatio = resolve(renderingConfig.houseClapboardGrooveWidthRatio, this.tierOf());
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
  /** PLAYER PERCEPTION v2 (V62): owns the RENDER-side recently-seen memory + per-slot reveal buffer (V26).
   *  Assigned in the constructor (needs the live SoA capacity). */
  private readonly visionCull: VisionCullSystem;
  /** Per-building cutaway (V59/V20/V60) — assigned in the constructor (needs the resolved navCellSize). */
  private readonly cutaway: CutawaySystem;
  /** Fog of war (T109/V73) — owns the per-cell visited+visible grid + ground overlay. Assigned in the
   *  constructor (needs the scene extent + registry). Resolved-on/off + dim levels live in the rendering config. */
  private readonly fogOfWar: FogOfWarSystem;
  private fogOfWarEnabled = true;
  /** Live ambient-scaled passive awareness radius bounds (T109/V72) — the night floor + bright-midday ceiling. */
  private readonly passiveRadiusMinMeters = this.perception.playerNearAwarenessRadiusMeters;
  private readonly passiveRadiusMaxMeters = this.perception.passiveAwarenessRadiusMaxMeters;

  /** Combat feedback (B7): muzzle flash / tracer / blood / sever, fed by runtime.pollEvents() + fire(). */
  private readonly combat: CombatFeedbackSystem;
  private readonly combatView: CombatFeedbackView;
  /** Lighting + flashlight (B5/B6/T98) — constructed in the constructor (need the live lights). Lighting owns
   *  the interior-transition + exposure smoothing state; the orchestrator passes its brightness to the flashlight. */
  private readonly lightingSys: LightingSystem;
  private readonly flashlightSys: FlashlightSystem;

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
    this.visionCull = new VisionCullSystem(this.runtime.zombies.capacity, {
      playerFieldOfViewDegrees: this.perception.playerFieldOfViewDegrees,
      playerVisionRange: this.perception.playerVisionRange,
      playerVisionRangeFadeMeters: this.perception.playerVisionRangeFadeMeters,
      playerVisionConeFadeDegrees: this.perception.playerVisionConeFadeDegrees,
      playerNearAwarenessRadiusMeters: this.perception.playerNearAwarenessRadiusMeters,
      hearingRange: this.perception.hearingRange,
      soundWallOcclusion: this.perception.soundWallOcclusion,
      playerSightMemorySeconds: this.perception.playerSightMemorySeconds,
    });
    this.cutaway = new CutawaySystem(this.fadeSurfaces, {
      visibility: this.visibility,
      roofFadeSeconds: this.roofFadeSeconds,
    });

    // Fog of war (T109/V73): a per-cell visited+visible grid (1 cell == 1 nav cell) + a ground overlay darkening
    // unexplored/explored world. Resolved with the LIVE tier (so the mobile-webgpu disable applies). The overlay
    // mesh is added to the graph below; per-frame reveal runs in syncFrame after lighting (needs the brightness).
    const navGrid = this.runtime.scene.navGrid;
    const ext = worldExtent(this.runtime.scene, this.navCellSize);
    this.fogOfWarEnabled = resolve(renderingConfig.fogOfWarEnabled, this.tierOf());
    this.fogOfWar = new FogOfWarSystem(this.registry, {
      cols: navGrid.width,
      rows: navGrid.height,
      cellSize: this.navCellSize,
      worldWidth: ext.width,
      worldDepth: ext.depth,
      cone: {
        fovDegrees: this.perception.playerFieldOfViewDegrees,
        range: this.perception.playerVisionRange,
        rangeFadeMeters: this.perception.playerVisionRangeFadeMeters,
        coneFadeDegrees: this.perception.playerVisionConeFadeDegrees,
      },
      dims: {
        exploredDim: resolve(renderingConfig.fogOfWarExploredDim, this.tierOf()),
        unexploredDim: resolve(renderingConfig.fogOfWarUnexploredDim, this.tierOf()),
      },
      fadePerSecond: resolve(renderingConfig.fogOfWarFadePerSecond, this.tierOf()),
      heightMeters: resolve(renderingConfig.fogOfWarHeightMeters, this.tierOf()),
      color: resolve(renderingConfig.fogOfWarColor, this.tierOf()),
    });
    this.scene.add(this.fogOfWar.mesh);

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

    this.lightingSys = new LightingSystem(
      { scene: this.scene, sun: this.sun, ambient: this.ambient, hemi: this.hemi, fog: this.fog },
      {
        tier: this.tier,
        navCellSize: this.navCellSize,
        shadowLightDistanceMeters: this.shadows.shadowLightDistanceMeters,
        baseExposure: this.baseExposure,
        exposureTransitionSeconds: this.exposureTransitionSeconds,
        sunIntensity: this.lighting.sunIntensity,
        moonIntensity: this.lighting.moonIntensity,
        ambientIntensity: this.lighting.ambientIntensity,
        minAmbientIntensity: this.lighting.minAmbientIntensity,
        fogDistanceSmoothingPerSecond: this.lighting.fogDistanceSmoothingPerSecond,
        fogFloorLuminance: this.lighting.fogFloorLuminance,
        nightExposureBoostStops: this.lighting.nightExposureBoostStops,
        weather: {
          sunElevationMaxDegrees: this.weatherCfg.sunElevationMaxDegrees,
          moonElevationMaxDegrees: this.weatherCfg.moonElevationMaxDegrees,
          sunAzimuthDegrees: this.weatherCfg.sunAzimuthDegrees,
        },
      },
    );
    this.flashlightSys = new FlashlightSystem(this.flashlight, {
      intensity: this.lighting.flashlightIntensity,
      rangeMarginMeters: this.lighting.flashlightRangeMarginMeters,
      wallClampMarginMeters: this.lighting.flashlightWallClampMarginMeters,
      heightMeters: this.lighting.flashlightHeightMeters,
      dayIntensityScale: this.lighting.flashlightDayIntensityScale,
      visionRange: this.perception.playerVisionRange,
    });

    this.houseStyle = new HouseStyleResolver(this.runtime.scene, resolveHouseVariation(this.tier));
    buildGround(this.buildCtx(), { floorThicknessMeters: this.world.floorThicknessMeters });
    buildGroundRects(this.buildCtx());
    const house = buildHouses(this.buildCtx(), this.houseStyle, {
      world: this.world,
      visibility: this.visibility,
      cutawayDepth: this.cutawayDepth,
      wallPanelThickness: this.wallPanelThickness,
      houseWindowStride: this.world.houseWindowStride,
      windowBoardedFraction: this.windowBoardedFraction,
      clapboardSpacing: this.clapboardSpacing,
      clapboardGrooveDarken: this.clapboardGrooveDarken,
      clapboardGrooveWidthRatio: this.clapboardGrooveWidthRatio,
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
      wallPanelThickness: this.wallPanelThickness,
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
    // P1c: furniture meshes (interior content — revealed by the cutaway, NOT a fade surface). Stands on the
    // per-room floor slab; one InstancedMesh per colour keeps the whole street's furniture draw-call cheap.
    buildFurniture(this.buildCtx(), { floorThicknessMeters: this.world.floorThicknessMeters });
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
    // PRESERVE ORDER (B6/T98/T109): lighting resolves the scene brightness the flashlight + the passive
    // awareness radius consume. Lighting reads only the clock/weather/player (independent of crowd/doors), so it
    // runs FIRST this frame and the ambient-scaled passive radius is ready for BOTH the crowd reveal and the fog.
    const { sceneBrightness } = this.lightingSys.update(dtSeconds, this.runtime);
    // T109/V72: ambient-scaled MINIMUM passive awareness radius — small at night (you only sense the flashlight
    // wedge + what is right beside you), large at bright midday (you see all around you on an open street). Fed
    // as the omnidirectional near-reveal radius to BOTH the crowd reveal + the fog of war; still LOS-gated (V63).
    const passiveRadiusMeters = passiveRadiusFromAmbient(sceneBrightness, {
      minRadiusMeters: this.passiveRadiusMinMeters,
      maxRadiusMeters: this.passiveRadiusMaxMeters,
    });

    // Compact live crowd inputs into the GPU storage buffers; the transform mat4 + animation phase are
    // assembled by renderer.compute(crowd.computeNode) in the frame loop (wired in GameViewport). When the
    // vision-cone fog-of-war is on, only members inside the player's wedge (cone+range+LOS) are packed (T98).
    // The construction-time prime / rebind (no flags) packs the FULL crowd — the cull is a live-loop concern.
    const visibility = flags && this.visionConeCullOn ? this.visionCull.build(this.runtime, dtSeconds, passiveRadiusMeters) : undefined;
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
    this.flashlightSys.update(this.runtime, sceneBrightness, this.flashlightOn);
    this.cutaway.update(this.runtime, camera, dtSeconds, this.accessibility.feedback.reduceMotion);
    // T109/V73: recompute the fog-of-war visible set (cone ∪ passive disc, LOS-gated) + age the ground overlay.
    // A pure VIEW — never mutates the sim/nav (V2/V63). Runs every frame so exploration accrues regardless of dev
    // toggles; the master enable lives in the rendering config (off on mobile).
    this.fogOfWar.update(this.runtime, passiveRadiusMeters, dtSeconds, this.fogOfWarEnabled);

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
    return this.lightingSys.currentExposure;
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
