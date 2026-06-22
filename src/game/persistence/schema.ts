// T33 / V23 — save schema versioning + migration registry.
// Every persisted record carries an explicit `schemaVersion`. On load, a record older than the
// current build is migrated forward through a registry of vN -> vN+1 functions (composed from the
// FIRST public build, never skipping a step). A record from a FUTURE build (version > current) is
// rejected explicitly — we never guess at fields we don't yet understand (V23, V4: no invented
// fallbacks). A record with no/invalid version is treated as corrupt and rejected.

export const CURRENT_SAVE_SCHEMA_VERSION = 2;

/** Minimum schema version this build can still migrate from (the first public build). */
export const MIN_MIGRATABLE_SCHEMA_VERSION = 1;

export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaError';
  }
}

/** A migration takes a record at version N and returns the equivalent record at version N+1. */
export type Migration = (record: Record<string, unknown>) => Record<string, unknown>;

const MIGRATIONS = new Map<number, Migration>();

/** Register the vFrom -> vFrom+1 migration. Throws if one is already registered for that step. */
export function registerMigration(fromVersion: number, migrate: Migration): void {
  if (!Number.isInteger(fromVersion) || fromVersion < MIN_MIGRATABLE_SCHEMA_VERSION) {
    throw new SchemaError(`migration fromVersion must be an integer >= ${MIN_MIGRATABLE_SCHEMA_VERSION}, got ${fromVersion}`);
  }
  if (MIGRATIONS.has(fromVersion)) {
    throw new SchemaError(`migration from v${fromVersion} already registered`);
  }
  MIGRATIONS.set(fromVersion, migrate);
}

/** Read a record's declared schema version, or throw if absent/invalid (a corrupt record). */
export function readSchemaVersion(record: unknown): number {
  if (typeof record !== 'object' || record === null) {
    throw new SchemaError(`record is not an object (${typeof record})`);
  }
  const v = (record as { schemaVersion?: unknown }).schemaVersion;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < MIN_MIGRATABLE_SCHEMA_VERSION) {
    throw new SchemaError(`record has no valid schemaVersion (got ${String(v)})`);
  }
  return v;
}

/**
 * Migrate a raw record up to the current schema version. Throws SchemaError for a future version
 * (cannot downgrade), a missing migration step, or a non-advancing migration. Returns the migrated
 * record (still subject to world/asset compat validation by the caller).
 */
export function migrateToCurrent(raw: Record<string, unknown>): Record<string, unknown> {
  let version = readSchemaVersion(raw);
  if (version > CURRENT_SAVE_SCHEMA_VERSION) {
    throw new SchemaError(
      `save schema v${version} is newer than this build (v${CURRENT_SAVE_SCHEMA_VERSION}); refusing to load`,
    );
  }
  let record = raw;
  while (version < CURRENT_SAVE_SCHEMA_VERSION) {
    const migrate = MIGRATIONS.get(version);
    if (!migrate) throw new SchemaError(`no migration registered from save schema v${version}`);
    record = migrate(record);
    const next = readSchemaVersion(record);
    if (next <= version) throw new SchemaError(`migration from v${version} did not advance the version (got v${next})`);
    version = next;
  }
  return record;
}
