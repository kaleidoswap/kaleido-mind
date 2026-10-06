import { describe, it, expect } from 'vitest';
import { toQvacTools } from './tools.js';
import { WALLET_TOOLS } from '../wallet/contract.js';

describe('toQvacTools', () => {
  it('returns undefined for no tools', () => {
    expect(toQvacTools([])).toBeUndefined();
  });

  it('keeps JSON-Schema parameters as a full function tool', () => {
    const [tool] = toQvacTools([
      {
        name: 'rln_send_btc',
        description: 'send',
        parameters: {
          type: 'object',
          properties: {
            address: { type: 'string', description: 'Destination' },
            amount_sat: { type: 'integer' },
            note: { type: ['string', 'null'] },
            mode: { anyOf: [{ type: 'null' }, { type: 'boolean' }] },
            tags: { type: 'array', items: { type: 'string' } },
            schema: { type: 'string', enum: ['NIA', 'CFA'] },
          },
          required: ['address', 'amount_sat', 'ghost'],
          additionalProperties: false,
        },
      },
    ])!;
    expect(tool).toEqual({
      type: 'function',
      name: 'rln_send_btc',
      description: 'send',
      parameters: {
        type: 'object',
        properties: {
          address: { type: 'string', description: 'Destination' },
          amount_sat: { type: 'integer' },
          note: { type: 'string' },
          mode: { type: 'boolean' },
          tags: { type: 'array' },
          schema: { type: 'string', enum: ['NIA', 'CFA'] },
        },
        required: ['address', 'amount_sat'],
      },
    });
  });

  it('passes an all-Zod tool list through for the SDK to convert', () => {
    const zodish = { shape: {} };
    expect(toQvacTools([{ name: 'a', description: 'd', parameters: zodish }])).toEqual([
      { name: 'a', description: 'd', parameters: zodish },
    ]);
  });

  it('converts Zod-like tools when mixed with JSON-Schema tools', () => {
    const zodish = {
      shape: {
        city: { type: 'string', description: 'City' },
        unit: { type: 'optional', def: { innerType: { type: 'enum', def: { entries: { c: 'c', f: 'f' } } } } },
      },
    };
    const out = toQvacTools([
      { name: 'weather', description: 'w', parameters: zodish },
      { name: 'ping', description: 'p', parameters: { type: 'object', properties: {} } },
    ])!;
    expect(out[0]).toEqual({
      type: 'function',
      name: 'weather',
      description: 'w',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string', description: 'City' }, unit: { type: 'string', enum: ['c', 'f'] } },
        required: ['city'],
      },
    });
  });

  it('every wallet contract tool keeps its arguments', () => {
    const out = toQvacTools(WALLET_TOOLS) as Array<{ name: string; parameters: { properties: object } }>;
    for (const def of WALLET_TOOLS) {
      const mapped = out.find((t) => t.name === def.name)!;
      expect(Object.keys(mapped.parameters.properties)).toEqual(Object.keys((def.parameters as any).properties));
    }
  });
});
