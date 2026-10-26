import { describe, expect, it } from 'vitest';
import { createLatestOnly } from '../api/sequencer';

describe('createLatestOnly', () => {
  it('only the newest ticket is latest, and older ones are aborted', () => {
    const s = createLatestOnly();
    const a = s.next();
    const b = s.next();
    expect(s.isLatest(a.id)).toBe(false);
    expect(s.isLatest(b.id)).toBe(true);
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
    s.cancel();
    expect(s.isLatest(b.id)).toBe(false);
    expect(b.signal.aborted).toBe(true);
  });
});
