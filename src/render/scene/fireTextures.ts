// Procedural sprite textures for the fire visuals (T146/T148). DOM-free DataTextures (same pattern as the crowd
// impostor/rigged atlases) so they build identically in the browser, headless CDP, and node tests — NO canvas.
//
// Why textures at all: a `SpriteMaterial` with no `map` renders as a FLAT OPAQUE SQUARE (that was the "C64
// squares" bug — 64 mapless flame sprites stacked on a burning horde). A baked soft-alpha texture is what makes
// a billboard read as fire instead of a quad: alpha falls to 0 well before the quad edge, so there is no square.

import { DataTexture, LinearFilter, RGBAFormat, SRGBColorSpace, UnsignedByteType } from 'three';

const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

function finish(data: Uint8Array, size: number): DataTexture {
  const tex = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  tex.colorSpace = SRGBColorSpace;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** A teardrop FLAME billboard with a baked heat ramp (white-hot base → yellow → orange → deep-red tip) and a soft
 *  alpha that vanishes before the quad edge. Built for ADDITIVE blending: colour is full, alpha gates the shape, so
 *  overlapping flames sum into a glow with NO visible square. Row 0 = bottom of the flame (DataTexture flipY=false). */
export function makeFlameTexture(size = 128): DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let iy = 0; iy < size; iy++) {
    const v = (iy + 0.5) / size; // 0 = base, 1 = tip
    // Width profile: fat rounded base, tapering to a point. Pinch the very bottom so it doesn't read as a flat slab.
    const half = Math.pow(Math.max(0, 1 - v), 0.62) * smoothstep(0, 0.12, v) * 0.92 + 0.001;
    for (let ix = 0; ix < size; ix++) {
      const u = ((ix + 0.5) / size) * 2 - 1; // -1..1 across
      const d = Math.abs(u) / half; // 0 centre → 1 flame edge
      // Soft body: a wide feathered edge (no crisp triangular silhouette — that read as a traffic cone), fading the
      // tip + the very base. Bias the body translucent so flames GLOW and layer rather than look like a solid wedge.
      const edge = Math.pow(smoothstep(1.05, 0.1, d), 1.4);
      const tip = smoothstep(1.0, 0.78, v);
      const foot = smoothstep(0.0, 0.06, v);
      const alpha = edge * tip * foot * 0.92;
      const o = (iy * size + ix) * 4;
      if (alpha <= 0.003) {
        data[o] = data[o + 1] = data[o + 2] = data[o + 3] = 0;
        continue;
      }
      // Heat: hottest at the centred base, cooling outward + upward. Orange-dominant — only a small hottest patch goes
      // yellow (NOT white; additive white washes the whole flame out to a pale ghost), so it reads as warm fire.
      const heat = Math.max(0, (1 - v) * (1 - d * 0.55));
      let r: number, g: number, b: number;
      if (heat > 0.82) {
        const t = smoothstep(0.82, 1.0, heat);
        r = 1.0; g = mix(0.62, 0.85, t); b = mix(0.18, 0.42, t); // hottest patch: orange → warm yellow
      } else if (heat > 0.4) {
        const t = smoothstep(0.4, 0.82, heat);
        r = 1.0; g = mix(0.34, 0.62, t); b = mix(0.06, 0.18, t); // orange body
      } else {
        const t = smoothstep(0.0, 0.4, heat);
        r = mix(0.7, 1.0, t); g = mix(0.07, 0.34, t); b = mix(0.02, 0.06, t); // deep red flanks/tip → orange
      }
      data[o] = Math.round(r * 255);
      data[o + 1] = Math.round(g * 255);
      data[o + 2] = Math.round(b * 255);
      data[o + 3] = Math.round(Math.min(1, alpha) * 255);
    }
  }
  return finish(data, size);
}

/** A soft round radial blob: white, alpha = smooth radial falloff to 0 at the rim. Doubles as a glow `map` (additive)
 *  and as a decal `alphaMap` (only .g is sampled, which is white here) so a scorch fades at its edge instead of a hard cut. */
export function makeSoftDiscTexture(size = 128): DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let iy = 0; iy < size; iy++) {
    for (let ix = 0; ix < size; ix++) {
      const u = ((ix + 0.5) / size) * 2 - 1;
      const w = ((iy + 0.5) / size) * 2 - 1;
      const r = Math.sqrt(u * u + w * w); // 0 centre → ~1 rim
      const a = smoothstep(1.0, 0.0, r); // smooth falloff (1 centre, 0 at/after rim)
      const o = (iy * size + ix) * 4;
      data[o] = 255;
      data[o + 1] = 255;
      data[o + 2] = 255;
      data[o + 3] = Math.round(a * 255);
    }
  }
  return finish(data, size);
}
