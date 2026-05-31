import { describe, expect, it } from 'vitest';
import { normalizeSlug } from '../src/customer/slug.js';

describe('normalizeSlug', () => {
  it('lowercases and trims surrounding whitespace', () => {
    expect(normalizeSlug('  Voyelle  ')).toBe('voyelle');
  });

  it('strips characters outside [a-z0-9_-]', () => {
    expect(normalizeSlug('Café Lüks!')).toBe('caflks');
  });

  it('preserves underscores and hyphens', () => {
    expect(normalizeSlug('moda_sogutma-2')).toBe('moda_sogutma-2');
  });

  it('removes spaces between words', () => {
    expect(normalizeSlug('Durak Makine')).toBe('durakmakine');
  });

  it('returns empty string when nothing remains', () => {
    expect(normalizeSlug('   @#$ ÇŞ   ')).toBe('');
  });
});
