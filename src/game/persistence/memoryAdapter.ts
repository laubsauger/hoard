// T14 — in-memory PersistenceAdapter for tests + deterministic replay.
// Values are deep-cloned on the way in/out so callers cannot mutate stored state by reference
// (mirrors the structured-clone boundary a real IndexedDB / worker write imposes — V26).

import { partitionId, type PartitionKey, type PersistenceAdapter } from './adapter';

export class InMemoryPersistenceAdapter implements PersistenceAdapter {
  private readonly store = new Map<string, Map<string, string>>();

  private partition(p: PartitionKey): Map<string, string> {
    const id = partitionId(p);
    let m = this.store.get(id);
    if (!m) { m = new Map(); this.store.set(id, m); }
    return m;
  }

  put<T>(partition: PartitionKey, key: string, value: T): Promise<void> {
    this.partition(partition).set(key, JSON.stringify(value));
    return Promise.resolve();
  }

  get<T>(partition: PartitionKey, key: string): Promise<T | null> {
    const raw = this.partition(partition).get(key);
    return Promise.resolve(raw === undefined ? null : (JSON.parse(raw) as T));
  }

  delete(partition: PartitionKey, key: string): Promise<void> {
    this.partition(partition).delete(key);
    return Promise.resolve();
  }

  list(partition: PartitionKey): Promise<string[]> {
    return Promise.resolve([...this.partition(partition).keys()]);
  }

  close(): Promise<void> {
    this.store.clear();
    return Promise.resolve();
  }

  /** Test/diagnostics — total stored records across all partitions. */
  get recordCount(): number {
    let n = 0;
    for (const m of this.store.values()) n += m.size;
    return n;
  }
}
