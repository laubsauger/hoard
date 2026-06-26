// Procedural sprite textures for the fire visuals (T146/T148). DOM-free DataTextures (same pattern as the crowd
// impostor/rigged atlases) so they build identically in the browser, headless CDP, and node tests — NO canvas.
//
// Why baked textures: a `SpriteMaterial` with no `map` renders as a FLAT OPAQUE SQUARE (the original "C64 squares"
// bug). But even a soft texture shows a faint QUAD BOX on light backgrounds if (a) mipmaps smear the flame across
// the whole quad at distance, or (b) alpha doesn't truly reach 0 before the edge. So every texture here: mipmaps
// OFF, clamp wrap, and a hard transparent BORDER so the quad outline can never show. Flames are noise-warped into
// several irregular variants (no two identical teardrops); scorch is a ragged blast splat; smoke is a puffy blob.

import { ClampToEdgeWrapping, DataTexture, LinearFilter, RGBAFormat, SRGBColorSpace, UnsignedByteType } from 'three';

const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

// Deterministic 2D value-noise (no Math.random → identical every build, no inter-frame jitter).
function hash2(x: number, y: number): number {
  const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return h - Math.floor(h);
}
function vnoise(x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return mix(mix(a, b, u), mix(c, d, u), v);
}
function fbm(x: number, y: number, oct = 4): number {
  let f = 0, amp = 0.5, sum = 0;
  for (let i = 0; i < oct; i++) {
    f += amp * vnoise(x, y);
    sum += amp;
    x *= 2; y *= 2; amp *= 0.5;
  }
  return f / sum;
}

function finish(data: Uint8Array, size: number, srgb = true): DataTexture {
  const tex = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  if (srgb) tex.colorSpace = SRGBColorSpace;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter; // LinearFilter (not mipmap) — see header: a smeared mip = a visible quad box.
  tex.generateMipmaps = false;
  tex.wrapS = ClampToEdgeWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

// A hard transparent border mask: 1 well inside the quad, 0 at the rim — guarantees the quad outline never shows.
function borderMask(u: number, v: number): number {
  const bx = 1 - smoothstep(0.82, 0.98, Math.abs(u));
  const bt = (1 - smoothstep(0.95, 1.0, v)) * smoothstep(-0.02, 0.04, v);
  return bx * bt;
}

/** A set of `count` ORGANIC flame billboards — each a noise-warped teardrop (swaying licks, irregular width, eroded
 *  inner texture) so a crowd of flames never reads as repeated identical teardrops. Baked for ADDITIVE blending:
 *  full colour, alpha gates the shape to 0 before the quad edge. Row 0 = base of the flame (DataTexture flipY=false). */
export function makeFlameTextures(count = 4, size = 128): DataTexture[] {
  const out: DataTexture[] = [];
  for (let k = 0; k < count; k++) {
    const seed = k * 17.3 + 3.1;
    const data = new Uint8Array(size * size * 4);
    for (let iy = 0; iy < size; iy++) {
      const v = (iy + 0.5) / size; // 0 = base, 1 = tip
      for (let ix = 0; ix < size; ix++) {
        const u = ((ix + 0.5) / size) * 2 - 1; // -1..1 across
        const o = (iy * size + ix) * 4;
        // Sway the column sideways, growing with height (the lick leans + curls near the tip).
        const sway = (fbm(v * 2.6 + seed, seed * 1.7, 3) - 0.5) * 0.85 * smoothstep(0, 1, v);
        const uu = u - sway;
        // Width profile: rounded base → point, pinched at the very bottom, then roughened by noise into licks.
        let half = Math.pow(Math.max(0, 1 - v), 0.6) * smoothstep(0, 0.1, v) * 0.74;
        half *= 0.62 + 0.7 * fbm(v * 4.5 + seed * 2.0, seed + 3.3, 3);
        half = Math.max(0.001, half);
        const d = Math.abs(uu) / half; // 0 centre → 1 lick edge
        const edge = smoothstep(1.0, 0.18, d);
        const tip = smoothstep(1.0, 0.66, v);
        const foot = smoothstep(0.0, 0.05, v);
        // Eroded inner texture: bright filaments, never fully holed (keep ≥0.5 so the body stays solid, not patchy).
        const ero = 0.5 + 0.5 * smoothstep(0.2, 0.7, fbm(uu * 2.2 + seed, v * 3.6 + seed * 1.3, 3));
        let alpha = edge * tip * foot * ero * borderMask(u, v);
        if (alpha <= 0.003) {
          data[o] = data[o + 1] = data[o + 2] = data[o + 3] = 0;
          continue;
        }
        // Heat: hottest at the centred base, cooling outward + upward. Orange-dominant (white/yellow washes out
        // additively into a pale ghost); only a small hottest patch reaches warm yellow.
        const heat = clamp01((1 - v) * (1 - d * 0.5) + (ero - 0.75) * 0.2);
        let r: number, g: number, b: number;
        if (heat > 0.82) {
          const t = smoothstep(0.82, 1.0, heat);
          r = 1.0; g = mix(0.6, 0.86, t); b = mix(0.16, 0.4, t);
        } else if (heat > 0.4) {
          const t = smoothstep(0.4, 0.82, heat);
          r = 1.0; g = mix(0.33, 0.6, t); b = mix(0.05, 0.16, t);
        } else {
          const t = smoothstep(0.0, 0.4, heat);
          r = mix(0.66, 1.0, t); g = mix(0.06, 0.33, t); b = mix(0.02, 0.05, t);
        }
        alpha = clamp01(alpha) * 0.95;
        data[o] = Math.round(r * 255);
        data[o + 1] = Math.round(g * 255);
        data[o + 2] = Math.round(b * 255);
        data[o + 3] = Math.round(alpha * 255);
      }
    }
    out.push(finish(data, size));
  }
  return out;
}

/** A soft round radial blob: white, alpha = smooth radial falloff that reaches 0 well INSIDE the quad (≈0.5 radius),
 *  so on a full-quad PLANE it reads as a soft disc with no rim — additive ground-glow `map`. (Do NOT put this on a
 *  CircleGeometry: the circle rim cuts the falloff at ~50% alpha → a hard edge. Plane + this texture = soft.) */
export function makeSoftDiscTexture(size = 128): DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let iy = 0; iy < size; iy++) {
    for (let ix = 0; ix < size; ix++) {
      const u = ((ix + 0.5) / size) * 2 - 1;
      const w = ((iy + 0.5) / size) * 2 - 1;
      const r = Math.sqrt(u * u + w * w);
      const a = smoothstep(0.98, 0.0, r); // 1 at centre → 0 by the quad edge
      const o = (iy * size + ix) * 4;
      data[o] = data[o + 1] = data[o + 2] = 255;
      data[o + 3] = Math.round(clamp01(a) * 255);
    }
  }
  return finish(data, size);
}

/** A RAGGED blast splat for grenade scorch: near-black soot, an irregular (angular-noise) edge + mottled interior,
 *  alpha → 0 before the quad rim. Drawn dark over the ground (NormalBlending) so it reads as a burn mark, not a disc. */
export function makeScorchTexture(size = 256): DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let iy = 0; iy < size; iy++) {
    for (let ix = 0; ix < size; ix++) {
      const u = ((ix + 0.5) / size) * 2 - 1;
      const w = ((iy + 0.5) / size) * 2 - 1;
      const r = Math.sqrt(u * u + w * w);
      const ang = Math.atan2(w, u);
      const o = (iy * size + ix) * 4;
      // Ragged radius: perturb the boundary by angular + radial noise so it is a torn blast, not a circle.
      const edgeN = fbm(Math.cos(ang) * 1.8 + 5.0, Math.sin(ang) * 1.8 + 7.0, 4);
      const rad = 0.62 + 0.26 * (edgeN - 0.5) * 2 + 0.08 * fbm(u * 3 + 2, w * 3 + 9, 3);
      let a = smoothstep(rad, rad - 0.28, r); // soft ragged falloff inward
      const m = fbm(u * 4.0 + 2, w * 4.0 + 8, 4); // interior soot mottle
      a *= 0.55 + 0.6 * m;
      a *= 1 - smoothstep(0.9, 1.0, r); // hard clear at the quad border
      a = clamp01(a);
      const soot = 0.5 + 0.6 * m; // darker cores / lighter ash
      data[o] = Math.round(0.06 * soot * 255);
      data[o + 1] = Math.round(0.045 * soot * 255);
      data[o + 2] = Math.round(0.035 * soot * 255);
      data[o + 3] = Math.round(a * 0.85 * 255);
    }
  }
  return finish(data, size, false);
}

/** A puffy SMOKE blob: noise-roughened round shape, mottled grey, soft alpha → 0 at the rim. Drawn with NormalBlending
 *  (smoke OCCLUDES, it doesn't add light) and tinted/faded per sprite as it rises. */
export function makeSmokeTexture(size = 128): DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let iy = 0; iy < size; iy++) {
    for (let ix = 0; ix < size; ix++) {
      const u = ((ix + 0.5) / size) * 2 - 1;
      const w = ((iy + 0.5) / size) * 2 - 1;
      const r = Math.sqrt(u * u + w * w);
      const o = (iy * size + ix) * 4;
      const n = fbm(u * 1.9 + 9.1, w * 1.9 + 4.7, 4);
      const rad = 0.66 + 0.26 * (n - 0.5) * 2; // wobbly cauliflower boundary
      let a = smoothstep(rad, rad - 0.42, r);
      a *= 0.45 + 0.7 * fbm(u * 3.0 + 1, w * 3.0 + 2, 3); // billows
      a *= 1 - smoothstep(0.92, 1.0, r);
      a = clamp01(a);
      const g = 0.5 + 0.28 * n; // grey value, white where lit
      data[o] = Math.round(g * 255);
      data[o + 1] = Math.round(g * 255);
      data[o + 2] = Math.round(g * 255);
      data[o + 3] = Math.round(a * 255);
    }
  }
  return finish(data, size, false);
}
