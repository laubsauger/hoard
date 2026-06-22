// T42 / V3 / V26 — Struct-of-Arrays layout contract. Frozen.
// High-count zombie data lives in ONE backing buffer partitioned into per-field views with
// computed byte offsets. One buffer => shareable across workers (SharedArrayBuffer) without
// passing object refs (V26). Render lane reads these views; it never owns the authority (V3).

export type FieldType = 'f32' | 'i32' | 'u32' | 'u16' | 'u8';

export interface FieldDescriptor {
  readonly name: string;
  readonly type: FieldType;
  /** Components per entity (e.g. position xyz = 3). */
  readonly components: number;
  readonly doc: string;
}

const BYTES: Record<FieldType, number> = { f32: 4, i32: 4, u32: 4, u16: 2, u8: 1 };

/**
 * Frozen zombie data layout (handout "high-count zombie data groups").
 * Order is part of the contract — appending is a coordinated edit, reordering breaks saves/workers.
 */
export const ZOMBIE_FIELDS: readonly FieldDescriptor[] = [
  { name: 'archetype', type: 'u16', components: 1, doc: 'identity + archetype index' },
  { name: 'alive', type: 'u8', components: 1, doc: '1 = alive, 0 = dead/free slot' },
  { name: 'position', type: 'f32', components: 3, doc: 'world meters x,y,z' },
  { name: 'heading', type: 'f32', components: 1, doc: 'radians' },
  { name: 'velocity', type: 'f32', components: 3, doc: 'world meters/sec x,y,z' },
  { name: 'state', type: 'u8', components: 1, doc: 'behavior FSM state id' },
  { name: 'stateTimer', type: 'f32', components: 1, doc: 'seconds in current state' },
  { name: 'health', type: 'f32', components: 1, doc: 'current health' },
  { name: 'anatomyFlags', type: 'u32', components: 1, doc: 'bitfield: severed/disabled regions' },
  { name: 'target', type: 'i32', components: 1, doc: 'target entity slot, -1 = none' },
  { name: 'stimulus', type: 'i32', components: 1, doc: 'active stimulus id, -1 = none' },
  { name: 'chunk', type: 'i32', components: 1, doc: 'owning render-chunk index' },
  { name: 'spatialCell', type: 'i32', components: 1, doc: 'collision broad-phase cell index' },
  { name: 'navGroup', type: 'i32', components: 1, doc: 'shared flow-field group, -1 = none' },
  { name: 'simTier', type: 'u8', components: 1, doc: '0 hero / 1 active / 2 horde / 3 abstract' },
  { name: 'renderTier', type: 'u8', components: 1, doc: 'render representation tier' },
  { name: 'animState', type: 'u8', components: 1, doc: 'animation clip id' },
  { name: 'animPhase', type: 'f32', components: 1, doc: 'normalized 0..1 animation phase' },
];

export interface FieldLayout {
  readonly name: string;
  readonly type: FieldType;
  readonly components: number;
  /** Byte offset of this field's sub-array within the backing buffer. */
  readonly byteOffset: number;
  /** Total elements in this field's view = capacity * components. */
  readonly length: number;
}

export interface SoaLayout {
  readonly capacity: number;
  readonly byteLength: number;
  readonly fields: readonly FieldLayout[];
}

/** Compute the deterministic byte layout for a field set at a given capacity. */
export function computeLayout(fields: readonly FieldDescriptor[], capacity: number): SoaLayout {
  if (!Number.isInteger(capacity) || capacity <= 0) {
    throw new Error(`SoA capacity must be a positive integer, got ${capacity}`);
  }
  const seen = new Set<string>();
  const out: FieldLayout[] = [];
  let offset = 0;
  for (const f of fields) {
    if (seen.has(f.name)) throw new Error(`duplicate SoA field '${f.name}'`);
    seen.add(f.name);
    const bytes = BYTES[f.type];
    // Align each field sub-array to its element size for valid typed-array views.
    if (offset % bytes !== 0) offset += bytes - (offset % bytes);
    const length = capacity * f.components;
    out.push({ name: f.name, type: f.type, components: f.components, byteOffset: offset, length });
    offset += length * bytes;
  }
  return { capacity, byteLength: offset, fields: out };
}

export type FieldViews = Record<string, Float32Array | Int32Array | Uint32Array | Uint16Array | Uint8Array>;

function viewFor(type: FieldType, buf: ArrayBufferLike, byteOffset: number, length: number) {
  switch (type) {
    case 'f32': return new Float32Array(buf, byteOffset, length);
    case 'i32': return new Int32Array(buf, byteOffset, length);
    case 'u32': return new Uint32Array(buf, byteOffset, length);
    case 'u16': return new Uint16Array(buf, byteOffset, length);
    case 'u8': return new Uint8Array(buf, byteOffset, length);
  }
}

export interface SoaBuffer {
  readonly layout: SoaLayout;
  readonly buffer: ArrayBufferLike;
  readonly views: FieldViews;
}

/** Allocate a backing buffer + typed views. Uses SharedArrayBuffer when available + requested (R13). */
export function allocateSoa(
  fields: readonly FieldDescriptor[],
  capacity: number,
  options: { shared?: boolean } = {},
): SoaBuffer {
  const layout = computeLayout(fields, capacity);
  const wantShared = options.shared === true && typeof SharedArrayBuffer !== 'undefined';
  const buffer: ArrayBufferLike = wantShared
    ? new SharedArrayBuffer(layout.byteLength)
    : new ArrayBuffer(layout.byteLength);
  const views: FieldViews = {};
  for (const f of layout.fields) {
    views[f.name] = viewFor(f.type, buffer, f.byteOffset, f.length);
  }
  return { layout, buffer, views };
}
