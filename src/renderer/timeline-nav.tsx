import { type CSSProperties, useEffect, useRef, useState } from 'react';
import type { TimelineGroup } from './timeline-groups';

export interface NavMark {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

/** One mark per turn — the user's own line, which is what opened it. The
 *  model's replies and the steered mid-turn messages live inside their turn
 *  and are not landmarks a reader navigates by. */
export function navMarks(groups: readonly TimelineGroup[]): NavMark[] {
  const marks: NavMark[] = [];
  for (const group of groups) {
    if (group.kind === 'single') {
      if (group.entry.kind === 'user') marks.push({ id: group.entry.id, role: 'user', text: group.entry.text });
      continue;
    }
    marks.push({ id: group.user.id, role: 'user', text: group.user.text });
  }
  return marks;
}

/** How many marks the rail shows at once — the wheel slides this window
 *  across the whole conversation instead of stacking every mark. The
 *  expanded bubble has room for sixty; the compact one keeps twenty. */
export const NAV_WINDOW_WIDE = 60;
export const NAV_WINDOW_COMPACT = 20;
/** Row pitch of the rail: a 3.2 px mark plus a 2.4 px gap. Both are multiples
 *  of 0.8, so under 125% display scaling every row lands on a whole physical
 *  pixel — mixed rounding used to make the rows look unevenly spaced. */
export const NAV_STEP = 5.6;
/** Mark height and the rail's vertical padding — the pieces both the track
 *  height and the hover card's anchor are built from. */
const NAV_MARK = 3.2;
const NAV_PAD = 6;
/** The resting handle: just the newest few marks, short enough not to crowd
 *  the messages beside it. */
export const NAV_RESTING = 3;

/** The expanded rail's height for a number of visible marks. A full window is
 *  the historical 345.6 px; fewer marks make a shorter rail — the grid used to
 *  stretch its rows to the full 60-row box, leaving a dozen marks adrift in a
 *  wide-spaced column. */
export function navTrackHeight(count: number): number {
  return NAV_PAD * 2 + Math.max(0, count - 1) * NAV_STEP + NAV_MARK;
}

/** The hover card's centre relative to the rail's centre, pinned to the
 *  hovered row: half a mark below the row's top edge, one step per row. At a
 *  full 60-row window this equals the old fixed offset; a short rail no longer
 *  throws the card far off the mark it describes. */
export function navCardOffset(count: number, active: number): number {
  return active * NAV_STEP + NAV_MARK / 2 + NAV_PAD - navTrackHeight(count) / 2;
}

/** The slice of marks the rail shows for a given window start and size. */
export function navWindow(count: number, start: number, size: number): { from: number; to: number } {
  const from = Math.max(0, Math.min(Math.max(0, count - size), start));
  return { from, to: Math.min(count, from + size) };
}

/** Where a wheel nudge lands: the window clamps at the conversation's ends,
 *  so a nudge pushed past the end returns the same start — the wheel handler
 *  reads that unchanged value as "the rail is already there" and stays
 *  quiet. */
export function navNextStart(count: number, size: number, current: number, delta: number): number {
  return Math.max(0, Math.min(Math.max(0, count - size), current + delta));
}

/** The hover card shows three lines' worth at most — anything longer is
 *  dropped rather than scrolled: the full text already lives in the timeline,
 *  and the popover should not hold a second copy of it. */
export function navPreview(text: string): string {
  const clean = text.trim();
  return clean.length > 120 ? `${clean.slice(0, 120)}…` : clean;
}

/** The dock-style arc: the hovered mark is longest and its neighbours (and
 *  theirs) shrink with distance — the extra length in px on top of the base. */
export function navBoost(distance: number): number {
  return Math.max(0, 10 - distance * 2);
}

/** How many marks one wheel event slides the window. A normal notch (pixel
 *  mode ~120, line mode ~3) moves three; an accelerated wheel sends large
 *  pixel deltas in a single event, so the step scales with the delta — a hard
 *  flick that used to move three marks now rolls to where it was aimed. */
export function navWheelStep(deltaY: number): number {
  return Math.max(3, Math.min(24, Math.round(Math.abs(deltaY) / 40)));
}

/** The classes one mark renders with. Every mark is the user's own line, so
 *  there is no speaker tone to split — only the pointer highlight, and that
 *  belongs to the opened rail alone. */
export function navMarkClass(expanded: boolean, isActive: boolean): string {
  return `panel-nav-mark${expanded && isActive ? ' is-active' : ''}`;
}

/** Which mark row the pointer sits in — the wheel re-anchors the hover with
 *  it. Rows have a constant 5.6 px pitch, so a still pointer keeps the same
 *  row number while the window slides; only what that row shows changes.
 *  Returns null over the rail's padding or past its end. */
export function navRowAt(clientY: number, trackTop: number, count: number): number | null {
  const row = Math.floor((clientY - trackTop - NAV_PAD) / NAV_STEP);
  return row >= 0 && row < count ? row : null;
}

/**
 * The message rail: a short handle of the newest marks at rest; hovering
 * opens a window of the newest sixty marks that the wheel slides up and down
 * the whole conversation, and clicking a mark jumps to that message. The wheel
 * is captured while hovering so the feed behind never scrolls instead.
 */
export function TimelineNav({ marks, onJump, windowSize = NAV_WINDOW_WIDE, baseWidth = 8.8 }: { marks: NavMark[]; onJump: (id: string) => void; windowSize?: number; baseWidth?: number }) {
  const [expanded, setExpanded] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  const [start, setStart] = useState(() => Math.max(0, marks.length - windowSize));
  // The wheel handler reads the live start from a ref: the listener is
  // registered once per expanded/marks change, and re-binding it on every
  // scroll just to see the new start would tear down the wheel capture
  // mid-gesture.
  const startRef = useRef(start);
  startRef.current = start;
  // A window-size change re-anchors the rail to the newest marks: a start
  // that was legal for the old size can point far away for the new one.
  useEffect(() => {
    setStart(Math.max(0, marks.length - windowSize));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowSize]);
  const trackRef = useRef<HTMLDivElement>(null);
  const rollRef = useRef<Animation | null>(null);
  const frameRef = useRef<number | null>(null);
  const pendingRef = useRef<{ start: number; clientY: number; moved: boolean; direction: number } | null>(null);

  useEffect(() => {
    const node = trackRef.current;
    if (!node || !expanded) return;
    const onWheel = (event: WheelEvent) => {
      // The wheel moves the rail's window, never the feed behind it — and the
      // hover state rides along: as React swaps the window's marks, the mark
      // that lands under the still pointer fires its own mouseenter, so the
      // arc and the card keep reading whatever mark is under the cursor while
      // the rail rolls.
      event.preventDefault();
      const direction = event.deltaY > 0 ? 1 : -1;
      const step = navWheelStep(event.deltaY);
      const next = navNextStart(marks.length, windowSize, startRef.current, direction * step);
      const moved = next !== startRef.current;
      if (moved) startRef.current = next;
      // A fast wheel fires several events per frame. Accumulate them and commit
      // once per animation frame: one React render, one measurement, and one
      // roll animation, instead of a render per wheel tick.
      const pending = pendingRef.current;
      pendingRef.current = { start: startRef.current, clientY: event.clientY, moved: moved || Boolean(pending?.moved), direction };
      if (frameRef.current !== null) return;
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null;
        const batch = pendingRef.current;
        pendingRef.current = null;
        if (!batch) return;
        setStart(batch.start);
        // Re-anchor the hover to the row under the pointer once per frame: the
        // browser does not reliably re-run its own hit-testing when React
        // swaps the window's marks.
        const row = navRowAt(batch.clientY, node.getBoundingClientRect().top, Math.min(windowSize, marks.length));
        if (row !== null) setActive(row);
        if (batch.moved && typeof node.animate === 'function' && !window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
          rollRef.current?.cancel();
          rollRef.current = node.animate(
            [{ transform: `translateY(calc(-50% + ${batch.direction * NAV_STEP}px))` }, { transform: 'translateY(-50%)' }],
            { duration: 150, easing: 'ease-out' }
          );
        }
      });
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      node.removeEventListener('wheel', onWheel);
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      pendingRef.current = null;
      rollRef.current?.cancel();
      rollRef.current = null;
    };
  }, [expanded, marks.length, windowSize]);

  if (marks.length < 5) return null;
  const frame = navWindow(marks.length, start, windowSize);
  const shown = expanded ? marks.slice(frame.from, frame.to) : marks.slice(-Math.min(NAV_RESTING, marks.length));
  // 展开时的全局序号基准：窗口滑动后，刻度仍数整个对话的第几条横杠。
  const ordinalBase = expanded ? frame.from : marks.length - shown.length;
  const current = expanded && active !== null && frame.from + active < marks.length ? marks[frame.from + active] : null;
  return <>
    <div
      className={`panel-nav${expanded ? ' is-expanded' : ''}`}
      ref={trackRef}
      style={expanded ? { height: navTrackHeight(shown.length) } : undefined}
      aria-label="消息导航：悬停展开，滚轮翻动，点击跳转"
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => { setExpanded(false); setActive(null); }}
      onClick={() => { if (expanded && active !== null && frame.from + active < marks.length) onJump(marks[frame.from + active].id); }}
    >
      {shown.map((mark, index) => {
        const boost = expanded && active !== null ? navBoost(Math.abs(index - active)) : 0;
        const scale = boost ? (baseWidth + boost) / baseWidth : 1;
        const ordinal = ordinalBase + index + 1;
        return <span key={mark.id} className="panel-nav-row">
          <i
            aria-hidden="true"
            className={navMarkClass(expanded, index === active)}
            style={scale !== 1 ? ({ '--nav-scale': String(scale) } as CSSProperties) : undefined}
            onMouseEnter={expanded ? () => setActive(index) : undefined}
          />
          {/* 每十根横杠标一次序号：10、20、30……数字在横杠右边，绝对定位，
              不撑高行，滚轮的行距计算不受影响。 */}
          {expanded && ordinal % 10 === 0 && <em className="panel-nav-count" aria-hidden="true">{ordinal}</em>}
        </span>;
      })}
    </div>
    {current && <div
      className="panel-nav-card"
      role="tooltip"
      style={{ top: `clamp(40px, calc(50% + ${navCardOffset(shown.length, active ?? 0)}px), calc(100% - 40px))` }}
    >
      <span className={`panel-nav-role${current.role === 'user' ? ' is-user' : ''}`}>{current.role === 'user' ? '你' : '小鲸'}</span>
      <p className="panel-nav-text">{navPreview(current.text) || '（图片消息）'}</p>
    </div>}
  </>;
}
