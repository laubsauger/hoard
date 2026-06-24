// App-side wrapper over the instant boot splash defined inline in index.html (window.__hbnBoot). The splash
// is HTML+CSS painted the moment the document parses — BEFORE the ~1.6 MB bundle downloads/parses — so a
// first-time visitor sees a branded loading screen instead of a blank page for the ~15 s it takes to fetch the
// app + its ~7 MB of GLB models. The app calls bootSet()/bootDone() to drive the bar and dismiss it once the
// world has actually rendered. All calls are no-ops if the splash element/API is absent (e.g. tests, SSR).

interface HbnBootApi {
  /** Set the bar to a 0..1 progress (monotonic — never goes backwards) and optionally update the status label. */
  set(progress: number, label?: string): void;
  /** Fill, fade, and remove the splash. Idempotent. */
  done(): void;
}

function api(): HbnBootApi | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { __hbnBoot?: HbnBootApi }).__hbnBoot ?? null;
}

export function bootSet(progress: number, label?: string): void {
  api()?.set(progress, label);
}

export function bootDone(): void {
  api()?.done();
}

/**
 * Aggregates download progress across several files (the GLBs) into a single fraction mapped onto a [lo, hi]
 * slice of the boot bar. Each file reports loaded/total bytes via its loader's onProgress; the summed fraction
 * drives the bar so the visitor watches "Loading models… 0→100%" while the hefty assets stream in. Totals are
 * only known once each file's first progress event lands (needs Content-Length — GitHub Pages sends it for
 * static files), so early on the estimate is partial and sharpens as each download starts.
 */
export class BootAssetProgress {
  private readonly loaded = new Map<string, number>();
  private readonly total = new Map<string, number>();

  constructor(
    private readonly lo: number,
    private readonly hi: number,
    private readonly label: string,
  ) {}

  /** Curried onProgress handler for one file id — pass `tracker.onProgress('ranger')` to loadAsync. */
  readonly onProgress = (id: string) => (e: ProgressEvent): void => {
    if (!e.lengthComputable || e.total <= 0) return;
    this.loaded.set(id, e.loaded);
    this.total.set(id, e.total);
    this.report();
  };

  private report(): void {
    let l = 0;
    let t = 0;
    for (const v of this.loaded.values()) l += v;
    for (const v of this.total.values()) t += v;
    if (t <= 0) return;
    const f = Math.min(1, l / t);
    bootSet(this.lo + (this.hi - this.lo) * f, `${this.label} ${Math.round(f * 100)}%`);
  }
}
