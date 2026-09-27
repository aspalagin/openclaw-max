import { describe, expect, it } from 'vitest';

import { isMaxGatewayDrainingError, maxDrainRetryDelayMs } from './gateway-drain.js';

const draining = () =>
  Object.assign(new Error('Gateway is draining; new tasks are not accepted'), {
    name: 'GatewayDrainingError',
  });

/** `err` wrapped `depth` times in `cause`. */
const wrapped = (err: unknown, depth: number): unknown =>
  depth === 0 ? err : new Error(`wrap ${depth}`, { cause: wrapped(err, depth - 1) });

describe('isMaxGatewayDrainingError', () => {
  it('recognizes core drain refusal by name, also in the cause chain up to 5 deep', () => {
    expect(isMaxGatewayDrainingError(draining())).toBe(true);
    expect(isMaxGatewayDrainingError(wrapped(draining(), 1))).toBe(true);
    expect(isMaxGatewayDrainingError(wrapped(draining(), 5))).toBe(true);
    expect(isMaxGatewayDrainingError(wrapped(draining(), 6))).toBe(false);
  });

  it('rejects other errors and non-errors', () => {
    expect(isMaxGatewayDrainingError(new Error('Gateway is draining'))).toBe(false);
    expect(isMaxGatewayDrainingError(wrapped(new Error('boom'), 2))).toBe(false);
    expect(isMaxGatewayDrainingError('GatewayDrainingError')).toBe(false);
    expect(isMaxGatewayDrainingError(undefined)).toBe(false);
    expect(isMaxGatewayDrainingError(null)).toBe(false);
  });
});

describe('maxDrainRetryDelayMs', () => {
  it('pauses 2 s, 5 s, 10 s, then every 30 s', () => {
    expect([1, 2, 3, 4, 5, 50].map(maxDrainRetryDelayMs)).toEqual([
      2_000, 5_000, 10_000, 30_000, 30_000, 30_000,
    ]);
  });
});
