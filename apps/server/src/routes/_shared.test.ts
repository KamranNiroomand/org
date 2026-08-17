import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { patchOf } from './_shared.js';

/**
 * These guard a silent data-loss bug: `.partial()` keeps a field's `.default()`,
 * so a PATCH that omitted the field still arrived with the default filled in and
 * overwrote whatever was stored.
 */
describe('patchOf', () => {
  const create = z.object({
    title: z.string().min(1),
    priority: z.enum(['none', 'high']).default('none'),
    tags: z.array(z.string()).default([]),
    notes: z.string().nullish(),
  });

  it('leaves an omitted defaulted field absent instead of filling it in', () => {
    const parsed = patchOf(create).parse({ title: 'hi' });
    expect(parsed).toEqual({ title: 'hi' });
    expect('priority' in parsed).toBe(false);
    expect('tags' in parsed).toBe(false);
  });

  it('is what .partial() alone gets wrong', () => {
    // Documented so nobody "simplifies" patchOf back into a plain .partial().
    expect(create.partial().parse({ title: 'hi' })).toEqual({
      title: 'hi',
      priority: 'none',
      tags: [],
    });
  });

  it('still passes through the fields that were sent', () => {
    expect(patchOf(create).parse({ priority: 'high', tags: ['home'] })).toEqual({
      priority: 'high',
      tags: ['home'],
    });
  });

  it('keeps validating the fields it does receive', () => {
    expect(patchOf(create).safeParse({ priority: 'chartreuse' }).success).toBe(false);
    expect(patchOf(create).safeParse({ title: '' }).success).toBe(false);
  });

  it('makes every field optional, including required ones', () => {
    expect(patchOf(create).parse({})).toEqual({});
  });

  it('preserves an explicit null on a nullish field', () => {
    expect(patchOf(create).parse({ notes: null })).toEqual({ notes: null });
  });
});
