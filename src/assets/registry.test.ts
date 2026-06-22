import { describe, expect, it } from 'vitest';
import { createManifest, AssetError, type AssetBundle } from './manifest';
import { RecordingAssetLoader } from './loader';
import { AssetRegistry } from './registry';
import { bytes, raw } from './units';

function bundle(id: string, deps: string[], resBytes: number): AssetBundle {
  return {
    id,
    assetIds: [`asset.${id}`],
    dependencies: deps,
    resources: [{ id: `res.${id}`, kind: 'geometry', bytes: bytes(resBytes) }],
  };
}

describe('asset manifest + registry lifecycle (T34 / V24)', () => {
  it('rejects missing dependencies and dependency cycles at manifest construction', () => {
    expect(() => createManifest([bundle('a', ['ghost'], 10)])).toThrow(AssetError);
    expect(() =>
      createManifest([bundle('a', ['b'], 10), bundle('b', ['a'], 10)]),
    ).toThrow(/cycle/);
  });

  it('loads dependencies before dependents and disposes them when the last holder releases', async () => {
    const manifest = createManifest([bundle('a', ['b'], 100), bundle('b', [], 50)]);
    const loader = new RecordingAssetLoader();
    const registry = new AssetRegistry(manifest, loader);

    await registry.acquire('a');
    expect(registry.isLive('a')).toBe(true);
    expect(registry.isLive('b')).toBe(true);
    expect(raw(registry.liveResourceBytes())).toBe(150);

    registry.release('a');
    // a + its only-referenced dependency b are both disposed; no leaked bytes (V24).
    expect(registry.isLive('a')).toBe(false);
    expect(registry.isLive('b')).toBe(false);
    expect(raw(registry.liveResourceBytes())).toBe(0);
  });

  it('keeps a shared dependency live while another holder references it (independent dispose)', async () => {
    const manifest = createManifest([bundle('a', ['b'], 100), bundle('b', [], 50)]);
    const loader = new RecordingAssetLoader();
    const registry = new AssetRegistry(manifest, loader);

    await registry.acquire('a'); // loads a + b
    await registry.acquire('b'); // direct hold on b
    expect(registry.refCount('b')).toBe(2);

    registry.release('a'); // a gone, b still held directly
    expect(registry.isLive('a')).toBe(false);
    expect(registry.isLive('b')).toBe(true);
    expect(raw(registry.liveResourceBytes())).toBe(50);

    registry.release('b');
    expect(registry.isLive('b')).toBe(false);
    expect(raw(registry.liveResourceBytes())).toBe(0);
  });

  it('refuses to release a bundle that was never acquired (no silent fallback)', () => {
    const manifest = createManifest([bundle('a', [], 10)]);
    const registry = new AssetRegistry(manifest, new RecordingAssetLoader());
    expect(() => registry.release('a')).toThrow(AssetError);
  });

  it('does not load a bundle twice when acquired by two holders (ref-counted)', async () => {
    const manifest = createManifest([bundle('a', [], 100)]);
    const loader = new RecordingAssetLoader();
    const registry = new AssetRegistry(manifest, loader);

    await registry.acquire('a');
    await registry.acquire('a');
    expect(registry.refCount('a')).toBe(2);
    expect(loader.loadedBundleIds()).toEqual(['a']);
    expect(raw(registry.liveResourceBytes())).toBe(100);

    registry.release('a');
    expect(registry.isLive('a')).toBe(true); // still one holder
    registry.release('a');
    expect(registry.isLive('a')).toBe(false);
  });
});
