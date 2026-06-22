// T33 — saving config domain (V4): self-registers, every tunable resolves in range, mobile tier
// relaxes save cadence/journal. Isolated in its own test file so registration happens exactly once.

import { describe, it, expect } from 'vitest';
import { resolveDomain } from '../registry';
import { savingConfig } from './saving';

describe('saving config domain (V4)', () => {
  it('resolves a complete, sane value set at the reference tier', () => {
    const s = resolveDomain(savingConfig, 'desktop-high');
    expect(s.checkpointIntervalTicks).toBeGreaterThan(0);
    expect(s.journalMaxEntries).toBeGreaterThan(0);
    expect(s.retainedCheckpoints).toBeGreaterThanOrEqual(2); // V23 — keep a previous valid checkpoint
    expect(s.maxRecordsPerPartition).toBeGreaterThan(0);
  });

  it('relaxes checkpoint cadence + journal length on mobile', () => {
    const desktop = resolveDomain(savingConfig, 'desktop-high');
    const mobile = resolveDomain(savingConfig, 'mobile-webgpu');
    expect(mobile.checkpointIntervalTicks).toBeGreaterThan(desktop.checkpointIntervalTicks);
    expect(mobile.journalMaxEntries).toBeLessThan(desktop.journalMaxEntries);
  });
});
