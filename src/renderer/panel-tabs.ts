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
