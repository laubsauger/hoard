// T39 — visual-regression scaffold tests. The parts that need no new dependency RUN and must pass:
// manifest integrity, naming convention, required-category coverage, and the capture wiring to the
// existing tools/cdp-check.mjs screenshot mechanism. The actual PIXEL DIFF is DEFERRED (needs an
// image-compare dep we are not adding) — it is an `it.skip` documenting exactly what remains, plus a test
// proving the stub THROWS rather than fake-passing (honest scaffold, no silent fallback).

import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import {
  FRAME_MANIFEST,
  REQUIRED_CATEGORIES,
  CDP_CHECK_TOOL,
  validateManifest,
  categoriesCovered,
  captureInvocation,
  comparePngs,
  referencePath,
  candidatePath,
} from './frameManifest';

describe('visual regression: manifest integrity (V27)', () => {
  it('is well-formed: unique kebab-case names, descriptions, scene state, citations', () => {
    expect(() => validateManifest()).not.toThrow();
    expect(FRAME_MANIFEST.length).toBeGreaterThan(0);
  });

  it('covers every required canonical category (outline/cutaway/gore/weather/material)', () => {
    const covered = categoriesCovered();
    for (const c of REQUIRED_CATEGORIES) expect(covered.has(c)).toBe(true);
  });

  it('rejects a malformed manifest (validation has teeth)', () => {
    expect(() =>
      validateManifest([
        { name: 'Bad Name', category: 'outline', description: 'x', sceneState: 'scene=x', cites: ['V20'] },
      ]),
    ).toThrow();
    expect(() =>
      validateManifest([
        { name: 'dup', category: 'gore', description: 'a', sceneState: 'scene=a', cites: ['V8'] },
        { name: 'dup', category: 'gore', description: 'b', sceneState: 'scene=b', cites: ['V8'] },
      ]),
    ).toThrow();
  });
});

describe('visual regression: capture wiring to tools/cdp-check.mjs', () => {
  it('the screenshot tool the scaffold drives actually exists', () => {
    expect(existsSync(CDP_CHECK_TOOL)).toBe(true);
  });

  it('builds a node invocation per frame with APP_URL (scene state) + SHOT_OUT (candidate path)', () => {
    const frame = FRAME_MANIFEST[0]!;
    const inv = captureInvocation(frame, 'http://localhost:5173');
    expect(inv.command).toBe('node');
    expect(inv.args).toEqual([CDP_CHECK_TOOL]);
    expect(inv.env.APP_URL).toContain(frame.sceneState);
    expect(inv.env.APP_URL.startsWith('http://localhost:5173?')).toBe(true);
    expect(inv.env.SHOT_OUT).toBe(candidatePath(frame));
  });

  it('reference + candidate paths are distinct and named from the frame id', () => {
    for (const f of FRAME_MANIFEST) {
      expect(referencePath(f)).toContain(`${f.name}.png`);
      expect(candidatePath(f)).toContain(`${f.name}.png`);
      expect(referencePath(f)).not.toBe(candidatePath(f));
    }
  });
});

describe('visual regression: pixel diff (DEFERRED)', () => {
  it('the pixel-diff stub throws instead of fake-passing (no silent fallback)', () => {
    expect(() => comparePngs(FRAME_MANIFEST[0]!)).toThrow(/DEFERRED/);
  });

  // DEFERRED: needs an image-compare dependency (pixelmatch + pngjs) we are not adding now. When that dep
  // lands: capture each frame via captureInvocation(), decode reference vs candidate PNGs, assert the
  // mismatch ratio is within tolerance per frame, then unskip this and remove the throwing stub.
  it.skip('every canonical frame matches its blessed reference within tolerance', () => {
    for (const f of FRAME_MANIFEST) {
      const result = comparePngs(f, 0.001);
      expect(result.pass).toBe(true);
    }
  });
});
