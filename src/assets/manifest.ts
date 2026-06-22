// T34 / V24 — asset bundles + manifest.
// A bundle declares the descriptors it delivers, the GPU/CPU resources it owns, and the other
// bundles it depends on. The manifest validates id-uniqueness, dependency existence, and acyclicity
// at construction (structured errors, no silent repair) so the registry can load/dispose safely.

import type { Bytes } from './units';

export class AssetError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AssetError';
    this.code = code;
  }
}

/** Every streamed resource has an explicit kind + size so disposal + leak tracking is exact (V24). */
export type ResourceKind = 'geometry' | 'texture' | 'material' | 'render-target' | 'buffer';

export interface ResourceHandle {
  readonly id: string;
  readonly kind: ResourceKind;
  readonly bytes: Bytes;
}

export interface AssetBundle {
  readonly id: string;
  /** Asset descriptor ids delivered by this bundle. */
  readonly assetIds: readonly string[];
  readonly resources: readonly ResourceHandle[];
  /** Bundle ids this bundle depends on (loaded before it, released after it). */
  readonly dependencies: readonly string[];
}

export interface AssetManifest {
  readonly bundles: Readonly<Record<string, AssetBundle>>;
}

function detectCycle(bundles: Readonly<Record<string, AssetBundle>>): void {
  const visiting = new Set<string>();
  const done = new Set<string>();

  const visit = (id: string, stack: readonly string[]): void => {
    if (done.has(id)) return;
    if (visiting.has(id)) {
      throw new AssetError('dependency-cycle', `bundle dependency cycle: ${[...stack, id].join(' -> ')}`);
    }
    visiting.add(id);
    const bundle = bundles[id];
    if (bundle) {
      for (const dep of bundle.dependencies) {
        visit(dep, [...stack, id]);
      }
    }
    visiting.delete(id);
    done.add(id);
  };

  for (const id of Object.keys(bundles)) {
    visit(id, []);
  }
}

/** Build + validate a manifest. Rejects duplicate ids, missing dependencies, and cycles. */
export function createManifest(bundles: readonly AssetBundle[]): AssetManifest {
  const map: Record<string, AssetBundle> = {};
  for (const bundle of bundles) {
    if (map[bundle.id]) {
      throw new AssetError('duplicate-bundle', `duplicate bundle id '${bundle.id}'`);
    }
    map[bundle.id] = bundle;
  }
  for (const bundle of bundles) {
    for (const dep of bundle.dependencies) {
      if (!map[dep]) {
        throw new AssetError(
          'missing-dependency',
          `bundle '${bundle.id}' depends on unknown bundle '${dep}'`,
        );
      }
    }
  }
  detectCycle(map);
  return { bundles: map };
}

export function getBundle(manifest: AssetManifest, id: string): AssetBundle {
  const bundle = manifest.bundles[id];
  if (!bundle) {
    throw new AssetError('unknown-bundle', `unknown bundle '${id}'`);
  }
  return bundle;
}
