// T5 / V24 — resource ownership + disposal registry.
// EVERY geometry/texture/material/render-target/buffer/effect is tracked and explicitly disposed.
// Memory growth + leaks are release-blocking defects, so the registry can assert "no leaks".
// Fully unit-testable: a Disposable is anything with dispose(); no GPU required.

export interface Disposable {
  dispose(): void;
}

/** Coarse category for diagnostics counters (T5 diagnostics counters / §I debug views). */
export type ResourceKind =
  | 'geometry'
  | 'texture'
  | 'material'
  | 'renderTarget'
  | 'buffer'
  | 'effect'
  | 'other';

interface Entry {
  readonly kind: ResourceKind;
  readonly label: string;
  disposed: boolean;
}

export class ResourceRegistry {
  private readonly entries = new Map<Disposable, Entry>();

  /** Track a disposable resource. Double-tracking the same instance is a defect and throws. */
  track<T extends Disposable>(resource: T, kind: ResourceKind, label: string): T {
    if (this.entries.has(resource)) {
      throw new Error(`resource already tracked: ${label} (${kind})`);
    }
    this.entries.set(resource, { kind, label, disposed: false });
    return resource;
  }

  /** Dispose a single tracked resource and stop tracking it. Idempotent per instance. */
  dispose(resource: Disposable): void {
    const entry = this.entries.get(resource);
    if (!entry) throw new Error('dispose() called on an untracked resource');
    if (!entry.disposed) {
      resource.dispose();
      entry.disposed = true;
    }
    this.entries.delete(resource);
  }

  /** Number of currently tracked (undisposed) resources. */
  get size(): number {
    return this.entries.size;
  }

  /** Per-kind live counts for diagnostics counters (V27 diagnostics requirement). */
  counts(): Record<ResourceKind, number> {
    const out: Record<ResourceKind, number> = {
      geometry: 0,
      texture: 0,
      material: 0,
      renderTarget: 0,
      buffer: 0,
      effect: 0,
      other: 0,
    };
    for (const e of this.entries.values()) out[e.kind] += 1;
    return out;
  }

  /** Labels still tracked — used to report leaks (V24). */
  leaks(): string[] {
    return [...this.entries.values()].map((e) => `${e.kind}:${e.label}`);
  }

  /** Dispose everything tracked. Safe to call multiple times. */
  disposeAll(): void {
    for (const [resource, entry] of this.entries) {
      if (!entry.disposed) {
        resource.dispose();
        entry.disposed = true;
      }
    }
    this.entries.clear();
  }

  /** Throw if any resource remains tracked (a leak). Call after teardown to gate releases (V24). */
  assertNoLeaks(): void {
    if (this.entries.size > 0) {
      throw new Error(`resource leak: ${this.entries.size} undisposed -> ${this.leaks().join(', ')}`);
    }
  }
}
