import { describe, expect, it } from 'vitest';
import { fittedFontSize } from '../src/renderer/formula-fit';

describe('fittedFontSize', () => {
  it('shrinks proportionally to the overflow', () => {
    // 13 px text, 80 % fits → 10.4 px.
    expect(fittedFontSize(13, 249, 311.25)).toBeCloseTo(10.4, 5);
  });

  it('never enlarges a formula that already fits', () => {
    expect(fittedFontSize(13, 249, 249)).toBe(13);
    expect(fittedFontSize(13, 249, 200)).toBe(13);
  });

  it('fits any formula the floor still accommodates', () => {
    // 249/390 of 13 px is 8.3 — just over the 8 px floor, so it fits exactly.
    expect(fittedFontSize(13, 249, 390)).toBeCloseTo(8.3, 5);
  });

  it('stops at the floor — past it the scroll stays the last resort', () => {
    // A three-times-wide formula would need 4.3 px; the floor holds at 8.
    expect(fittedFontSize(13, 249, 747)).toBe(8);
    expect(fittedFontSize(13, 100, 1000, 8)).toBe(8);
  });

  it('returns the base size for degenerate measurements', () => {
    expect(fittedFontSize(0, 249, 390)).toBe(0);
    expect(fittedFontSize(13, 0, 390)).toBe(13);
  });
});
