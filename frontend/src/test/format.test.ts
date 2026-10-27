import { describe, expect, it } from 'vitest';
import { fmtM, splitHours } from '../format';

describe('fmtM', () => {
  it('never shows a negative zero', () => {
    expect(fmtM(-0.004)).toBe('0 m');
    expect(fmtM(1234.4)).toBe('1,234 m');
  });
});

describe('splitHours', () => {
  it('puts each day on its own line', () => {
    expect(splitHours('Sunday: Closed Monday: 10:00 am - 8:00 pm Tuesday: 10:00 am - 8:00 pm')).toEqual([
      'Sunday: Closed',
      'Monday: 10:00 am - 8:00 pm',
      'Tuesday: 10:00 am - 8:00 pm',
    ]);
  });
  it('keeps other formats as one line and handles missing hours', () => {
    expect(splitHours('8am-4pm, Open later seasonally')).toEqual(['8am-4pm, Open later seasonally']);
    expect(splitHours(null)).toEqual([]);
    expect(splitHours('')).toEqual([]);
  });
});
