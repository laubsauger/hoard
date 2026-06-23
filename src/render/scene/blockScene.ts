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
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
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

/** Full-strength accessibility (the reference experience) — the default until the player opts into a reduction. */
const DEFAULT_ACCESSIBILITY: RenderAccessibility = resolveRenderAccessibility({
  goreIntensity: 1,
  outlineStrength: 1,
  targetHighlightStrength: 1,
  cameraShakeScale: 1,
  reduceFlashes: false,
  motionReduction: false,
});

/** A roof / upper-wall surface that fades for the cutaway (V20). */
interface FadeSurface {
  readonly object: Object3D;
  readonly material: MeshStandardMaterial;
  readonly kind: 'roof' | 'upperWall';
  readonly heightMeters: number;
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
    this.buildWallsAndRoof();
    this.buildDoorsAndWindows();
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
    const ground = new Mesh(
      this.geo('ground.geo', new PlaneGeometry(width + margin, depth + margin)),
      this.mat('ground', { color: 0x23262a, roughness: 0.95 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(width / 2, 0, depth / 2);
    ground.receiveShadow = true;
    this.scene.add(ground);

    // Interior floor slab over the building footprint, slightly raised + lighter so rooms read.
    const b = this.runtime.scene.buildingBounds;
    const fw = (b.maxCx - b.minCx + 1) * this.navCellSize;
    const fd = (b.maxCy - b.minCy + 1) * this.navCellSize;
    const floor = new Mesh(
      this.geo('floor.geo', new PlaneGeometry(fw, fd)),
      this.mat('floor', { color: 0x3a3d38, roughness: 0.9 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set((b.minCx + b.maxCx + 1) / 2 * this.navCellSize, this.world.floorThicknessMeters, (b.minCy + b.maxCy + 1) / 2 * this.navCellSize);
    floor.receiveShadow = true;
    this.scene.add(floor);
  }

  private buildWallsAndRoof(): void {
    const ts = this.runtime.scene;
    const grid = ts.navGrid;
    const wallH = this.world.buildingWallHeightMeters;
    const baseH = Math.min(this.visibility.baseHeightMeters, wallH);
    const upperH = Math.max(0, wallH - baseH);
    const th = Math.min(this.wallPanelThickness, this.navCellSize); // thin shell, never wider than the cell

    // B3: walls are THIN oriented shells on exposed cell edges (not cell-filling blocks). Two geometries per
    // band: one for edges running along X (thickness in Z), one for edges along Z (thickness in X).
    const baseGeoX = this.geo('wallBaseX.geo', new BoxGeometry(this.navCellSize, baseH, th));
    const baseGeoZ = this.geo('wallBaseZ.geo', new BoxGeometry(th, baseH, this.navCellSize));
    const upperGeoX = upperH > 0 ? this.geo('wallUpperX.geo', new BoxGeometry(this.navCellSize, upperH, th)) : null;
    const upperGeoZ = upperH > 0 ? this.geo('wallUpperZ.geo', new BoxGeometry(th, upperH, this.navCellSize)) : null;
    const baseMat = this.mat('wallBase', { color: 0x6b6256, roughness: 0.85 });
    const upperMat = this.mat('wallUpper', { color: 0x6b6256, roughness: 0.85, transparent: true, opacity: 1 });
    const sectionMat = this.mat('section', { color: 0xb04a32, roughness: 0.7 }); // the destructible wall, tinted

    // B3: bias the fading upper-wall faces back + lift them off the retained base so reveal faces never
    // z-fight the coplanar base top / ground (cutaway). Decision is pure (resolveCutawayDepthOffset).
    const upperOffset = resolveCutawayDepthOffset('upperWall', this.cutawayDepth);
    upperMat.polygonOffset = upperOffset.polygonOffset;
    upperMat.polygonOffsetFactor = upperOffset.polygonOffsetFactor;
    upperMat.polygonOffsetUnits = upperOffset.polygonOffsetUnits;
    const upperBottomY = baseH + upperOffset.verticalInsetMeters;

    // structural-section nav cells get distinct, hideable meshes; everything else is a plain wall.
    const sectionByNav = new Map<number, number>(); // navIndex -> structuralCell
    for (let z = 0; z < ts.wall.sizeZ; z++) {
      const sc = ts.wall.packCell(0, 0, z);
      const cell = ts.navCellForStructuralCell(sc);
      sectionByNav.set(grid.index(cell.cx, cell.cy), sc);
    }

    const wallsGroup = new Group();
    const upperGroup = new Group();

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

    for (let cy = 0; cy < grid.height; cy++) {
      for (let cx = 0; cx < grid.width; cx++) {
        const idx = grid.index(cx, cy);
        if (!grid.isBlocked(idx)) continue;
        const wx = (cx + 0.5) * this.navCellSize;
        const wz = (cy + 0.5) * this.navCellSize;
        const sc = sectionByNav.get(idx);
        const exposed = edges(cx, cy);
        // A fully-enclosed wall cell would have no exposed edge — emit a single thin core panel so it still
        // reads (and, for a section cell, still has a hideable mesh for breach). Walls border open space.
        const faces = exposed.length > 0 ? exposed : [{ dx: 0, dz: 1, along: 'x' as const }];
        // T70/B12: a 1-cell-thick wall is open on BOTH sides — emitting a panel per exposed face produced
        // TWO parallel walls a whole cell apart (the "doubled wall + gap"). Emit ONE panel per RUN
        // orientation, CENTRED on the cell: an X-run panel when a north/south face is exposed, a Z-run panel
        // when an east/west face is exposed (a corner cell gets both → an L). No doubling, no gap.
        const orientations: ('x' | 'z')[] = [];
        if (faces.some((f) => f.along === 'x')) orientations.push('x');
        if (faces.some((f) => f.along === 'z')) orientations.push('z');
        if (orientations.length === 0) orientations.push('x');
        const sectionObjs: Object3D[] = [];

        for (const along of orientations) {
          const baseGeo = along === 'x' ? baseGeoX : baseGeoZ;
          const upperGeo = along === 'x' ? upperGeoX : upperGeoZ;

          const base = new Mesh(baseGeo, sc !== undefined ? sectionMat : baseMat);
          base.position.set(wx, baseH / 2, wz); // centred on the cell — one wall line, not two opposite faces
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
    this.scene.add(wallsGroup, upperGroup);
    if (upperH > 0) {
      this.fadeSurfaces.push({ object: upperGroup, material: upperMat, kind: 'upperWall', heightMeters: wallH, opacity: 1 });
    }

    // Roof over the building interior — the primary cutaway occluder (fades when the player is inside).
    const b = ts.buildingBounds;
    const rw = (b.maxCx - b.minCx + 1) * this.navCellSize;
    const rd = (b.maxCy - b.minCy + 1) * this.navCellSize;
    const roofMat = this.mat('roof', { color: 0x4c4a44, roughness: 0.9, transparent: true, opacity: 1 });
    const roofOffset = resolveCutawayDepthOffset('roof', this.cutawayDepth);
    roofMat.polygonOffset = roofOffset.polygonOffset;
    roofMat.polygonOffsetFactor = roofOffset.polygonOffsetFactor;
    roofMat.polygonOffsetUnits = roofOffset.polygonOffsetUnits;
    const roof = new Mesh(this.geo('roof.geo', new PlaneGeometry(rw, rd)), roofMat);
    roof.rotation.x = -Math.PI / 2;
    roof.renderOrder = roofOffset.renderOrder;
    roof.position.set((b.minCx + b.maxCx + 1) / 2 * this.navCellSize, wallH, (b.minCy + b.maxCy + 1) / 2 * this.navCellSize);
    this.scene.add(roof);
    this.fadeSurfaces.push({ object: roof, material: roofMat, kind: 'roof', heightMeters: wallH, opacity: 1 });
  }

  /**
   * T70 — doors + windows so the shell reads as a house. Additive render pass (does not alter the wall
   * grid): a framed door leaf at each exit gap, and glass window panes on a deterministic subset of facade
   * (perimeter) wall cells. Pure content from the authored grid — no magic placement.
   */
  private buildDoorsAndWindows(): void {
    const ts = this.runtime.scene;
    const grid = ts.navGrid;
    const b = ts.buildingBounds;
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

    // ---- WINDOWS: glass panes on a deterministic subset of facade (perimeter) wall cells. ----
    const sillH = wallH * 0.45;
    const winH = wallH * 0.32;
    const paneGeo = this.geo('window.pane.geo', new BoxGeometry(0.08, winH, cs * 0.62));
    const doorAdjacent = (cx: number, cy: number): boolean =>
      ts.exitCells.some((e) => Math.abs(e.cx - cx) + Math.abs(e.cy - cy) <= 1);
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
        const pane = new Mesh(paneGeo, glassMat);
        pane.position.set((cx + 0.5) * cs + nx * 0.02, sillH + winH / 2, (cy + 0.5) * cs + nz * 0.02);
        if (nz !== 0) pane.rotation.y = Math.PI / 2; // pane spans X on a north/south wall
        group.add(pane);
      }
    }

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
  fireFeedback(dirX: number, dirZ: number): void {
    const p = this.runtime.player();
    const muzzleY = this.player.bodyHeightMeters * 0.6;
    this.combat.fire(p.x, muzzleY, p.z, dirX, dirZ);
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
    const playerInside = this.isPlayerInsideBuilding();
    // V29 motion reduction: cut roofs/upper walls instantly rather than animating the fade (less motion).
    const fadeRate = this.accessibility.feedback.reduceMotion
      ? 1
      : this.roofFadeSeconds > 0
        ? dtSeconds / this.roofFadeSeconds
        : 1;
    for (const s of this.fadeSurfaces) {
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
      s.object.visible = s.opacity > 0.02;
    }
  }

  private isPlayerInsideBuilding(): boolean {
    const b = this.runtime.scene.buildingBounds;
    const p = this.runtime.player();
    const cx = Math.floor(p.x / this.navCellSize);
    const cy = Math.floor(p.z / this.navCellSize);
    return cx >= b.minCx && cx <= b.maxCx && cy >= b.minCy && cy <= b.maxCy;
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
