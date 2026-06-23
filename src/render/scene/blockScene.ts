// T38 — the city-block render scene: the place the direct Three.js engine finally DRAWS the assembled
// systems. Builds structural geometry (street + multi-room building walls/floors/roof + the destructible
// wall section) from the authored TestBlock, an InstancedMesh crowd fed by the SoA via the existing
// packing path, and sun/moon + ambient lighting driven by the sim clock. Per-frame it syncs the crowd,
// the player avatar, breach visibility, the day/night key light, and the cutaway roof fade (V20). All GPU
// resources are tracked in the injected ResourceRegistry for explicit disposal (V24). React never reads
// world state back through this (V1) — it only consumes the runtime's throttled snapshots elsewhere.

import {
  AmbientLight,
  BoxGeometry,
  type BufferGeometry,
  type Camera,
  Color,
  CylinderGeometry,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  IcosahedronGeometry,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  CapsuleGeometry,
  Scene,
} from 'three';
import { resolve } from '../../config/spec';
import { resolveDomain } from '../../config/registry';
import { worldConfig } from '../../config/domains/world';
import { playerConfig } from '../../config/domains/player';
import { lightingConfig } from '../../config/domains/lighting';
import { weatherConfig } from '../../config/domains/weather';
import { renderingConfig } from '../../config/domains/rendering';
import { postFXConfig } from '../../config/domains/postFX';
import { shadowsConfig } from '../../config/domains/shadows';
import type { QualityTier } from '../../config/types';
import type { ResourceRegistry } from '../engine/resources';
import type { ToneMappingMode } from '../engine/renderer';
import { Crowd, resolveCrowdSettings } from '../crowd/crowd';
import {
  resolveSurfaceVisibility,
  resolveVisibilitySettings,
  resolveCutawayDepthSettings,
  resolveCutawayDepthOffset,
  type OcclusionContext,
  type CutawayDepthSettings,
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
import { buildingsOf, type GroundKind, type PropKind } from '../../game/scene';

/** Full-strength accessibility (the reference experience) — the default until the player opts into a reduction. */
const DEFAULT_ACCESSIBILITY: RenderAccessibility = resolveRenderAccessibility({
  goreIntensity: 1,
  outlineStrength: 1,
  targetHighlightStrength: 1,
  cameraShakeScale: 1,
  reduceFlashes: false,
  motionReduction: false,
});

/** A roof / upper-wall surface that fades for the cutaway (V20). In a multi-building district each building
 *  owns its own roof + upper-wall surfaces tagged with `buildingIndex`, so ONLY the building the player is
 *  inside fades (per-building cutaway, V57) — neighbours stay opaque. */
interface FadeSurface {
  readonly object: Object3D;
  readonly material: MeshStandardMaterial;
  readonly kind: 'roof' | 'upperWall';
  readonly heightMeters: number;
  readonly buildingIndex: number;
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
  private readonly player = resolveDomain(playerConfig, this.tierOf());
  private readonly lighting = resolveDomain(lightingConfig, this.tierOf());
  private readonly weatherCfg = resolveDomain(weatherConfig, this.tierOf());
  private readonly shadows = resolveDomain(shadowsConfig, this.tierOf());
  private readonly visibility = resolveVisibilitySettings(this.tierOf());
  private readonly cutawayDepth: CutawayDepthSettings = resolveCutawayDepthSettings(this.tierOf());
  private readonly roofFadeSeconds = resolve(renderingConfig.roofFadeSeconds, this.tierOf());
  private readonly wallPanelThickness = resolve(renderingConfig.wallPanelThicknessMeters, this.tierOf());
  /** Tone-mapping operator + base exposure (B6) — applied to the renderer by the host each frame. */
  readonly toneMappingMode = resolve(postFXConfig.toneMappingMode, this.tierOf()) as ToneMappingMode;
  private readonly baseExposure = resolve(postFXConfig.baseExposure, this.tierOf());
  private readonly exposureTransitionSeconds = resolve(lightingConfig.exposureTransitionSeconds, this.tierOf());

  private readonly navCellSize: number;
  private readonly sun: DirectionalLight;
  private readonly ambient: AmbientLight;
  private readonly hemi: HemisphereLight;
  private readonly fog: Fog;
  private readonly playerMesh: Object3D;
  private readonly fadeSurfaces: FadeSurface[] = [];
  /** structuralCell -> the section meshes to hide once that cell is breached. */
  private readonly sectionMeshes: { cell: number; objects: Object3D[] }[] = [];

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

    this.scene.background = new Color(0x0b0d0a);
    this.fog = new Fog(0x0b0d0a, 1, 400);
    this.scene.fog = this.fog;

    this.ambient = new AmbientLight(0xffffff, this.lighting.ambientIntensity);
    this.hemi = new HemisphereLight(0xa7b8c8, 0x2a2620, this.lighting.ambientIntensity * 0.5);
    this.sun = new DirectionalLight(0xfff2dc, this.lighting.sunIntensity);
    this.sun.castShadow = true;
    // B13/V36: size the directional shadow ortho frustum to cover the block + set resolution/bias so the
    // key actually casts readable shadows (renderer.shadowMap is enabled in the WebGPU backend).
    {
      const ext = this.worldExtent();
      // Cap the half-extent so the shadow map stays sharp; the frustum is re-centred on the player each
      // frame (syncLighting) so it always covers the play area without a hard cut-off at world origin.
      const half = Math.min(Math.max(ext.width, ext.depth) * 0.6, 55);
      const sc = this.sun.shadow.camera;
      sc.left = -half;
      sc.right = half;
      sc.top = half;
      sc.bottom = -half;
      sc.near = 1;
      sc.far = 220;
      sc.updateProjectionMatrix();
      this.sun.shadow.mapSize.set(this.shadows.shadowMapResolution, this.shadows.shadowMapResolution);
      this.sun.shadow.bias = -0.0005;
    }
    this.scene.add(this.ambient, this.hemi, this.sun, this.sun.target);

    this.buildGround();
    this.buildGroundRects();
    this.buildWallsAndRoof();
    this.buildDoorsAndWindows();
    this.buildProps();
    this.playerMesh = this.buildPlayer();
    this.scene.add(this.playerMesh);

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

  private worldExtent(): { width: number; depth: number } {
    return {
      width: this.runtime.scene.navGrid.width * this.navCellSize,
      depth: this.runtime.scene.navGrid.height * this.navCellSize,
    };
  }

  private buildGround(): void {
    const { width, depth } = this.worldExtent();
    const margin = this.navCellSize * 4;
    // Base ground = grass/dirt verge under the whole district; the suburban paint (asphalt street, concrete
    // sidewalk, grass yards) is layered on top by buildGroundRects.
    const ground = new Mesh(
      this.geo('ground.geo', new PlaneGeometry(width + margin, depth + margin)),
      this.mat('ground', { color: 0x2a3120, roughness: 0.98 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(width / 2, 0, depth / 2);
    ground.receiveShadow = true;
    this.scene.add(ground);

    // Per-building interior floor slab — slightly raised + lighter so each house's rooms read (multi-building).
    const floorMat = this.mat('floor', { color: 0x3a3d38, roughness: 0.9 });
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

  /** Suburban ground paint (T80): asphalt street, concrete sidewalk, grass yards as flat coloured quads
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

  private buildWallsAndRoof(): void {
    const ts = this.runtime.scene;
    const grid = ts.navGrid;
    const buildings = buildingsOf(ts);
    const th = Math.min(this.wallPanelThickness, this.navCellSize); // thin shell, never wider than the cell
    const baseHeightCap = this.visibility.baseHeightMeters;

    // shared (never-fade) materials: plain wall base + the tinted destructible section.
    const baseMat = this.mat('wallBase', { color: 0x6b6256, roughness: 0.85 });
    const sectionMat = this.mat('section', { color: 0xb04a32, roughness: 0.7 });

    // B3: bias fading upper-wall + roof faces back + lift them off the retained base so reveal faces never
    // z-fight the coplanar base top / ground (cutaway). Decisions are pure (resolveCutawayDepthOffset).
    const upperOffset = resolveCutawayDepthOffset('upperWall', this.cutawayDepth);
    const roofOffset = resolveCutawayDepthOffset('roof', this.cutawayDepth);

    // structural-section nav cells get distinct, hideable meshes; everything else is a plain wall (global).
    const sectionByNav = new Map<number, number>(); // navIndex -> structuralCell
    for (let z = 0; z < ts.wall.sizeZ; z++) {
      const sc = ts.wall.packCell(0, 0, z);
      const cell = ts.navCellForStructuralCell(sc);
      sectionByNav.set(grid.index(cell.cx, cell.cy), sc);
    }

    // The exposed edges of a blocked cell (neighbor open or out of bounds): where a real wall face lives.
    const edges = (cx: number, cy: number): ('x' | 'z')[] => {
      const open = (nx: number, ny: number): boolean =>
        nx < 0 || ny < 0 || nx >= grid.width || ny >= grid.height || !grid.isBlocked(grid.index(nx, ny));
      const out: ('x' | 'z')[] = [];
      if (open(cx, cy - 1) || open(cx, cy + 1)) out.push('x');
      if (open(cx + 1, cy) || open(cx - 1, cy)) out.push('z');
      return out;
    };

    // shared wall base group (base walls never fade); cache wall geometries by per-storey height.
    const wallsGroup = new Group();
    this.scene.add(wallsGroup);
    const geoCache = new Map<string, { baseGeoX: BoxGeometry; baseGeoZ: BoxGeometry; upperGeoX: BoxGeometry | null; upperGeoZ: BoxGeometry | null }>();

    buildings.forEach((bld, bi) => {
      const wallH = this.world.buildingWallHeightMeters * Math.max(1, bld.storeys ?? 1);
      const baseH = Math.min(baseHeightCap, wallH);
      const upperH = Math.max(0, wallH - baseH);
      const upperBottomY = baseH + upperOffset.verticalInsetMeters;

      const key = `${baseH.toFixed(3)}_${upperH.toFixed(3)}`;
      let g = geoCache.get(key);
      if (!g) {
        g = {
          baseGeoX: this.geo(`wallBaseX.${key}`, new BoxGeometry(this.navCellSize, baseH, th)),
          baseGeoZ: this.geo(`wallBaseZ.${key}`, new BoxGeometry(th, baseH, this.navCellSize)),
          upperGeoX: upperH > 0 ? this.geo(`wallUpperX.${key}`, new BoxGeometry(this.navCellSize, upperH, th)) : null,
          upperGeoZ: upperH > 0 ? this.geo(`wallUpperZ.${key}`, new BoxGeometry(th, upperH, this.navCellSize)) : null,
        };
        geoCache.set(key, g);
      }

      // each building owns its upper-wall + roof materials so they fade INDEPENDENTLY (per-building cutaway).
      const upperMat = this.mat(`wallUpper.${bi}`, { color: 0x6b6256, roughness: 0.85, transparent: true, opacity: 1 });
      upperMat.polygonOffset = upperOffset.polygonOffset;
      upperMat.polygonOffsetFactor = upperOffset.polygonOffsetFactor;
      upperMat.polygonOffsetUnits = upperOffset.polygonOffsetUnits;
      const upperGroup = new Group();

      const b = bld.bounds;
      for (let cy = b.minCy; cy <= b.maxCy; cy++) {
        for (let cx = b.minCx; cx <= b.maxCx; cx++) {
          const idx = grid.index(cx, cy);
          if (!grid.isBlocked(idx)) continue;
          const wx = (cx + 0.5) * this.navCellSize;
          const wz = (cy + 0.5) * this.navCellSize;
          const sc = sectionByNav.get(idx);
          // T70/B12: ONE centred panel per run orientation (an X-run when a N/S face is exposed, a Z-run when
          // an E/W face is exposed; a corner gets both → an L). No doubling, no gap.
          const orientations = edges(cx, cy);
          if (orientations.length === 0) orientations.push('x');
          const sectionObjs: Object3D[] = [];

          for (const along of orientations) {
            const baseGeo = along === 'x' ? g.baseGeoX : g.baseGeoZ;
            const upperGeo = along === 'x' ? g.upperGeoX : g.upperGeoZ;

            const base = new Mesh(baseGeo, sc !== undefined ? sectionMat : baseMat);
            base.position.set(wx, baseH / 2, wz);
            base.castShadow = true;
            base.receiveShadow = true;
            wallsGroup.add(base);
            if (sc !== undefined) sectionObjs.push(base);

            if (upperGeo) {
              const upper = new Mesh(upperGeo, sc !== undefined ? sectionMat : upperMat);
              upper.position.set(wx, upperBottomY + upperH / 2, wz);
              upper.castShadow = true;
              if (sc !== undefined) {
                // Destructible section: stays opaque + hideable on breach (does NOT fade with the cutaway).
                wallsGroup.add(upper);
                sectionObjs.push(upper);
              } else {
                upper.renderOrder = upperOffset.renderOrder;
                upperGroup.add(upper);
              }
            }
          }
          if (sc !== undefined) this.sectionMeshes.push({ cell: sc, objects: sectionObjs });
        }
      }

      this.scene.add(upperGroup);
      if (upperH > 0) {
        this.fadeSurfaces.push({ object: upperGroup, material: upperMat, kind: 'upperWall', heightMeters: wallH, buildingIndex: bi, opacity: 1 });
      }

      // Roof over this building's interior — the primary cutaway occluder (fades when the player is inside it).
      const rw = (b.maxCx - b.minCx + 1) * this.navCellSize;
      const rd = (b.maxCy - b.minCy + 1) * this.navCellSize;
      const roofMat = this.mat(`roof.${bi}`, { color: 0x4c4a44, roughness: 0.9, transparent: true, opacity: 1 });
      roofMat.polygonOffset = roofOffset.polygonOffset;
      roofMat.polygonOffsetFactor = roofOffset.polygonOffsetFactor;
      roofMat.polygonOffsetUnits = roofOffset.polygonOffsetUnits;
      const roof = new Mesh(this.geo(`roof.geo.${bi}`, new PlaneGeometry(rw, rd)), roofMat);
      roof.rotation.x = -Math.PI / 2;
      roof.renderOrder = roofOffset.renderOrder;
      roof.position.set(((b.minCx + b.maxCx + 1) / 2) * this.navCellSize, wallH, ((b.minCy + b.maxCy + 1) / 2) * this.navCellSize);
      this.scene.add(roof);
      this.fadeSurfaces.push({ object: roof, material: roofMat, kind: 'roof', heightMeters: wallH, buildingIndex: bi, opacity: 1 });
    });
  }

  /** Decorative district dressing (T80): abandoned cars, tires, bushes, trees, picket fences. Shared
   *  geometry + material per kind (built lazily), positioned at the authored cell. Static; not nav-blocking. */
  private buildProps(): void {
    const props = this.runtime.scene.props;
    if (!props || props.length === 0) return;
    const cs = this.navCellSize;
    const group = new Group();

    // lazily-built shared resources per prop kind (tracked for disposal, V24).
    const fenceMat = this.mat('prop.fence', { color: 0x4a3a2a, roughness: 0.9 });
    const tireMat = this.mat('prop.tire', { color: 0x161616, roughness: 0.95 });
    const bushMat = this.mat('prop.bush', { color: 0x33491f, roughness: 1 });
    const trunkMat = this.mat('prop.trunk', { color: 0x39281a, roughness: 0.95 });
    const foliageMat = this.mat('prop.foliage', { color: 0x2c4a24, roughness: 1 });
    const carBodyMat = this.mat('prop.carBody', { color: 0x5a5247, roughness: 0.7, metalness: 0.2 });
    const carCabinMat = this.mat('prop.carCabin', { color: 0x2b3036, roughness: 0.5, metalness: 0.2 });

    const fenceGeo = this.geo('prop.fence.geo', new BoxGeometry(cs * 0.92, 1.0, 0.08));
    const tireGeo = this.geo('prop.tire.geo', new CylinderGeometry(0.34, 0.34, 0.38, 12));
    const bushGeo = this.geo('prop.bush.geo', new IcosahedronGeometry(0.75, 0));
    const trunkGeo = this.geo('prop.trunk.geo', new CylinderGeometry(0.18, 0.24, 2.2, 7));
    const foliageGeo = this.geo('prop.foliage.geo', new IcosahedronGeometry(1.5, 0));
    const carBodyGeo = this.geo('prop.carBody.geo', new BoxGeometry(2.0, 0.9, 4.2));
    const carCabinGeo = this.geo('prop.carCabin.geo', new BoxGeometry(1.8, 0.8, 2.0));

    const build: Record<PropKind, (cx: number, cy: number, rot: number, variant: number) => void> = {
      fence: (cx, cy, rot) => {
        const m = new Mesh(fenceGeo, fenceMat);
        m.position.set((cx + 0.5) * cs, 0.5, (cy + 0.5) * cs);
        m.rotation.y = rot;
        m.castShadow = true;
        m.receiveShadow = true;
        group.add(m);
      },
      tire: (cx, cy) => {
        const m = new Mesh(tireGeo, tireMat);
        m.rotation.x = Math.PI / 2;
        m.position.set((cx + 0.5) * cs, 0.19, (cy + 0.5) * cs);
        m.castShadow = true;
        group.add(m);
      },
      bush: (cx, cy, _rot, variant) => {
        const m = new Mesh(bushGeo, bushMat);
        const s = 0.8 + variant * 0.25;
        m.scale.set(s, s * 0.8, s);
        m.position.set((cx + 0.5) * cs, 0.5 * s, (cy + 0.5) * cs);
        m.castShadow = true;
        m.receiveShadow = true;
        group.add(m);
      },
      tree: (cx, cy, _rot, variant) => {
        const x = (cx + 0.5) * cs;
        const z = (cy + 0.5) * cs;
        const trunk = new Mesh(trunkGeo, trunkMat);
        trunk.position.set(x, 1.1, z);
        trunk.castShadow = true;
        const foliage = new Mesh(foliageGeo, foliageMat);
        const s = 1 + variant * 0.3;
        foliage.scale.setScalar(s);
        foliage.position.set(x, 2.6, z);
        foliage.castShadow = true;
        group.add(trunk, foliage);
      },
      car: (cx, cy, rot) => {
        const x = (cx + 0.5) * cs;
        const z = (cy + 0.5) * cs;
        const body = new Mesh(carBodyGeo, carBodyMat);
        body.position.set(x, 0.55, z);
        body.rotation.y = rot;
        body.castShadow = true;
        body.receiveShadow = true;
        const cabin = new Mesh(carCabinGeo, carCabinMat);
        cabin.position.set(x, 1.3, z);
        cabin.rotation.y = rot;
        cabin.castShadow = true;
        group.add(body, cabin);
      },
    };

    for (const p of props) build[p.kind](p.cx, p.cy, p.rot ?? 0, p.variant ?? 0);
    this.scene.add(group);
  }

  /**
   * T70 — doors + windows so the shell reads as a house. Additive render pass (does not alter the wall
   * grid): a framed door leaf at each exit gap, and glass window panes on a deterministic subset of facade
   * (perimeter) wall cells. Pure content from the authored grid — no magic placement.
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

    // ---- DOORS: a frame (posts + lintel) + an ajar leaf at each exit gap (exit gaps run along Z). ----
    const postGeo = this.geo('door.post.geo', new BoxGeometry(0.14, wallH, 0.14));
    const lintelGeo = this.geo('door.lintel.geo', new BoxGeometry(0.2, 0.2, cs));
    const leafGeo = this.geo('door.leaf.geo', new BoxGeometry(0.06, wallH * 0.82, cs * 0.8));
    for (const cell of ts.exitCells) {
      const wx = (cell.cx + 0.5) * cs;
      const wz = (cell.cy + 0.5) * cs;
      const post1 = new Mesh(postGeo, frameMat);
      post1.position.set(wx, wallH / 2, wz - cs / 2);
      post1.castShadow = true;
      const post2 = new Mesh(postGeo, frameMat);
      post2.position.set(wx, wallH / 2, wz + cs / 2);
      post2.castShadow = true;
      const lintel = new Mesh(lintelGeo, frameMat);
      lintel.position.set(wx, wallH - 0.1, wz);
      lintel.castShadow = true;
      const leaf = new Mesh(leafGeo, leafMat);
      leaf.position.set(wx, wallH * 0.41, wz - cs * 0.3);
      leaf.rotation.y = 0.5; // hinged ajar
      leaf.castShadow = true;
      group.add(post1, post2, lintel, leaf);
    }

    // ---- WINDOWS: glass panes on a deterministic subset of facade (perimeter) wall cells, per building. ----
    const doorAdjacent = (cx: number, cy: number): boolean =>
      ts.exitCells.some((e) => Math.abs(e.cx - cx) + Math.abs(e.cy - cy) <= 1);
    buildingsOf(ts).forEach((bld, bi) => {
      const b = bld.bounds;
      const bWallH = wallH * Math.max(1, bld.storeys ?? 1);
      const sillH = this.world.buildingWallHeightMeters * 0.45; // ground-floor sill height (consistent)
      const winH = this.world.buildingWallHeightMeters * 0.32;
      const paneGeo = this.geo(`window.pane.geo.${bi}`, new BoxGeometry(0.08, winH, cs * 0.62));
      // a second-storey band of windows on two-storey houses.
      const sills = bWallH > this.world.buildingWallHeightMeters * 1.1 ? [sillH, sillH + this.world.buildingWallHeightMeters] : [sillH];
      let wi = 0;
      for (let cy = b.minCy; cy <= b.maxCy; cy++) {
        for (let cx = b.minCx; cx <= b.maxCx; cx++) {
          const onEdge = cx === b.minCx || cx === b.maxCx || cy === b.minCy || cy === b.maxCy;
          if (!onEdge || !grid.isBlocked(grid.index(cx, cy))) continue;
          const corner = (cx === b.minCx || cx === b.maxCx) && (cy === b.minCy || cy === b.maxCy);
          if (corner || doorAdjacent(cx, cy)) {
            wi += 1;
            continue;
          }
          if (wi++ % 2 !== 0) continue; // every other facade cell gets a window (deterministic)
          let nx = 0;
          let nz = 0;
          if (cx === b.minCx) nx = -1;
          else if (cx === b.maxCx) nx = 1;
          else if (cy === b.minCy) nz = -1;
          else nz = 1;
          for (const sy of sills) {
            const pane = new Mesh(paneGeo, glassMat);
            pane.position.set((cx + 0.5) * cs + nx * 0.02, sy + winH / 2, (cy + 0.5) * cs + nz * 0.02);
            if (nz !== 0) pane.rotation.y = Math.PI / 2; // pane spans X on a north/south wall
            group.add(pane);
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
  syncFrame(dtSeconds: number, camera: Camera | undefined): void {
    // Compact live crowd inputs into the GPU storage buffers; the transform mat4 + animation phase are
    // assembled by renderer.compute(crowd.computeNode) in the frame loop (wired in GameViewport).
    this.crowd.update(this.runtime.zombies.views, this.runtime.zombies.count, dtSeconds);

    const p = this.runtime.player();
    this.playerMesh.position.set(p.x, 0, p.z);
    // B8/V41: single-source the aim heading. playerAim() is atan2(dz,dx); the avatar's nose is local +x,
    // so the Y-rotation that points +x at world heading h is exactly -h (NO +π/2 offset — that bug left
    // the player facing 90° off the cursor).
    this.playerMesh.rotation.y = -this.runtime.playerAim();

    this.syncBreach();
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

  private syncBreach(): void {
    for (const s of this.sectionMeshes) {
      const breached = this.runtime.scene.wall.isBreached(s.cell);
      for (const o of s.objects) o.visible = !breached;
    }
  }

  private syncLighting(dtSeconds: number): void {
    const severity = this.runtime.weatherSeverity;
    const sky = computeSkyState(this.runtime.timeOfDay(), this.lighting, this.weatherCfg, severity);

    const dist = 60;
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
  }

  private syncCutaway(dtSeconds: number, camera: Camera | undefined): void {
    // Per-building cutaway (V57): only the building the player currently occupies fades; its neighbours stay
    // opaque so the district still reads as solid streets of houses.
    const insideIndex = this.playerBuildingIndex();
    // V29 motion reduction: cut roofs/upper walls instantly rather than animating the fade (less motion).
    const fadeRate = this.accessibility.feedback.reduceMotion
      ? 1
      : this.roofFadeSeconds > 0
        ? dtSeconds / this.roofFadeSeconds
        : 1;
    for (const s of this.fadeSurfaces) {
      const playerInside = s.buildingIndex === insideIndex;
      const ctx: OcclusionContext = {
        playerInside,
        // The top-down tactical camera looking into an enclosed room is occluded by its roof/upper walls.
        occludesPlayerView: playerInside && camera !== undefined,
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
      s.object.visible = s.opacity > 0.02;
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
