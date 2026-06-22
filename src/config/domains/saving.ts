// Config domain: saving. Owned by lane S. Full-persistence budgets (T33).
// V4 — checkpoint cadence, mutation-journal length, retained-checkpoint depth, and per-partition
// record ceiling are typed + range-validated config, never magic numbers buried in the save code.
// V23 — retainedCheckpoints >= 2 keeps a previous valid checkpoint so a corrupt latest one is
// recoverable; journalMaxEntries bounds the crash-recovery replay (short journal, then compact).

import { num } from '../spec';
import { registerDomain } from '../registry';

export const savingConfig = registerDomain('saving', {
  /** Authoritative ticks between automatic checkpoints (full partition state snapshot). */
  checkpointIntervalTicks: num({
    owner: 'saving',
    unit: 'ticks',
    doc: 'Authoritative ticks between periodic crash-recovery checkpoints.',
    default: 1800, // ~60 s at the 30 Hz default tick rate
    min: 1,
    max: 216000,
    integer: true,
    tiers: { 'mobile-webgpu': 3600 },
  }),
  /** Max mutation-journal entries kept atop a checkpoint before it is compacted into a new checkpoint. */
  journalMaxEntries: num({
    owner: 'saving',
    unit: 'count',
    doc: 'Mutation-journal length atop a checkpoint before compaction; bounds crash-recovery replay.',
    default: 256,
    min: 1,
    max: 65536,
    integer: true,
    tiers: { 'mobile-webgpu': 128 },
  }),
  /** How many recent checkpoints to retain per partition (>=2 keeps a previous valid one — V23). */
  retainedCheckpoints: num({
    owner: 'saving',
    unit: 'count',
    doc: 'Recent checkpoints retained per partition so a corrupt latest checkpoint can fall back (V23).',
    default: 2,
    min: 2,
    max: 16,
    integer: true,
  }),
  /** Ceiling on records (checkpoints + journal) a single partition may hold before compaction. */
  maxRecordsPerPartition: num({
    owner: 'saving',
    unit: 'count',
    doc: 'Hard cap on stored records in one district/sector partition; partition isolation bound (V23).',
    default: 4096,
    min: 8,
    max: 1048576,
    integer: true,
  }),
});
