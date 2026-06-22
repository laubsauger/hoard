// T14 / R14 — IndexedDB-backed PersistenceAdapter (browser).
// IndexedDB is unavailable in Node, so this is STRUCTURED, not faked: it implements the real adapter
// shape and the real object-store layout, and throws a clear, explicit error if constructed where
// `indexedDB` is missing (V4 — no silent fallback to a fake store that would mask a broken save path).
// In the browser it opens one DB; each partition is one object store key-prefix.

import { partitionId, type PartitionKey, type PersistenceAdapter } from './adapter';

const STORE_NAME = 'deltas';

/** Narrow global lookup so this compiles under a DOM-less lib set without `any`. */
function getIndexedDB(): IDBFactory | undefined {
  const g = globalThis as { indexedDB?: IDBFactory };
  return g.indexedDB;
}

export class IndexedDbUnavailableError extends Error {
  constructor() {
    super('IndexedDB is not available in this environment (expected in Node). Use InMemoryPersistenceAdapter for tests.');
    this.name = 'IndexedDbUnavailableError';
  }
}

export class IndexedDbPersistenceAdapter implements PersistenceAdapter {
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(
    private readonly dbName = 'hordish-saves',
    private readonly version = 1,
  ) {
    if (getIndexedDB() === undefined) {
      // Fail loudly at construction so callers pick the in-memory adapter explicitly in Node.
      throw new IndexedDbUnavailableError();
    }
  }

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    const idb = getIndexedDB();
    if (idb === undefined) throw new IndexedDbUnavailableError();
    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = idb.open(this.dbName, this.version);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
    });
    return this.dbPromise;
  }

  private static recordKey(partition: PartitionKey, key: string): string {
    return `${partitionId(partition)}::${key}`;
  }

  private async tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode);
      const req = fn(transaction.objectStore(STORE_NAME));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error ?? new Error('indexedDB request failed'));
    });
  }

  async put<T>(partition: PartitionKey, key: string, value: T): Promise<void> {
    await this.tx('readwrite', (s) => s.put(JSON.stringify(value), IndexedDbPersistenceAdapter.recordKey(partition, key)));
  }

  async get<T>(partition: PartitionKey, key: string): Promise<T | null> {
    const raw = await this.tx<string | undefined>('readonly', (s) => s.get(IndexedDbPersistenceAdapter.recordKey(partition, key)));
    return raw === undefined ? null : (JSON.parse(raw) as T);
  }

  async delete(partition: PartitionKey, key: string): Promise<void> {
    await this.tx('readwrite', (s) => s.delete(IndexedDbPersistenceAdapter.recordKey(partition, key)));
  }

  async list(partition: PartitionKey): Promise<string[]> {
    const prefix = `${partitionId(partition)}::`;
    const keys = await this.tx<IDBValidKey[]>('readonly', (s) => s.getAllKeys());
    return keys
      .filter((k): k is string => typeof k === 'string' && k.startsWith(prefix))
      .map((k) => k.slice(prefix.length));
  }

  async close(): Promise<void> {
    if (this.dbPromise) {
      const db = await this.dbPromise;
      db.close();
      this.dbPromise = null;
    }
  }
}
