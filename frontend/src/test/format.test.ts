import { describe, expect, it } from 'vitest';
import { fmtM } from '../format';

describe('fmtM', () => {
  it('never shows a negative zero', () => {
    expect(fmtM(-0.004)).toBe('0 m');
    expect(fmtM(1234.4)).toBe('1,234 m');
  });
});
