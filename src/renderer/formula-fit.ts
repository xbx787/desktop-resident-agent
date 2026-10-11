/** The font size (px) that fits a block formula into its box. KaTeX width
 *  scales linearly with font size, so the fitted size is the base size times
 *  the visible-over-full ratio — one pass, no iteration. A floor keeps a
 *  monstrous formula legible; anything still wider than the box at the floor
 *  keeps its horizontal scroll as the last resort. Never enlarges. */
export const FORMULA_MIN_PX = 8;

export function fittedFontSize(basePx: number, visiblePx: number, fullPx: number, minPx: number = FORMULA_MIN_PX): number {
  if (!(basePx > 0) || !(visiblePx > 0) || !(fullPx > visiblePx)) return basePx;
  return Math.max(minPx, (basePx * visiblePx) / fullPx);
}
