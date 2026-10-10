import { type CSSProperties, useEffect, useRef, useState } from 'react';
import type { TimelineGroup } from './timeline-groups';

export interface NavMark {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

/** One mark per turn — the user's line and the model's first reply — not the
 *  stream-fragmented pieces in between: those repeat within one answer and
 *  are not landmarks a reader navigates by. */
export function navMarks(groups: readonly TimelineGroup[]): NavMark[] {
  const marks: NavMark[] = [];
  for (const group of groups) {
    if (group.kind === 'single') {
      if (group.entry.kind === 'user' || group.entry.kind === 'assistant') marks.push({ id: group.entry.id, role: group.entry.kind, text: group.entry.text });
      continue;
    }
    marks.push({ id: group.user.id, role: 'user', text: group.user.text });
    const firstReply = group.items.find((entry) => entry.kind === 'assistant');
    if (firstReply) marks.push({ id: firstReply.id, role: 'assistant', text: firstReply.text });
  }
  return marks;
}

/** How many marks the expanded rail shows at once — the wheel slides this
 *  window across the whole conversation instead of stacking every mark. */
export const NAV_WINDOW = 60;
/** Row pitch of the rail: a 3.2 px mark plus a 2.4 px gap. Both are multiples
 *  of 0.8, so under 125% display scaling every row lands on a whole physical
 *  pixel — mixed rounding used to make the rows look unevenly spaced. */
export const NAV_STEP = 5.6;
/** Half the expanded rail's span — how far from centre the hover card sits
 *  when the first row is hovered. */
const NAV_HALF_SPAN = ((NAV_WINDOW - 1) / 2) * NAV_STEP;
/** The resting handle: just the newest few marks, short enough not to crowd
 *  the messages beside it. */
export const NAV_RESTING = 3;

/** The slice of marks the expanded rail shows for a given window start. */
export function navWindow(count: number, start: number): { from: number; to: number } {
  const from = Math.max(0, Math.min(Math.max(0, count - NAV_WINDOW), start));
  return { from, to: Math.min(count, from + NAV_WINDOW) };
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

/**
 * The message rail: a short handle of the newest marks at rest; hovering
 * opens a window of the newest sixty marks that the wheel slides up and down
 * the whole conversation, and clicking a mark jumps to that message. The wheel
 * is captured while hovering so the feed behind never scrolls instead.
 */
export function TimelineNav({ marks, onJump }: { marks: NavMark[]; onJump: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  const [start, setStart] = useState(() => Math.max(0, marks.length - NAV_WINDOW));
  const trackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = trackRef.current;
    if (!node || !expanded) return;
    const onWheel = (event: WheelEvent) => {
      // The wheel moves the rail's window, never the feed behind it.
      event.preventDefault();
      setActive(null);
      const direction = event.deltaY > 0 ? 1 : -1;
      setStart((current) => Math.max(0, Math.min(Math.max(0, marks.length - NAV_WINDOW), current + direction * 3)));
      // A short push-in so the wheel visibly rolls the rail. Compositor-only —
      // one transform pass, no layout or paint — and skipped entirely when the
      // system asks for reduced motion.
      if (typeof node.animate === 'function' && !window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
        node.animate(
          [{ transform: `translateY(calc(-50% + ${direction * NAV_STEP}px))` }, { transform: 'translateY(-50%)' }],
          { duration: 150, easing: 'ease-out' }
        );
      }
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [expanded, marks.length]);

  if (marks.length < 5) return null;
  const frame = navWindow(marks.length, start);
  const shown = expanded ? marks.slice(frame.from, frame.to) : marks.slice(-Math.min(NAV_RESTING, marks.length));
  const current = expanded && active !== null && frame.from + active < marks.length ? marks[frame.from + active] : null;
  return <>
    <div
      className={`panel-nav${expanded ? ' is-expanded' : ''}`}
      ref={trackRef}
      aria-label="消息导航：悬停展开，滚轮翻动，点击跳转"
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => { setExpanded(false); setActive(null); }}
      onClick={() => { if (expanded && active !== null && frame.from + active < marks.length) onJump(marks[frame.from + active].id); }}
    >
      {shown.map((mark, index) => {
        const boost = expanded && active !== null ? navBoost(Math.abs(index - active)) : 0;
        return <i
          key={mark.id}
          aria-hidden="true"
          className={`panel-nav-mark${expanded && index === active ? ' is-active' : ''}`}
          style={boost ? ({ '--nav-boost': `${boost}px` } as CSSProperties) : undefined}
          onMouseEnter={expanded ? () => setActive(index) : undefined}
        />;
      })}
    </div>
    {current && <div
      className="panel-nav-card"
      role="tooltip"
      style={{ top: `clamp(40px, calc(50% + ${(active ?? 0) * NAV_STEP - NAV_HALF_SPAN}px), calc(100% - 40px))` }}
    >
      <span className={`panel-nav-role${current.role === 'user' ? ' is-user' : ''}`}>{current.role === 'user' ? '你' : '小鲸'}</span>
      <p className="panel-nav-text">{navPreview(current.text) || '（图片消息）'}</p>
    </div>}
  </>;
}
