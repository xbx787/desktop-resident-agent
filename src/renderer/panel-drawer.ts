/** The library drawer's offset from its container's bottom edge, given the
 *  composer dock's top in the same coordinate space. The drawer's lower edge
 *  lands on the composer's upper edge, so the input stays visible and usable
 *  while the drawer is open — the offset is re-measured on every resize to
 *  follow the composer through collapses, expansions, and added lines. */
export function drawerBottomOffset(containerBottom: number, dockTop: number): number {
  return Math.max(0, Math.round(containerBottom - dockTop));
}
