// Player builder (T127): builds the rigged player AVATAR root (a PlayerAvatar — its SkinnedMesh + animation
// mixer swap in when the GLB resolves async; the root Group exists synchronously so the scene stays sync) and
// the cheap contact-AO grounding disc (T45/V36) that follows the player each frame. Returns PlayerHandles the
// orchestrator drives per-frame (position/facing the avatar root, advancing the animation state machine, the
// AO disc). Replaces the old procedural capsule body + facing nose + rim glow (docs/REFACTOR-godfiles.md).

import {
  CircleGeometry,
  Float32BufferAttribute,
  Mesh,
  MeshBasicMaterial,
} from 'three';
import type { BuildContext } from './buildContext';
import type { PlayerHandles } from './handles';
import { PlayerAvatar } from '../../player';

export interface PlayerConfig {
  readonly bodyRadiusMeters: number;
  /** Target standing height (m) — the GLB is measured + scaled to this, feet at y=0. */
  readonly bodyHeightMeters: number;
  /** Contact-AO disc strength + radius (0 disables — no empty mesh). */
  readonly aoStrength: number;
  readonly aoRadiusMeters: number;
}

export function buildPlayer(ctx: BuildContext, cfg: PlayerConfig): PlayerHandles {
  // The avatar root is added synchronously (positioned/faced each frame). The rigged SkinnedMesh + AnimationMixer
  // attach later via avatar.attachGltf() once GLTFLoader resolves /meshes/ranger.glb (wired in GameViewport).
  const avatar = new PlayerAvatar({ heightMeters: cfg.bodyHeightMeters });
  ctx.root.add(avatar.root);
  return { avatar, aoContact: buildContactAo(ctx, cfg) };
}

/**
 * Cheap contact-AO grounding disc (T45/V36): a soft dark radial gradient laid flat under the player that
 * follows them each frame. Reads as ambient occlusion even when the sun shadow is faint (overcast/night/
 * interior). Pure geometry (per-vertex alpha, NO texture binding → zero WebGPU validation cost). Null when
 * disabled by tier/config.
 */
function buildContactAo(ctx: BuildContext, cfg: PlayerConfig): Mesh | null {
  const { res, root } = ctx;
  if (cfg.aoStrength <= 0 || cfg.aoRadiusMeters <= 0) return null; // disabled — skip cleanly (no empty mesh)
  const segments = 32;
  const geo = res.geo('contactAo.geo', new CircleGeometry(cfg.aoRadiusMeters, segments));
  // Per-vertex RGBA: opaque-dark centre (alpha = strength) fading to fully transparent at the rim.
  const count = geo.getAttribute('position').count;
  const colors = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const center = i === 0; // CircleGeometry vertex 0 is the centre; 1..n are the rim ring
    colors[i * 4 + 3] = center ? cfg.aoStrength : 0;
  }
  geo.setAttribute('color', new Float32BufferAttribute(colors, 4));
  // Tracked for disposal (V24); a MeshBasicMaterial (not lit) so it goes through res.track, not res.mat.
  const mat = res.track(
    new MeshBasicMaterial({ color: 0x000000, transparent: true, vertexColors: true, depthWrite: false }),
    'material',
    'contactAo',
  );
  const disc = new Mesh(geo, mat);
  disc.rotation.x = -Math.PI / 2; // lay flat on the ground plane
  disc.renderOrder = 1; // draw after opaque ground/floor so the soft darkening composites cleanly
  root.add(disc);
  return disc;
}
