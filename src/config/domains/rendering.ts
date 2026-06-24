// Config domain: rendering. Owned by lane R (render).
// V4 — every render tunable carries unit/owner/default/range/tier. No magic numbers in engine code.
// V25 — capability thresholds are expressed as per-tier minimum adapter limits: the tier-resolution
// machinery (resolve(spec, tier)) gives the minimum a GPU must report to QUALIFY for that tier.
//
// This file was split into cohesive sub-domain field files under ./rendering/ (no behavior change).
// It assembles them into the SAME single registerDomain('rendering', {...}) registration, so every
// consumer (renderingConfig.X) and every test is unchanged — only the field DEFINITIONS were relocated.

import { registerDomain } from '../registry';
import { bloodFields } from './rendering/blood';
import { fireFields } from './rendering/fire';
import { impactFields } from './rendering/impact';
import { crowdFields } from './rendering/crowd';
import { highlightFields } from './rendering/highlight';
import { gibFields } from './rendering/gib';
import { combatFeedbackFields } from './rendering/combatFeedback';
import { houseFields } from './rendering/house';

export const renderingConfig = registerDomain('rendering', {
  ...bloodFields,
  ...fireFields,
  ...impactFields,
  ...crowdFields,
  ...highlightFields,
  ...gibFields,
  ...combatFeedbackFields,
  ...houseFields,
});

// Non-field exports relocated to ./rendering/crowd; re-exported here so existing
// `import { CROWD_LIMB_PARTS } from '.../domains/rendering'` keeps resolving unchanged.
export { CROWD_LIMB_PARTS } from './rendering/crowd';
export type { CrowdLimbId, CrowdLimbPart } from './rendering/crowd';
