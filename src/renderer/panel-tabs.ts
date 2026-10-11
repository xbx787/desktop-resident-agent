/** The state-tab strip's arithmetic: how many conversation slots it shows and
 *  when the "+" appears. Kept as pure functions so the rules stay pinned by
 *  tests rather than buried in the panel component. */

/** Five slots — the owner's rule — regardless of what the stored setting
 *  says (libraries may still carry 1–12 from before). */
export const TAB_SLOTS = 5;

export function quickTabLimit(visibleConversationTabs: number | undefined): number {
  return Math.max(1, Math.min(TAB_SLOTS, visibleConversationTabs ?? TAB_SLOTS));
}

/** The "+" rides at the right of the tabs and leaves once every slot is
 *  taken — with five conversations on the strip there is no add button. */
export function showNewTabButton(tabCount: number, limit: number): boolean {
  return tabCount < limit;
}

/** The quick tabs' display order: ids the user has arranged by hand lead in
 *  that order; anything never placed follows by recency — which is also the
 *  whole order while no arrangement exists yet. */
export function orderConversationTabs<T extends { id: string; updatedAt: string }>(items: T[], tabOrder: readonly string[]): T[] {
  if (tabOrder.length === 0) return items.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const rank = new Map(tabOrder.map((id, index) => [id, index]));
  return items.slice().sort((a, b) => {
    const ra = rank.get(a.id);
    const rb = rank.get(b.id);
    if (ra === undefined && rb === undefined) return b.updatedAt.localeCompare(a.updatedAt);
    if (ra === undefined) return 1;
    if (rb === undefined) return -1;
    return ra - rb;
  });
}

/** One tab's drag: pull it out and put it back down at the target slot.
 *  Returns the same array when nothing moved, so React bails out. */
export function moveTab(ids: string[], id: string, toIndex: number): string[] {
  const from = ids.indexOf(id);
  if (from < 0) return ids;
  const to = Math.max(0, Math.min(ids.length - 1, toIndex));
  if (from === to) return ids;
  const next = ids.slice();
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}
