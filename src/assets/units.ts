// T34 / V4 / V26 — unit-tagged numeric types for the asset contract.
// Distinguishing units in types keeps meters/triangles/bytes/bones from mixing silently.
// These are nominal brands at compile time and plain numbers at runtime; construct via the helpers.

export type Brand<T, U extends string> = T & { readonly __unit: U };

/** World-space length. */
export type Meters = Brand<number, 'meters'>;
/** Angle in degrees (V26 distinguishes degrees from radians). */
export type Degrees = Brand<number, 'degrees'>;
/** Triangle count of a geometry. */
export type Triangles = Brand<number, 'triangles'>;
/** Byte count (texture / buffer memory). */
export type Bytes = Brand<number, 'bytes'>;
/** Skeleton bone count. */
export type BoneCount = Brand<number, 'bones'>;
/** Dimensionless count (slots, draw groups, pixels-per-side, …). */
export type Count = Brand<number, 'count'>;
/** Dimensionless ratio / fraction (0..1 unless documented otherwise). */
export type Ratio = Brand<number, 'ratio'>;

export const meters = (v: number): Meters => v as unknown as Meters;
export const degrees = (v: number): Degrees => v as unknown as Degrees;
export const triangles = (v: number): Triangles => v as unknown as Triangles;
export const bytes = (v: number): Bytes => v as unknown as Bytes;
export const boneCount = (v: number): BoneCount => v as unknown as BoneCount;
export const count = (v: number): Count => v as unknown as Count;
export const ratio = (v: number): Ratio => v as unknown as Ratio;

/** Strip the brand for arithmetic / display. */
export const raw = (v: Brand<number, string>): number => v as unknown as number;
