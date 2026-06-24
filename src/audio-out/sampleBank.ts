// Sampled-SFX bank (audio OUTPUT lane). Loads the authored .mp3 clips in src/assets/sfx, decodes them to
// AudioBuffers, and hands GameAudio a random VARIANT per named bank so repeated sounds (grunts, footsteps,
// zombie moans) don't machine-gun the same clip. Pure output (V2): the sim never reads this; render-local RNG
// (Math.random) is fine for variant choice (audio is not replay-deterministic). Decoding is async + best-effort
// — a clip that fails to fetch/decode is simply absent (its bank falls back to silent / the synth), never throws.

/** Eagerly-resolved URL of every sfx clip (Vite rewrites these to hashed, base-aware asset URLs at build). */
const SFX_URLS = import.meta.glob('../assets/sfx/**/*.mp3', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

/** Logical bank → path SUBSTRINGS; every clip whose source path contains one becomes a variant of that bank. */
export const SFX_BANKS = {
  // SUBSTRINGS that appear in the actual filenames (the authored clips carry an `author-` prefix between the
  // folder and the descriptive name, so a `folder/name` substring would NOT match — match the name part only).
  pistolIndoor: ['single-pistol-indoor'],
  pistolOutdoor: ['single-pistol-outdoor'],
  pistolReload: ['pistol-reload'],
  grunt: ['grunt/grunt-'], // 7 separated variants
  footstepConcrete: ['concrete-footsteps'],
  footstepDirt: ['walking-on-dirt', 'footsteps-dirt-gravel'],
  footstepGrass: ['walking-on-grass'],
  footstepWood: ['wood-creak'],
  doorOpen: ['door/door-open'],
  doorClose: ['door/door-close'],
  windowBreak: ['window-breaking'],
  containerOpen: ['cardboard-box-open'],
  knock: ['books-banging'],
  zombie: ['zombie/screams/'], // several moans/screams
  zombieDeath: ['zombie-dying'],
} as const;

export type SfxBankName = keyof typeof SFX_BANKS;

/** URLs of every clip belonging to a bank (path contains any of its substrings). */
function urlsFor(bank: SfxBankName): string[] {
  const subs = SFX_BANKS[bank];
  return Object.entries(SFX_URLS)
    .filter(([path]) => subs.some((s) => path.includes(s)))
    .map(([, url]) => url);
}

export class SampleBank {
  private readonly buffers = new Map<SfxBankName, AudioBuffer[]>();
  private loaded = false;

  /** Decode every bank's clips into AudioBuffers (best-effort, parallel). Idempotent. */
  async load(ctx: AudioContext): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    await Promise.all(
      (Object.keys(SFX_BANKS) as SfxBankName[]).map(async (bank) => {
        const bufs = await Promise.all(
          urlsFor(bank).map((url) =>
            fetch(url)
              .then((r) => r.arrayBuffer())
              .then((buf) => ctx.decodeAudioData(buf))
              .catch(() => null),
          ),
        );
        const ok = bufs.filter((b): b is AudioBuffer => b !== null);
        if (ok.length > 0) this.buffers.set(bank, ok);
      }),
    );
  }

  /** True once at least one clip of `bank` has decoded (callers fall back to the synth until then / if absent). */
  has(bank: SfxBankName): boolean {
    return (this.buffers.get(bank)?.length ?? 0) > 0;
  }

  /** A RANDOM decoded variant of `bank`, or null if none loaded (so repeated plays vary, V2 render-local RNG). */
  pick(bank: SfxBankName): AudioBuffer | null {
    const list = this.buffers.get(bank);
    if (!list || list.length === 0) return null;
    return list[Math.floor(Math.random() * list.length)] ?? null;
  }
}
