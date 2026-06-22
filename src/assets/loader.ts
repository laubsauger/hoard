// T34 / V24 — asset loader interface + an in-memory recording implementation.
// Real network/GPU loading lives behind this interface. The recording loader tracks which bundles
// are resident and the total live resource bytes, so leaks (V24) are observable in tests + tools.

import { AssetError, type AssetBundle, type ResourceHandle } from './manifest';
import { bytes, raw, type Bytes } from './units';

export interface LoadedBundle {
  readonly bundleId: string;
  readonly resources: readonly ResourceHandle[];
}

/** Loading + disposal contract. Implementations own real GPU/CPU handles; this layer stubs them. */
export interface AssetLoader {
  load(bundle: AssetBundle): Promise<LoadedBundle>;
  dispose(bundleId: string): void;
  isLoaded(bundleId: string): boolean;
  loadedBundleIds(): readonly string[];
  /** Sum of resident resource bytes — must return to 0 after everything is disposed (V24). */
  liveResourceBytes(): Bytes;
}

/** Deterministic in-memory loader for tools + tests. No real I/O. */
export class RecordingAssetLoader implements AssetLoader {
  private readonly resident = new Map<string, LoadedBundle>();

  load(bundle: AssetBundle): Promise<LoadedBundle> {
    if (this.resident.has(bundle.id)) {
      throw new AssetError('double-load', `bundle '${bundle.id}' already loaded`);
    }
    const loaded: LoadedBundle = { bundleId: bundle.id, resources: bundle.resources };
    this.resident.set(bundle.id, loaded);
    return Promise.resolve(loaded);
  }

  dispose(bundleId: string): void {
    if (!this.resident.has(bundleId)) {
      throw new AssetError('double-dispose', `bundle '${bundleId}' is not loaded`);
    }
    this.resident.delete(bundleId);
  }

  isLoaded(bundleId: string): boolean {
    return this.resident.has(bundleId);
  }

  loadedBundleIds(): readonly string[] {
    return [...this.resident.keys()];
  }

  liveResourceBytes(): Bytes {
    let total = 0;
    for (const loaded of this.resident.values()) {
      for (const res of loaded.resources) {
        total += raw(res.bytes);
      }
    }
    return bytes(total);
  }
}
