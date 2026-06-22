// T34 / V24 — asset registry: reference-counted bundle lifecycle over a manifest + loader.
// Each bundle loads + disposes independently. Acquiring a bundle loads its dependencies first;
// releasing it disposes only when the last holder lets go, then releases dependencies. This makes
// resource ownership + disposal explicit so memory growth / leaks are release-blocking defects.

import { AssetError, getBundle, type AssetManifest } from './manifest';
import type { AssetLoader } from './loader';
import type { Bytes } from './units';

export class AssetRegistry {
  private readonly refs = new Map<string, number>();

  constructor(
    private readonly manifest: AssetManifest,
    private readonly loader: AssetLoader,
  ) {}

  /** Acquire a bundle (and transitively its dependencies). Loads on first reference. */
  async acquire(bundleId: string): Promise<void> {
    const bundle = getBundle(this.manifest, bundleId);
    // Dependencies first: a bundle is never live before what it needs.
    for (const dep of bundle.dependencies) {
      await this.acquire(dep);
    }
    const next = (this.refs.get(bundleId) ?? 0) + 1;
    this.refs.set(bundleId, next);
    if (next === 1) {
      await this.loader.load(bundle);
    }
  }

  /** Release a bundle. Disposes (and releases its dependencies) only when the last holder lets go. */
  release(bundleId: string): void {
    const bundle = getBundle(this.manifest, bundleId);
    const current = this.refs.get(bundleId) ?? 0;
    if (current <= 0) {
      throw new AssetError('release-unacquired', `release of non-acquired bundle '${bundleId}'`);
    }
    const next = current - 1;
    if (next === 0) {
      this.refs.delete(bundleId);
      this.loader.dispose(bundleId);
      // Dependencies last: only after the dependent is gone.
      for (const dep of bundle.dependencies) {
        this.release(dep);
      }
    } else {
      this.refs.set(bundleId, next);
    }
  }

  refCount(bundleId: string): number {
    return this.refs.get(bundleId) ?? 0;
  }

  isLive(bundleId: string): boolean {
    return this.loader.isLoaded(bundleId);
  }

  liveBundleIds(): readonly string[] {
    return this.loader.loadedBundleIds();
  }

  /** Total resident bytes — expected to be 0 once everything is released (V24 leak gate). */
  liveResourceBytes(): Bytes {
    return this.loader.liveResourceBytes();
  }
}
