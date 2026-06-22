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
import type { QualityTier } from '../../config/types';
import type { ResourceRegistry } from '../engine/resources';
import { Crowd, resolveCrowdSettings } from '../crowd/crowd';
import { resolveSurfaceVisibility, resolveVisibilitySettings, type OcclusionContext } from '../world/visibility';
import { fogTransmittance } from '../lighting/lighting';
import { computeSkyState } from './sky';
import type { GameRuntime } from '../../game/runtime';

/** A roof / upper-wall surface that fades for the cutaway (V20). */
interface FadeSurface {
  readonly object: Object3D;
  readonly material: MeshStandardMaterial;
  readonly kind: 'roof' | 'upperWall';
  readonly heightMeters: number;
  opacity: number;
}

const FOG_VISIBILITY_TRANSMITTANCE = 0.12; // distance at which the scene fades to fog colour

export class BlockScene {
  readonly scene = new Scene();
  readonly crowd: Crowd;

  private runtime: GameRuntime;
  private readonly tier: QualityTier;
  private readonly registry: ResourceRegistry;

  private readonly world = resolveDomain(worldConfig, this.tierOf());
  private readonly player = resolveDomain(playerConfig, this.tierOf());
  private readonly lighting = resolveDomain(lightingConfig, this.tierOf());
  private readonly weatherCfg = resolveDomain(weatherConfig, this.tierOf());
  private readonly visibility = resolveVisibilitySettings(this.tierOf());
  private readonly roofFadeSeconds = resolve(renderingConfig.roofFadeSeconds, this.tierOf());

  private readonly navCellSize: number;
  private readonly sun: DirectionalLight;
  private readonly ambient: AmbientLight;
  private readonly hemi: HemisphereLight;
  private readonly fog: Fog;
  private readonly playerMesh: Object3D;
  private readonly fadeSurfaces: FadeSurface[] = [];
  /** structuralCell -> the section meshes to hide once that cell is breached. */
  private readonly sectionMeshes: { cell: number; objects: Object3D[] }[] = [];

  // shared, tracked GPU resources (V24)
  private readonly mats: MeshStandardMaterial[] = [];
  private readonly geos: BufferGeometry[] = [];

  private tierOf(): QualityTier {
    return this.tier;
  }

  constructor(opts: { runtime: GameRuntime; tier: QualityTier; registry: ResourceRegistry }) {
    this.runtime = opts.runtime;
    this.tier = opts.tier;
    this.registry = opts.registry;
    this.navCellSize = this.runtime.scene.navGrid.settings.navCellSize;

    this.scene.background = new Color(0x0b0d0a);
    this.fog = new Fog(0x0b0d0a, 1, 400);
    this.scene.fog = this.fog;

    this.ambient = new AmbientLight(0xffffff, this.lighting.ambientIntensity);
    this.hemi = new HemisphereLight(0xa7b8c8, 0x2a2620, this.lighting.ambientIntensity * 0.5);
    this.sun = new DirectionalLight(0xfff2dc, this.lighting.sunIntensity);
    this.sun.castShadow = true;
    this.scene.add(this.ambient, this.hemi, this.sun, this.sun.target);

    this.buildGround();
    this.buildWallsAndRoof();
    this.playerMesh = this.buildPlayer();
    this.scene.add(this.playerMesh);

    this.crowd = new Crowd(resolveCrowdSettings(this.tier), this.registry);
    this.scene.add(this.crowd.mesh);

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

    const baseGeo = this.geo('wallBase.geo', new BoxGeometry(this.navCellSize, baseH, this.navCellSize));
    const upperGeo = upperH > 0 ? this.geo('wallUpper.geo', new BoxGeometry(this.navCellSize, upperH, this.navCellSize)) : null;
    const baseMat = this.mat('wallBase', { color: 0x6b6256, roughness: 0.85 });
    const upperMat = this.mat('wallUpper', { color: 0x6b6256, roughness: 0.85, transparent: true, opacity: 1 });
    const sectionMat = this.mat('section', { color: 0xb04a32, roughness: 0.7 }); // the destructible wall, tinted

    // structural-section nav cells get distinct, hideable meshes; everything else is a plain wall.
    const sectionByNav = new Map<number, number>(); // navIndex -> structuralCell
    for (let z = 0; z < ts.wall.sizeZ; z++) {
      const sc = ts.wall.packCell(0, 0, z);
      const cell = ts.navCellForStructuralCell(sc);
      sectionByNav.set(grid.index(cell.cx, cell.cy), sc);
    }

    const wallsGroup = new Group();
    const upperGroup = new Group();

    for (let cy = 0; cy < grid.height; cy++) {
      for (let cx = 0; cx < grid.width; cx++) {
        const idx = grid.index(cx, cy);
        if (!grid.isBlocked(idx)) continue;
        const wx = (cx + 0.5) * this.navCellSize;
        const wz = (cy + 0.5) * this.navCellSize;
        const sc = sectionByNav.get(idx);
        if (sc !== undefined) {
          // Destructible section cell — tracked so a breach hides exactly this footprint.
          const objs: Object3D[] = [];
          const seg = new Mesh(baseGeo, sectionMat);
          seg.position.set(wx, baseH / 2, wz);
          seg.castShadow = true;
          wallsGroup.add(seg);
          objs.push(seg);
          if (upperGeo) {
            const segU = new Mesh(upperGeo, sectionMat);
            segU.position.set(wx, baseH + upperH / 2, wz);
            wallsGroup.add(segU);
            objs.push(segU);
          }
          this.sectionMeshes.push({ cell: sc, objects: objs });
          continue;
        }
        const base = new Mesh(baseGeo, baseMat);
        base.position.set(wx, baseH / 2, wz);
        base.castShadow = true;
        base.receiveShadow = true;
        wallsGroup.add(base);
        if (upperGeo) {
          const upper = new Mesh(upperGeo, upperMat);
          upper.position.set(wx, baseH + upperH / 2, wz);
          upper.castShadow = true;
          upperGroup.add(upper);
        }
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
    const roof = new Mesh(this.geo('roof.geo', new PlaneGeometry(rw, rd)), roofMat);
    roof.rotation.x = -Math.PI / 2;
    roof.position.set((b.minCx + b.maxCx + 1) / 2 * this.navCellSize, wallH, (b.minCy + b.maxCy + 1) / 2 * this.navCellSize);
    this.scene.add(roof);
    this.fadeSurfaces.push({ object: roof, material: roofMat, kind: 'roof', heightMeters: wallH, opacity: 1 });
  }

  private buildPlayer(): Object3D {
    const group = new Group();
    const body = new Mesh(
      this.geo('player.geo', new CapsuleGeometry(this.player.bodyRadiusMeters, this.player.bodyHeightMeters - 2 * this.player.bodyRadiusMeters, 6, 12)),
      this.mat('player', { color: 0x9cc4ff, roughness: 0.5, emissive: 0x16324f, emissiveIntensity: 0.4 }),
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
    this.crowd.update(this.runtime.zombies.views, this.runtime.zombies.count);

    const p = this.runtime.player();
    this.playerMesh.position.set(p.x, 0, p.z);
    this.playerMesh.rotation.y = -this.runtime.playerAim() + Math.PI / 2;

    this.syncBreach();
    this.syncLighting();
    this.syncCutaway(dtSeconds, camera);
  }

  private syncBreach(): void {
    for (const s of this.sectionMeshes) {
      const breached = this.runtime.scene.wall.isBreached(s.cell);
      for (const o of s.objects) o.visible = !breached;
    }
  }

  private syncLighting(): void {
    const severity = this.runtime.weatherSeverity;
    const sky = computeSkyState(this.runtime.timeOfDay(), this.lighting, this.weatherCfg, severity);

    const dist = 60;
    this.sun.position.set(-sky.direction.x * dist, -sky.direction.y * dist, -sky.direction.z * dist);
    this.sun.target.position.set(0, 0, 0);
    this.sun.intensity = sky.keyIntensity;
    this.sun.color.setHex(sky.isDay ? 0xfff2dc : 0xaebed8);
    this.ambient.intensity = sky.ambientIntensity;
    this.hemi.intensity = sky.ambientIntensity * 0.5;

    // Fog far = the distance at which the weather extinction drops transmittance below the threshold.
    let far = 400;
    for (let d = this.navCellSize; d <= 400; d += this.navCellSize) {
      if (fogTransmittance(d, severity, this.tier) <= FOG_VISIBILITY_TRANSMITTANCE) { far = d; break; }
    }
    this.fog.near = far * 0.25;
    this.fog.far = far;
    const night = sky.isDay ? 0 : 1;
    this.fog.color.setRGB(0.043 + 0.02 * (1 - night), 0.051, 0.039);
    (this.scene.background as Color).copy(this.fog.color);
  }

  private syncCutaway(dtSeconds: number, camera: Camera | undefined): void {
    const playerInside = this.isPlayerInsideBuilding();
    const fadeRate = this.roofFadeSeconds > 0 ? dtSeconds / this.roofFadeSeconds : 1;
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
