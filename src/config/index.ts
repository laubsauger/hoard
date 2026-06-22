// T2 — config barrel. Importing this registers all foundation domains and exposes the API.
// Lanes import their domain modules here as they land (additive — collision-free per §T protocol).

export * from './types';
export { num, bool, enumOf, resolve, validateValue, validateSpec, ConfigError } from './spec';
export { registerDomain, resolveDomain, validateAll, registeredDomains } from './registry';

// Foundation domains (lane F).
export { timeConfig } from './domains/time';
export { gameConfig } from './domains/game';
