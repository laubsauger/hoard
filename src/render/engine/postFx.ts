// GTAO ambient-occlusion post-process graph, built ONLY inside the WebGPU backend (the single place a real
// WebGPURenderer exists). Mirrors the three r184 webgpu_postprocessing_ao example:
//   • a beauty `pass(scene, camera)` whose MRT also outputs the VIEW-SPACE normal (`normalView`) + depth,
//   • a GTAO `ao(depth, normal, camera)` pass (three/examples/jsm/tsl/display/GTAONode.js),
//   • composited MULTIPLICATIVELY into the beauty colour: color * mix(1, aoTerm, intensity).
//
// The composite multiplies in LINEAR space BEFORE the renderer's output tone-mapping: PostProcessing renders
// the beauty pass with NoToneMapping and applies the renderer's tone-mapping operator + live exposure
// (a rendererReference uniform) in its output transform. So AO darkens linear radiance, never double-tonemaps,
// and the interior/night exposure set per frame via setToneMapping keeps flowing through untouched (V4 — every
// AO tunable is a resolved config value, no magic numbers).
//
// Transparency: `pass()` renders the whole scene, but transparent materials (the cutaway roof fade, the far
// impostor billboards, alpha FX) render with depthWrite OFF, so they do NOT write into the depth buffer the AO
// reads — AO is computed from the OPAQUE depth/normal only. No AO halo is drawn around the faded roofs or the
// impostor quads (verified visually). The normal MRT likewise only retains opaque view normals.

import type { Camera, Scene } from 'three';
import { PostProcessing, type WebGPURenderer } from 'three/webgpu';
import { float, mix, mrt, normalView, output, pass, vec3, vec4 } from 'three/tsl';
import { ao } from 'three/examples/jsm/tsl/display/GTAONode.js';

/** Resolved GTAO tunables (from renderingConfig, per tier). No magic numbers leak into the graph. */
export interface AoSettings {
  readonly radius: number;
  readonly samples: number;
  readonly distanceExponent: number;
  readonly scale: number;
  readonly thickness: number;
  readonly intensity: number;
}

/**
 * Build the GTAO PostProcessing pipeline for a STABLE scene+camera pair. Driven each frame by
 * `postProcessing.render()`. The pass auto-tracks the renderer size/pixelRatio (its `updateBefore` reads
 * `renderer.getSize()`/`getPixelRatio()` every frame), so it always renders at the live resolution.
 */
export function buildAoPostProcessing(
  renderer: WebGPURenderer,
  scene: Scene,
  camera: Camera,
  settings: AoSettings,
): PostProcessing {
  const scenePass = pass(scene, camera);
  // Output the view-space normal alongside colour so GTAO has real geometric normals (it samples + normalizes
  // them); the pass also exposes a 'depth' texture node automatically. HalfFloat MRT stores the signed normal.
  scenePass.setMRT(mrt({ output, normal: normalView }));

  const scenePassColor = scenePass.getTextureNode('output');
  const scenePassDepth = scenePass.getTextureNode('depth');
  const scenePassNormal = scenePass.getTextureNode('normal');

  const aoPass = ao(scenePassDepth, scenePassNormal, camera);
  aoPass.radius.value = settings.radius;
  aoPass.samples.value = settings.samples;
  aoPass.distanceExponent.value = settings.distanceExponent;
  aoPass.scale.value = settings.scale;
  aoPass.thickness.value = settings.thickness;

  // GTAO red channel: 1 = unoccluded, 0 = fully occluded. Blend toward 1 by intensity so corners/seams deepen
  // tastefully instead of crushing to a black halo. Preserve alpha=1 (multiply only RGB), like the example.
  const aoTerm = aoPass.getTextureNode().r;
  const aoFactor = mix(float(1), aoTerm, float(settings.intensity));
  const composited = scenePassColor.mul(vec4(vec3(aoFactor), 1));

  const postProcessing = new PostProcessing(renderer);
  postProcessing.outputNode = composited;
  return postProcessing;
}
