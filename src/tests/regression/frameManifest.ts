// T39 — visual-regression SCAFFOLD (V27 testing clause; V8/V20/V29 are the systems it will guard).
//
// HONEST SCOPE. This module implements the parts of visual regression that need no new dependency:
//   1. a typed MANIFEST naming every canonical frame (outlines / cutaways / gore / weather / material),
//   2. a deterministic NAMING + reference/candidate PATH convention,
//   3. CAPTURE wiring to the existing dependency-free screenshot mechanism (tools/cdp-check.mjs).
// The actual PIXEL DIFF is DEFERRED: it needs an image-compare dependency (e.g. pixelmatch + pngjs) that
// we are explicitly NOT adding now. The comparison step is implemented as a documented, throwing stub and
// exercised only by an `it.skip` in the test file, so the scaffold is real but never silently "passes" a
// comparison it cannot perform (no fallback that pretends frames match — V4 spirit).

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Repo root, derived from this file's location (src/tests/regression -> ../../..). */
export const REPO_ROOT = resolve(HERE, '../../..');
/** The dependency-free CDP screenshot tool the capture step drives. */
export const CDP_CHECK_TOOL = resolve(REPO_ROOT, 'tools/cdp-check.mjs');
/** Where blessed reference PNGs live (committed once the diff step lands). */
export const REFERENCE_DIR = resolve(HERE, 'reference');
/** Where a run writes fresh candidate PNGs for comparison (gitignored / tmp). */
export const CANDIDATE_DIR = resolve(REPO_ROOT, '.regression-candidates');

/** The visual systems each canonical frame is meant to guard. */
export type FrameCategory = 'outline' | 'cutaway' | 'gore' | 'weather' | 'material';

export interface CanonicalFrame {
  /** Stable kebab-case id, unique across the manifest. Drives the PNG filename. */
  readonly name: string;
  readonly category: FrameCategory;
  /** What this frame is meant to lock down (the visual contract under regression). */
  readonly description: string;
  /**
   * Deterministic scene state the app must render for this frame, expressed as URL query params appended
   * to the dev-server URL (e.g. `scene=cutaway&weather=fog`). This is the WIRING CONTRACT between the
   * regression harness and the app's debug scene loader; the app honoring these params is tracked
   * separately (the capture below is honest that it only SETS them, it does not assert the app reads them).
   */
  readonly sceneState: string;
  /** Cites the invariant(s) the frame protects. */
  readonly cites: readonly string[];
}

/** Canonical frames — at least one per required category (outline/cutaway/gore/weather/material). */
export const FRAME_MANIFEST: readonly CanonicalFrame[] = [
  {
    name: 'outline-hierarchy-player-vs-horde',
    category: 'outline',
    description: 'Player carries the strongest silhouette; nearby threats medium; distant horde is a dark mass with few/no per-body outlines (read at gameplay pixel height).',
    sceneState: 'scene=outline-hierarchy',
    cites: ['V20', 'V32'],
  },
  {
    name: 'cutaway-roof-faded-interior-revealed',
    category: 'cutaway',
    description: 'Enclosed room: roof + upper walls fade where they occlude the player view; base wall band stays opaque so enclosure + breach read clearly.',
    sceneState: 'scene=cutaway&player=inside',
    cites: ['V20'],
  },
  {
    name: 'cutaway-breach-hole-visible',
    category: 'cutaway',
    description: 'A breached wall section renders an irregular hole that hides the cubic structural-cell shape; base wall preserved around it.',
    sceneState: 'scene=cutaway&breach=1',
    cites: ['V20', 'V30'],
  },
  {
    name: 'gore-directional-spray-and-sever',
    category: 'gore',
    description: 'Directional blood spray + readable sever silhouette on a hero hit at default gore intensity.',
    sceneState: 'scene=gore&intensity=default',
    cites: ['V8', 'V17'],
  },
  {
    name: 'gore-intensity-reduced-accessibility',
    category: 'gore',
    description: 'Same hit with the gore-intensity accessibility setting at minimum — confirms the toggle visibly changes output.',
    sceneState: 'scene=gore&intensity=min',
    cites: ['V8', 'V29'],
  },
  {
    name: 'weather-clear-noon',
    category: 'weather',
    description: 'Baseline clear-weather daylight grading + fog at noon (reference exposure).',
    sceneState: 'scene=weather&profile=clear&time=0.5',
    cites: ['V8'],
  },
  {
    name: 'weather-fog-dusk',
    category: 'weather',
    description: 'Fog profile at dusk — fog extinction + color grading shift used for horde depth separation.',
    sceneState: 'scene=weather&profile=fog&time=0.75',
    cites: ['V8'],
  },
  {
    name: 'material-family-states-wet-dry-burned',
    category: 'material',
    description: 'Approved material families across states: dry, blood-wet, and burned — locks the authored material look.',
    sceneState: 'scene=materials&states=dry,wet,burned',
    cites: ['V8'],
  },
];

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Validate manifest integrity. Throws on the first problem (a malformed manifest is a content error, V4). */
export function validateManifest(frames: readonly CanonicalFrame[] = FRAME_MANIFEST): void {
  if (frames.length === 0) throw new Error('frame manifest is empty');
  const seen = new Set<string>();
  for (const f of frames) {
    if (!NAME_RE.test(f.name)) throw new Error(`frame name not kebab-case: '${f.name}'`);
    if (seen.has(f.name)) throw new Error(`duplicate frame name: '${f.name}'`);
    seen.add(f.name);
    if (f.description.trim().length === 0) throw new Error(`frame '${f.name}' has no description`);
    if (f.sceneState.trim().length === 0) throw new Error(`frame '${f.name}' has no sceneState`);
    if (f.cites.length === 0) throw new Error(`frame '${f.name}' cites no invariant`);
  }
}

/** Every category that MUST have at least one canonical frame. */
export const REQUIRED_CATEGORIES: readonly FrameCategory[] = ['outline', 'cutaway', 'gore', 'weather', 'material'];

export function categoriesCovered(frames: readonly CanonicalFrame[] = FRAME_MANIFEST): Set<FrameCategory> {
  return new Set(frames.map((f) => f.category));
}

export function referencePath(frame: CanonicalFrame): string {
  return resolve(REFERENCE_DIR, `${frame.name}.png`);
}

export function candidatePath(frame: CanonicalFrame): string {
  return resolve(CANDIDATE_DIR, `${frame.name}.png`);
}

export interface CaptureInvocation {
  /** Executable to run (the existing dependency-free CDP screenshot tool). */
  readonly command: 'node';
  readonly args: readonly string[];
  /** Env overrides cdp-check.mjs reads: APP_URL (with scene state) + SHOT_OUT (candidate path). */
  readonly env: { readonly APP_URL: string; readonly SHOT_OUT: string };
}

/**
 * Build the capture invocation for one frame, wiring it to tools/cdp-check.mjs. Pure: it constructs the
 * command + env, it does NOT spawn a browser (that needs a running dev server + headless Chrome and is a
 * CI-only step). `appBaseUrl` defaults to the dev server cdp-check.mjs already targets.
 */
export function captureInvocation(frame: CanonicalFrame, appBaseUrl = 'http://localhost:5173'): CaptureInvocation {
  const sep = appBaseUrl.includes('?') ? '&' : '?';
  const appUrl = `${appBaseUrl}${sep}${frame.sceneState}`;
  return {
    command: 'node',
    args: [CDP_CHECK_TOOL],
    env: { APP_URL: appUrl, SHOT_OUT: candidatePath(frame) },
  };
}

export interface PixelDiffResult {
  readonly name: string;
  readonly mismatchedPixels: number;
  readonly totalPixels: number;
  readonly ratio: number;
  readonly pass: boolean;
}

/**
 * DEFERRED pixel-diff step. Requires an image-compare dependency (pixelmatch + pngjs or similar) that we
 * are not adding now. It THROWS rather than returning a fake pass, so nothing can mistake the scaffold for
 * a working comparison (no smoothing-over — a regression layer that silently passes is worse than none).
 *
 * TODO(visual-regression): add the image-compare dep, decode reference+candidate PNGs, count mismatched
 * pixels against `maxMismatchRatio`, return PixelDiffResult, and remove this throw + the `it.skip` guard.
 */
export function comparePngs(_frame: CanonicalFrame, _maxMismatchRatio = 0.001): PixelDiffResult {
  throw new Error(
    'pixel-diff is DEFERRED: add an image-compare dependency (pixelmatch+pngjs), decode reference vs candidate PNGs, then implement comparePngs. See TODO(visual-regression) in frameManifest.ts.',
  );
}
