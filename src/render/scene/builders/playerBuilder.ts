// Player builder: the player avatar (capsule body + facing nose) and the cheap contact-AO grounding disc
// (T45/V36) that follows the player each frame. Returns PlayerHandles the orchestrator drives per-frame
// (position/rotation, rim-glow, AO disc). Extracted from BlockScene (docs/REFACTOR-godfiles.md).

import {
  BoxGeometry,
  CapsuleGeometry,
  CircleGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
} from 'three';
import type { BuildContext } from './buildContext';
import type { PlayerHandles } from './handles';

export interface PlayerConfig {
  readonly bodyRadiusMeters: number;
  readonly bodyHeightMeters: number;
  /** Base emissive intensity of the player rim (scaled live by the outline-strength accessibility setting). */
  readonly baseEmissive: number;
  /** 0..1 outline strength at build time (V29). */
  readonly outlineStrength: number;
  /** Contact-AO disc strength + radius (0 disables — no empty mesh). */
  readonly aoStrength: number;
  readonly aoRadiusMeters: number;
}

export function buildPlayer(ctx: BuildContext, cfg: PlayerConfig): PlayerHandles {
  const { res } = ctx;
  const group = new Group();
  const bodyMat = res.mat('player', {
    color: 0x9cc4ff,
    roughness: 0.5,
    emissive: 0x16324f,
    // V29: the player's strongest-silhouette rim scales with the outline-strength accessibility setting.
    emissiveIntensity: cfg.baseEmissive * cfg.outlineStrength,
  });
  const body = new Mesh(
    res.geo('player.geo', new CapsuleGeometry(cfg.bodyRadiusMeters, cfg.bodyHeightMeters - 2 * cfg.bodyRadiusMeters, 6, 12)),
    bodyMat,
  );
  body.castShadow = true;
  body.position.y = cfg.bodyHeightMeters / 2;
  group.add(body);
  // Facing marker so aim direction reads at a glance.
  const nose = new Mesh(
    res.geo('playerNose.geo', new BoxGeometry(cfg.bodyRadiusMeters * 1.4, 0.12, cfg.bodyRadiusMeters * 0.5)),
    res.mat('playerNose', { color: 0xffffff }),
  );
  nose.position.set(cfg.bodyRadiusMeters, cfg.bodyHeightMeters * 0.6, 0);
  group.add(nose);
  ctx.root.add(group);

  return { mesh: group, rimMat: bodyMat, aoContact: buildContactAo(ctx, cfg) };
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
