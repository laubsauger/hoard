// T42 — frozen contract barrel. Downstream lanes import from here.

export * from './ids';
export * from './commands';
export * from './events';
export * from './soa';
export * from './snapshots';
export * from './workers';

/** Exhaustiveness guard for discriminated unions (V26). Throws if a case is unhandled. */
export function assertNever(value: never, context = 'value'): never {
  throw new Error(`unhandled ${context}: ${JSON.stringify(value)}`);
}
