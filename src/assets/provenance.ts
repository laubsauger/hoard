// T34 / V7 — source provenance + license for a generated/authored asset.
// V7: image-to-3D output is SOURCE MATERIAL, not a shippable runtime asset. Provenance is carried
// forward through every pipeline stage so a shipped asset always traces back to its origin + license.

/** How the source mesh originated. Image-to-3D is explicitly a source, never a runtime asset (V7). */
export type AssetGenerator =
  | 'image-to-3d'
  | 'photogrammetry'
  | 'authored'
  | 'procedural';

export const ASSET_GENERATORS: readonly AssetGenerator[] = [
  'image-to-3d',
  'photogrammetry',
  'authored',
  'procedural',
];

export interface LicenseInfo {
  /** SPDX-style identifier or studio-internal license id. */
  readonly id: string;
  /** Required attribution text (empty string if none). */
  readonly attribution: string;
  readonly redistributable: boolean;
  readonly commercialUse: boolean;
}

export interface SourceProvenance {
  readonly sourceUri: string;
  readonly generator: AssetGenerator;
  /** ISO-8601 timestamp of source capture/generation. */
  readonly capturedAtIso: string;
  readonly license: LicenseInfo;
}
