// T109 / V73 — FOG OF WAR render system: owns the coarse per-cell `FogOfWarGrid`, a `DataTexture` carrying the
// per-cell overlay opacity, and the ground-plane overlay mesh that samples it. Each frame it recomputes which
// cells are CURRENTLY VISIBLE by reusing the SAME `instantaneousReveal` cone+near+LOS reveal the crowd uses
// (the passive awareness radius is fed in as the near radius) — so the lit/revealed world and the un-fogged
// world agree by construction, and a wall/solid prop blocks the reveal through structural `hasLineOfSight`
// (V63), never a second wall representation. Cells fade smoothly between unexplored→explored→visible via an
// exponential approach on a per-cell opacity buffer. Allocated once to the world cell count — no per-frame
// allocation (V24); a PURE VIEW that never mutates the sim/nav (V2/V26). Built like the gizmos/crowd (a
// MeshBasicNodeMaterial) — the primitive confirmed to render under three's WebGPURenderer.

import {
  ClampToEdgeWrapping,
  Color,
  DataTexture,
  LinearFilter,
  Mesh,
  PlaneGeometry,
  RGBAFormat,
  UnsignedByteType,
} from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { positionWorld, texture, uniform, vec2 } from 'three/tsl';
import type { GameRuntime } from '../../../game/runtime';
import type { ResourceRegistry } from '../../engine/resources';
import { hasLineOfSight } from '../../../game/scene';
import { instantaneousReveal, type RevealParams } from '../../crowd/perceptionMemory';
import { approach } from '../../lighting/lighting';
import { FogOfWarGrid, type FogDimConfig, type FogState } from '../../world/fogOfWar';

export interface FogOfWarConeConfig {
  /** Full player FOV cone angle (degrees) — the same wedge the flashlight/vision reveal uses. */
  readonly fovDegrees: number;
  /** Reveal range (m) of the forward cone. */
  readonly range: number;
  /** Soft fade band (m) at the far edge. */
  readonly rangeFadeMeters: number;
  /** Soft fade band (half-angle degrees) at the cone edge. */
  readonly coneFadeDegrees: number;
}

export interface FogOfWarSystemConfig {
  /** Fog grid columns (= nav grid width). */
  readonly cols: number;
  /** Fog grid rows (= nav grid height). */
  readonly rows: number;
  /** World metres per fog cell (= navCellSize). */
  readonly cellSize: number;
  /** World extent (m) the overlay plane covers (= cols*cellSize, rows*cellSize). */
  readonly worldWidth: number;
  readonly worldDepth: number;
  readonly cone: FogOfWarConeConfig;
  readonly dims: FogDimConfig;
  /** Per-second exponential approach rate for each cell opacity toward its target. */
  readonly fadePerSecond: number;
  /** Height the overlay plane sits above the ground (z-fight margin). */
  readonly heightMeters: number;
  /** Fog tint as a packed 0xRRGGBB hex. */
  readonly color: number;
}

export class FogOfWarSystem {
  private readonly grid: FogOfWarGrid;
  /** Per-cell smoothed overlay opacity (0..1), allocated once (V24). Row-major cols×rows. */
  private readonly alpha: Float32Array;
  /** RGBA texel buffer backing the overlay texture; only the alpha byte per texel varies per frame. */
  private readonly texData: Uint8Array;
  private readonly tex: DataTexture;
  private readonly material: MeshBasicNodeMaterial;
  readonly mesh: Mesh;

  constructor(
    registry: ResourceRegistry,
    private readonly cfg: FogOfWarSystemConfig,
  ) {
    this.grid = new FogOfWarGrid(cfg.cols, cfg.rows);
    this.alpha = new Float32Array(cfg.cols * cfg.rows).fill(cfg.dims.unexploredDim);
    this.texData = new Uint8Array(cfg.cols * cfg.rows * 4);
    // Seed the texture fully fogged (everything unexplored) so the first frame reads as classic fog of war.
    const seed = Math.round(cfg.dims.unexploredDim * 255);
    for (let i = 0; i < cfg.cols * cfg.rows; i++) this.texData[i * 4 + 3] = seed;

    this.tex = new DataTexture(this.texData, cfg.cols, cfg.rows, RGBAFormat, UnsignedByteType);
    this.tex.flipY = false; // data row 0 → v=0; sample by world position below (no extra flip)
    this.tex.minFilter = LinearFilter;
    this.tex.magFilter = LinearFilter; // smooth gradients between coarse cells
    this.tex.wrapS = ClampToEdgeWrapping;
    this.tex.wrapT = ClampToEdgeWrapping;
    this.tex.needsUpdate = true;
    registry.track(this.tex, 'texture', 'block.fogOfWar.tex');

    this.material = new MeshBasicNodeMaterial();
    this.material.transparent = true;
    this.material.depthWrite = false;
    this.material.color = new Color(cfg.color);
    // Sample the fog texture by WORLD position (uv = worldXZ / worldExtent) so the overlay aligns with the nav
    // grid regardless of the plane's own UVs. The texel alpha IS the overlay opacity. The opacity uniform lets
    // the system hard-disable the overlay (target alpha) without rebuilding the node graph.
    const uvNode = vec2(
      positionWorld.x.div(uniform(cfg.worldWidth)),
      positionWorld.z.div(uniform(cfg.worldDepth)),
    );
    this.material.opacityNode = texture(this.tex, uvNode).a;
    registry.track(this.material, 'material', 'block.fogOfWar.mat');

    const geo = new PlaneGeometry(cfg.worldWidth, cfg.worldDepth);
    registry.track(geo, 'geometry', 'block.fogOfWar.geo');
    this.mesh = new Mesh(geo, this.material);
    this.mesh.rotation.x = -Math.PI / 2; // lie flat in the XZ plane
    this.mesh.position.set(cfg.worldWidth / 2, cfg.heightMeters, cfg.worldDepth / 2);
    this.mesh.renderOrder = 2; // composite after opaque ground + cutaway fades
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = false;
    this.mesh.castShadow = false;
  }

  /**
   * Advance the fog one frame. `passiveRadiusMeters` is the ambient-scaled passive awareness radius (the omni
   * near-reveal). `on` mirrors the fog master toggle. Recomputes the visible set around the player, ages the
   * per-cell opacity toward its fog-state target, and re-uploads the texture. Allocation-free.
   */
  update(runtime: GameRuntime, passiveRadiusMeters: number, dtSeconds: number, on: boolean): void {
    this.mesh.visible = on;
    if (!on) return;

    const cs = this.cfg.cellSize;
    const cols = this.cfg.cols;
    const rows = this.cfg.rows;
    const scene = runtime.scene;
    const p = runtime.player();

    // The SAME cone+near+LOS reveal the crowd uses; noise terms zeroed (a world cell is never "loud"), the
    // passive radius wired in as the near radius. A cell counts as VISIBLE this frame iff its reveal is > 0.
    const params: RevealParams = {
      px: p.x,
      pz: p.z,
      heading: runtime.playerAim(),
      fovHalf: (this.cfg.cone.fovDegrees * Math.PI) / 360,
      range: this.cfg.cone.range,
      edgeBandMeters: this.cfg.cone.rangeFadeMeters,
      edgeBandRadians: (this.cfg.cone.coneFadeDegrees * Math.PI) / 180,
      nearRadiusMeters: passiveRadiusMeters,
      hearingRange: 0,
      soundWallOcclusion: 0,
      lineOfSight: (x0, z0, x1, z1) => hasLineOfSight(scene, x0, z0, x1, z1),
    };

    this.grid.beginFrame();

    // Sweep only the bounded neighbourhood that could be revealed (cone range OR passive disc), clamped to the
    // grid. Each cell tests its CENTRE through the shared reveal so walls/solid props occlude it (V63).
    const reach = Math.max(passiveRadiusMeters, this.cfg.cone.range);
    const reachCells = Math.ceil(reach / cs) + 1;
    const pcx = Math.floor(p.x / cs);
    const pcy = Math.floor(p.z / cs);
    const minCx = Math.max(0, pcx - reachCells);
    const maxCx = Math.min(cols - 1, pcx + reachCells);
    const minCy = Math.max(0, pcy - reachCells);
    const maxCy = Math.min(rows - 1, pcy + reachCells);
    for (let cy = minCy; cy <= maxCy; cy++) {
      const wz = (cy + 0.5) * cs;
      for (let cx = minCx; cx <= maxCx; cx++) {
        const wx = (cx + 0.5) * cs;
        if (instantaneousReveal(wx, wz, false, params) > 0) this.grid.markVisible(cx, cy);
      }
    }

    // Age every cell's opacity toward its fog-state target so cells fade between states instead of popping, and
    // mirror the alpha into the texture. Full-grid sweep is cheap (cols×rows) and bounded by the district size.
    const rate = this.cfg.fadePerSecond;
    const dims = this.cfg.dims;
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const i = cy * cols + cx;
        const target = this.grid.dimAt(cx, cy, dims);
        const a = approach(this.alpha[i]!, target, rate, dtSeconds);
        this.alpha[i] = a;
        this.texData[i * 4 + 3] = a <= 0 ? 0 : a >= 1 ? 255 : Math.round(a * 255);
      }
    }
    this.tex.needsUpdate = true;
  }

  /** Test/diagnostics: smoothed overlay opacity (0..1) at a cell. */
  debugAlphaAt(col: number, row: number): number {
    return this.alpha[row * this.cfg.cols + col]!;
  }

  /** Test/diagnostics: the fog state at a cell as of the last update. */
  debugStateAt(col: number, row: number): FogState {
    return this.grid.state(col, row);
  }
}
