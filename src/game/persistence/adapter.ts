// T14 / V9 / §I-persist — persistence adapter contract.
// Storage is partitioned by district/sector (§I). Base world packages are immutable and stored
// SEPARATELY from compact modification deltas (V9) — this interface only ever stores deltas +
// metadata, never untouched base assets. Same interface backs the in-memory (tests) + IndexedDB
// (browser) implementations so call sites never branch on environment.

/** Partition a save by spatial owner (§I — partition by district/sector). */
export interface PartitionKey {
  readonly district: number;
  /** -1 = district-level record (no specific sector). */
  readonly sector: number;
}

export function partitionId(p: PartitionKey): string {
  return `d${p.district}/s${p.sector}`;
}

export interface PersistenceAdapter {
  /** Store a JSON-serializable value under (partition, key). Overwrites at record granularity (V23). */
  put<T>(partition: PartitionKey, key: string, value: T): Promise<void>;
  /** Read a value, or null when absent (explicit null — never an invented default). */
  get<T>(partition: PartitionKey, key: string): Promise<T | null>;
  delete(partition: PartitionKey, key: string): Promise<void>;
  /** Keys present in a partition. */
  list(partition: PartitionKey): Promise<string[]>;
  /** Release any held resources (connections, handles) — V24. */
  close(): Promise<void>;
}
