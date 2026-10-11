import { describe, expect, it } from 'vitest';
import { drawerBottomOffset } from '../src/renderer/panel-drawer';

describe('library drawer bottom offset', () => {
  it('stops the drawer at the composer dock\'s top edge', () => {
    expect(drawerBottomOffset(400, 345)).toBe(55);
    expect(drawerBottomOffset(400, 339.4)).toBe(61);
  });

  it('clamps to zero when the dock reaches the container\'s bottom edge', () => {
    expect(drawerBottomOffset(400, 400)).toBe(0);
    expect(drawerBottomOffset(400, 432)).toBe(0);
  });
});
