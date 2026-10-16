import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type AnimationEvent, type MouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { AppSnapshot, BubbleLayout, ClaudeWorkflowOption, ContextUsageSnapshot, ConversationSummary, EffortLevel, ModelMode, ModelProfile, PendingMessage, PetAPI, ProposedAction, SideChatSnapshot, TaskMetrics, TaskStatus, TimelineEntry, UserAttachment } from '../shared/contracts';
import { isImageAttachmentName } from '../shared/image-preview';
import { EFFORT_LABELS } from '../shared/effort';
import { EffortSlider } from './effort-slider';
import { EventImages } from './event-images';
import { formatSelectionQuote } from './message-quote';
import { toolLabel } from '../shared/tool-labels';
import { AttachmentPreview, previewPlacement, type PreviewPlacement } from './attachment-preview';
import { agentTasks } from './agent-tasks';
import { fileBadge, splitAttachmentNote } from './attachment-note';
import { ComposerSuggestions, detectComposerTrigger, fileMention, sessionSuggestionItems, workflowSuggestionItems, type ComposerSuggestion } from './composer-suggestions';
import { pastedFileName, pastedFiles, restoreComposerState, stashComposerState, type StashedComposer } from './composer-drafts';
import { GoalBanner } from './goal-banner';
import { MessageMarkdown, writeClipboard } from './message-markdown';
import { TabContextMenu } from './tab-context-menu';
import { TurnContextMenu } from './turn-context-menu';
import { drawerBottomOffset } from './panel-drawer';
import { groupSessionSummaries } from './session-list-groups';
import { moveTab, orderConversationTabs, quickTabLimit, showNewTabButton } from './panel-tabs';
import { TaskStrip } from './task-strip';
import { AskQuestionPanel } from './ask-question';
import { PlanApprovalPanel } from './plan-approval';
import { ThinkingItem } from './thinking-item';
import { groupTimeline, liftAsides, sameTimelineEntry, segmentTurn, splitTurnTail, tailWindow, type TurnSegment } from './timeline-groups';
import { navMarks, NAV_WINDOW_COMPACT, NAV_WINDOW_WIDE, TimelineNav } from './timeline-nav';
import { ToolDiffBody } from './tool-diff-body';
import { ToolIcon } from './tool-icons';
import { toolArgumentPreview, toolPlanText } from './tool-arguments';
import { toolDiffPreview } from './tool-diff';
import { ToolInputDetails } from './tool-input-details';
import { TurnStats } from './turn-stats';
import { WorkingIndicator } from './working-indicator';
import { TurnProcess, WorkCluster } from './work-cluster';
import { petBridge } from './pet-state';
import { VoiceManager } from './voice-manager';
import './panel.css';

const taskLabels: Record<TaskStatus, string> = {
  idle: '待命',
  planning: '整理任务',
  awaiting_approval: '需要回复',
  executing: '正在执行',
  verifying: '验证结果',
  done: '已完成',
  failed: '执行失败',
  cancelled: '已停止',
};

const MAIN_ONLY_SIDE_COMMANDS = new Set(['new', 'side', 'btw', 'sessions', 'model', 'help', 'goal', 'compact']);

function sideOnlySlashError(text: string): string | null {
  const name = /^\/([a-z][a-z0-9_-]*)(?=\s|$)/iu.exec(text.trim())?.[1]?.toLowerCase();
  if (!name || !MAIN_ONLY_SIDE_COMMANDS.has(name)) return null;
  return name === 'side' || name === 'btw'
    ? '当前已在临时侧聊；先收起，再从主线开启。'
    : name === 'compact' ? '请使用侧聊上下文菜单中的「压缩上下文」。'
    : `/${name} 仅适用于主线，请先收起侧聊。`;
}

const kindLabels: Record<TimelineEntry['kind'], string> = {
  user: '你',
  assistant: '小鲸',
  system: '系统',
  tool: '工具',
  thinking: '思考',
};


function PlusIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12" /></svg>;
}

function ReturnIcon() {
  // The enter/return arrow: the guide-a-queued-message action says it with a
  // key shape the way the keyboard actually does it.
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M16.5 5v5.2a2.3 2.3 0 0 1-2.3 2.3H5" /><path d="m8.2 9.3-3.2 3.2 3.2 3.2" /></svg>;
}

function ModelIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 5h12M4 10h12M4 15h12" /><circle cx="7" cy="5" r="1.5" /><circle cx="12" cy="10" r="1.5" /><circle cx="9" cy="15" r="1.5" /></svg>;
}

function EffortIcon() {
  // The thought spark. The viewBox is trimmed to the ink (4＋4→16, stroke
  // included) so the box the layout sees is the glyph itself — a 20×20 box
  // left ~4px of inner padding on each side, which read as the whole
  // icon+label cluster sitting to the right inside its button.
  return <svg viewBox="4 4 12 12" aria-hidden="true"><path d="M10 5.2c.9 3.1 1.7 3.9 4.8 4.8-3.1.9-3.9 1.7-4.8 4.8-.9-3.1-1.7-3.9-4.8-4.8 3.1-.9 3.9-1.7 4.8-4.8Z" /></svg>;
}

function ConversationsIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 5h12M4 10h12M4 15h8" /></svg>;
}

function SelectIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3.5" y="4" width="11" height="11" rx="2" /><path d="m6.5 9.4 2.3 2.2 3.6-3.8M16.5 7v9" /></svg>;
}

function BackIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m11.8 4.5-5.5 5.5 5.5 5.5M6.8 10h9" /></svg>;
}

function EditIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 14.6 8.9-8.9 2.4 2.4-8.9 8.9-3.2.7.8-3.1ZM11.8 6.8l2.4 2.4" /></svg>;
}

function ArchiveIcon({ restore = false }: { restore?: boolean }) {
  return restore
    ? <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 7h12v9H4zM3 4h14v3H3zM7 12h6m-5-2-2 2 2 2" /></svg>
    : <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 7h12v9H4zM3 4h14v3H3zM8 11h4m-2-2v4" /></svg>;
}

function DeleteIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 5.5h11m-9 0 .6 11h5.8l.6-11M8 5.5V3.7h4v1.8M8.5 8.5v5m3-5v5" /></svg>;
}

function PinIcon({ pinned }: { pinned: boolean }) {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 3.5h6l-.7 4 2.7 2.7v1.3H5v-1.3l2.7-2.7-.7-4ZM10 11.5v5" />{pinned && <path d="M4.5 15.5 15.5 4.5" />}</svg>;
}

function ContextMeter({ usage, compacting, open, onToggle }: {
  usage?: ContextUsageSnapshot; compacting?: boolean; open: boolean; onToggle: () => void
}) {
  const available = usage?.status === 'available' && Number.isFinite(usage.usedPercent);
  const used = available ? Math.max(0, Math.min(100, Math.round(usage.usedPercent!))) : 0;
  return <button type="button" className={`panel-context-meter${available ? ' is-known' : ''}${compacting ? ' is-compacting' : ''}${used >= 70 ? ' is-high' : ''}`} aria-label="上下文" aria-haspopup="dialog" aria-expanded={open} title={compacting ? '正在压缩…' : available ? `上下文已用 ${used}%` : '用量暂不可读取'} onClick={onToggle}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><circle className="panel-context-track" cx="12" cy="12" r="9" /><circle className="panel-context-progress" cx="12" cy="12" r="9" pathLength="100" strokeDasharray={`${used} 100`} /></svg>
  </button>;
}

interface DroppedAttachment extends UserAttachment { id: string }

/** A rejected submission goes back to the conversation it came from. Keep
 * anything the owner typed or dropped while the IPC request was in flight. */
function mergeComposerDraft(submitted: string, current: string): string {
  if (!submitted) return current;
  if (!current) return submitted;
  return `${submitted.trimEnd()}\n\n${current}`;
}

function mergeComposerAttachments(submitted: DroppedAttachment[], current: DroppedAttachment[]): DroppedAttachment[] {
  const merged = [...submitted];
  for (const item of current) {
    if (!merged.some((existing) => existing.id === item.id ||
      (existing.name === item.name && existing.path === item.path && existing.content === item.content))) merged.push(item);
  }
  return merged;
}

const noopOpenImage = (): void => {};

/** A tool past this mark gets a kill switch in its row. */
const KILL_AFTER_MS = 60_000;
/** Stable identity for an absent timeline so the grouping memos below survive
 *  re-renders that don't touch the timeline at all. */
const EMPTY_TIMELINE: TimelineEntry[] = [];
/** The feed renders only its tail by default; scrolling to the top extends
 *  the window by whole turns, so a five-thousand-entry history stops costing
 *  a five-thousand-node DOM on every open. */
const EARLIER_MIN_ENTRIES = 240;
const EARLIER_STEP_GROUPS = 6;


function timeText(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.valueOf()) ? iso : parsed.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

/** "10-13 12:30" — short, absolute, the way a row's info line reads it. */
function stampText(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.valueOf())) return '—';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

const modeLabels: Record<ModelMode, string> = { demo: '演示模式', live: 'DeepSeek 直连', claude_code: 'Claude Code + DeepSeek' };

/** First line of a user message, trimmed for the turn menu's title. */
function turnMenuTitle(entry: TimelineEntry): string {
  const line = entry.text.replace(/\s+/g, ' ').trim();
  return line.length > 28 ? `${line.slice(0, 28)}…` : line || '这一轮对话';
}

/** Terminal colour codes (CSI/OSC escape sequences) leak into tool output
 *  verbatim — vitest paints its summary red and green. The row shows text,
 *  not a terminal, so strip them at display time. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)?)/g, '');
}

/** One message's body: attachment pictures, else the text — markdown for the
 *  model's own words and for the user's (where single newlines stay hard
 *  breaks, line for line what was typed), plain paragraphs for the rest.
 *  Shared by the standalone rows and by the list-like pieces of a split
 *  reply. */
function MessageBody({ entry, running = false, onOpenImage }: { entry: TimelineEntry; running?: boolean; onOpenImage?: (name: string, url: string) => void }) {
  const attachmentNote = entry.kind === 'user' ? splitAttachmentNote(entry.text) : null;
  return <>
    {attachmentNote
      ? <EventImages note={attachmentNote} prompt={attachmentNote.prompt} images={entry.images} onOpen={onOpenImage ?? noopOpenImage} />
      : entry.kind === 'assistant' ? <MessageMarkdown text={entry.text} streaming={running} />
      : entry.kind === 'user' ? <MessageMarkdown text={entry.text} breaks />
      : <p>{entry.text}</p>}
  </>;
}

/** One piece of a split reply: a list-like paragraph whose dot is its own
 *  pseudo-element, so the alignment can never drift again. */
const RunParagraph = memo(function RunParagraph({ entry, onOpenImage }: { entry: TimelineEntry; onOpenImage?: (name: string, url: string) => void }) {
  return <div className="panel-run-item"><MessageBody entry={entry} onOpenImage={onOpenImage} /></div>;
});

export const TimelineItem = memo(function TimelineItem({ entry, running = false, onOpenImage, onAvatarMenu, display }: { entry: TimelineEntry; running?: boolean; onOpenImage?: (name: string, url: string) => void; onAvatarMenu?: (event: MouseEvent<HTMLElement>) => void; display: RowDisplay }) {
  const timeLabel = timeText(entry.time);
  const toolPreview = entry.kind === 'tool' ? (entry.text.trim().split(/\r?\n/, 1)[0] || '工具活动') : '';
  const legacyToolDetail = entry.kind === 'tool' ? entry.text.trim().split(/\r?\n/).slice(1).join('\n').trim() : '';
  const toolName = entry.kind === 'tool' ? (entry.tool?.name ?? toolPreview.split(' · ')[0].split('（')[0]) : '';
  // The line diff is an LCS over the edit's strings: recompute it only when the
  // edit itself changes, not on every streaming frame that re-renders this row.
  const toolDiff = useMemo(
    () => entry.kind === 'tool' ? toolDiffPreview(toolName, entry.tool?.input) : null,
    [entry.kind, toolName, entry.tool?.input]);
  // A tool that has been running past the minute mark can be killed from its
  // own row. One timeout for the remainder of that minute: the switch arrives
  // exactly at the mark, and a row that remounts for any reason just schedules
  // a fresh timeout for whatever is left — toggling the row can neither
  // summon the switch early nor keep it away.
  const [killable, setKillable] = useState(false);
  useEffect(() => {
    if (entry.kind !== 'tool' || !running || entry.tool?.status !== 'running') { setKillable(false); return; }
    const started = Date.parse(entry.time);
    if (!Number.isFinite(started)) return;
    const remaining = KILL_AFTER_MS - (Date.now() - started);
    if (remaining <= 0) { setKillable(true); return; }
    const timer = window.setTimeout(() => setKillable(true), remaining);
    return () => window.clearTimeout(timer);
  }, [entry.kind, entry.time, entry.tool?.status, running]);
  // The card body (diff preview, long output) mounts on first expand only.
  const [toolOpened, setToolOpened] = useState(false);
  if (entry.kind === 'tool') {
    const status = entry.tool?.status ?? 'done';
    const name = entry.tool?.name ?? toolPreview.split(' · ')[0].split('（')[0];
    const label = toolLabel(name);
    const argument = toolArgumentPreview(entry.tool?.input);
    const diff = toolDiff;
    // A plan lives in the call's input; its output is only "approved". Showing
    // the plan itself is the whole point of plan mode.
    const plan = toolPlanText(name, entry.tool?.input);
    const detail = entry.tool?.output?.trim() ? entry.tool.output : legacyToolDetail;
    // A failed edit never touched the file, so the error is the only honest body
    // to show; a successful one answers "what actually changed" with its lines.
    const body = plan
      ? <pre className="panel-tool-output panel-tool-plan">{plan}</pre>
      : diff && status !== 'error'
      ? <ToolDiffBody preview={diff} />
      : detail ? <pre className="panel-tool-output">{stripAnsi(detail)}</pre>
      : <div className="panel-tool-empty">{status === 'running' ? '正在运行…' : '没有输出'}</div>;
    return <details className={`panel-tool-activity${status === 'running' ? ' is-running' : ''}`}
      onToggle={(event) => { if (event.currentTarget.open) setToolOpened(true); }}>
      <summary aria-label={`${label}${argument ? ` ${argument}` : ''}${diff ? `，新增 ${diff.added} 行，删除 ${diff.removed} 行` : ''}，${status === 'error' ? '失败' : status === 'running' ? '执行中' : '已完成'}`}>
        <ToolIcon name={name} />
        <code className={status === 'running' ? 'panel-live-label' : undefined}>{label}</code>
        {argument && <span className="panel-tool-argument">{argument}</span>}
        {diff && <span className="panel-tool-diff" aria-hidden="true">
          <span className="panel-tool-diff-add">+{diff.added}</span>
          {diff.removed > 0 && <span className="panel-tool-diff-del">−{diff.removed}</span>}
        </span>}
        <span className={`panel-tool-result is-${status}`} aria-hidden="true">{status === 'error' ? '×' : status === 'running' ? '…' : '✓'}</span>
        {killable && <button type="button" className="panel-tool-kill" aria-label="中断当前任务" title="中断当前任务"
          onClick={(event) => { event.preventDefault(); event.stopPropagation(); void petBridge().interruptTurn(); }}>×</button>}
      </summary>
      {toolOpened && body}
      {toolOpened && <ToolInputDetails input={entry.tool?.input} />}
    </details>;
  }
  if (entry.kind === 'system') {
    // A notice has no speaker: no glyph, no clock — the hairlines and the
    // centered, muted line set it apart from the dialogue instead.
    return <article className="panel-event panel-event-system" aria-label={kindLabels.system}>
      <div className="panel-event-body"><p>{entry.text}</p></div>
    </article>;
  }
  return (
    <article className={`panel-event panel-event-${entry.kind}`} data-entry-id={entry.id} aria-label={`${kindLabels[entry.kind]}，${timeLabel}`}>
      <div className="panel-event-avatar" aria-hidden="true" onContextMenu={onAvatarMenu}>
        {entry.kind === 'user' || entry.kind === 'assistant'
          ? <AvatarGlyph kind={entry.kind} fallback={entry.kind === 'user' ? '你' : '鲸'}
              name={entry.kind === 'user' ? display.avatars.user : display.avatars.assistant} />
          : <span className="panel-event-glyph">系</span>}
        {display.showTimestamps && <time className="panel-event-time" dateTime={entry.time}>{timeLabel}</time>}
      </div>
      <div className="panel-event-body"><MessageBody entry={entry} running={running} onOpenImage={onOpenImage} /></div>
    </article>
  );
}, (prev, next) => prev.running === next.running && sameTimelineEntry(prev.entry, next.entry) &&
  prev.display.showTimestamps === next.display.showTimestamps &&
  (prev.display.avatars.user ?? null) === (next.display.avatars.user ?? null) &&
  (prev.display.avatars.assistant ?? null) === (next.display.avatars.assistant ?? null));


/** The display preferences a row needs beyond its entry itself. */
interface RowDisplay {
  showTimestamps: boolean
  avatars: { user: string | null; assistant: string | null }
}

/** Thinking entries get their own expandable row; everything else keeps the message layout. */
function EntryItem({ entry, running, onOpenImage, display }: { entry: TimelineEntry; running: boolean; onOpenImage?: (name: string, url: string) => void; display: RowDisplay }) {
  return entry.kind === 'thinking'
    ? <ThinkingItem entry={entry} running={running} />
    : <TimelineItem entry={entry} running={running} onOpenImage={onOpenImage} display={display} />;
}

/** Data URLs per avatar file name — a new upload gets a new name, so entries
 *  never go stale. */
const avatarCache = new Map<string, string | null>();

function AvatarGlyph({ kind, name, fallback }: { kind: 'user' | 'assistant'; name: string | null; fallback: string }) {
  const [url, setUrl] = useState<string | null>(() => name ? avatarCache.get(name) ?? null : null);
  useEffect(() => {
    if (!name) { setUrl(null); return; }
    let cancelled = false;
    void petBridge().readAvatar(kind).then((data) => {
      avatarCache.set(name, data);
      if (!cancelled) setUrl(data);
    }).catch(() => { if (!cancelled) setUrl(null); });
    return () => { cancelled = true; };
  }, [kind, name]);
  return url
    ? <img className="panel-avatar-img" src={url} alt="" />
    : <span className="panel-event-glyph">{fallback}</span>;
}

/** Module scope on purpose: a work cluster re-renders only when this identity is stable.
 *  The image viewer callback rides a ref so that identity survives. */
const openImageViewerRef: { current?: (name: string, url: string) => void } = {};

function ApprovalCard({ proposal, busy, onApprove, onReject }: {
  proposal: ProposedAction;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const note = proposal.tool === 'write_test_note';
  const riskLabel = proposal.risk === 'execute' ? '命令' : proposal.risk === 'read' ? '读取' : '写入';
  return (
    <section className="panel-approval" aria-labelledby="approval-heading">
      <div className="panel-approval-heading">
        <span className="panel-approval-symbol" aria-hidden="true">!</span>
        <div>
          <span className="panel-eyebrow">需要你的决定</span>
          <h3 id="approval-heading">{note ? '批准后才会写入文件' : '允许这一步电脑操作？'}</h3>
        </div>
        <span className="panel-risk">{riskLabel}</span>
      </div>
      <p className="panel-approval-description">{proposal.description}</p>
      <dl className="panel-approval-detail">
        <div><dt>操作</dt><dd>{note ? '写入测试笔记' : 'Claude Code 工具请求'}</dd></div>
        <div><dt>目标</dt><dd className="panel-path">{proposal.target}</dd></div>
      </dl>
      <div className="panel-preview-label">{note ? '将写入的内容' : '完整参数'}</div>
      <pre className="panel-preview">{proposal.content}</pre>
      <div className="panel-approval-actions">
        <button type="button" className="panel-button panel-button-quiet" onClick={onReject} disabled={busy}>拒绝</button>
        <button type="button" className="panel-button panel-button-primary" onClick={onApprove} disabled={busy}>{busy ? '处理中…' : note ? '批准写入' : '允许一次'}</button>
      </div>
    </section>
  );
}

/** One line at 13px × 1.45 plus the 4px of padding — the floor the editor may
 *  never go under, so the placeholder is always whole. */
export const EDITOR_ONE_LINE = 23;
/** Eight lines, then the editor scrolls. */
export const EDITOR_MAX_HEIGHT = 155;

/** Keeps a measured height sane: never a sliver (a zero-height pass squeezed
 *  the placeholder out and the box then stayed collapsed), never past eight
 *  lines. */
export function clampEditorHeight(measured: number): number {
  return Math.min(EDITOR_MAX_HEIGHT, Math.max(EDITOR_ONE_LINE, measured));
}

/** The editor's content height, or null when the measurement means nothing —
 *  a hidden panel or a zero-width pass reports 0, and writing that back froze
 *  the composer at a sliver until something else happened to re-measure it. */
function fitEditorHeight(editor: HTMLTextAreaElement): number | null {
  if (editor.clientWidth === 0) return null;
  editor.style.height = 'auto';
  const nextHeight = clampEditorHeight(editor.scrollHeight);
  editor.style.height = `${nextHeight}px`;
  return nextHeight;
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function prepareFileAttachment(bridge: PetAPI, file: File): Promise<UserAttachment> {
  const filePath = bridge.getPathForFile(file);
  if (filePath) return bridge.prepareDroppedFile(filePath);
  if (file.size > 5 * 1024 * 1024) throw new Error('粘贴的文件不能超过 5 MB。');
  return bridge.preparePastedFile({ name: pastedFileName(file), data: await fileToBase64(file) });
}

interface PanelBubbleProps {
  visible: boolean;
  snapshot: AppSnapshot | null;
  error: string | null;
  run: (action: (bridge: PetAPI) => Promise<void>) => Promise<boolean>;
}

/** Runs a box's exit animation. `closing` stays true from beginClose until the
 *  element's own animationend or a backstop timer (a timer is all a
 *  reduced-motion environment leaves us with, where the animation never
 *  fires); the element stays mounted while it is true. */
function useExitAnimation(durationMs: number) {
  const [closing, setClosing] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const beginClose = useCallback(() => {
    setClosing(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setClosing(false), durationMs + 80);
  }, [durationMs]);
  const endClose = useCallback((event: AnimationEvent<HTMLElement>) => {
    if (event.target === event.currentTarget) setClosing(false);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return { closing, beginClose, endClose };
}

/** Stable empty arrangement for the `?? []` fallback: a fresh array on every
 *  render would defeat the memo comparisons downstream. */
const EMPTY_TAB_ORDER: string[] = [];

export function PanelBubble({ visible, snapshot: mainSnapshot, error, run }: PanelBubbleProps) {
  const [sideChat, setSideChat] = useState<SideChatSnapshot | null>(null);
  const sideSessionId = sideChat?.parentConversationId === (mainSnapshot?.conversationLibrary?.activeConversationId ?? null)
    ? sideChat?.sessionId ?? null : null;
  const sideExpanded = Boolean(sideSessionId && sideChat?.expanded && sideChat.snapshot);
  const snapshot = sideExpanded ? sideChat!.snapshot : mainSnapshot;
  const sideChatRef = useRef<SideChatSnapshot | null>(null);
  const sideSnapshots = useRef(new Map<string, SideChatSnapshot>());
  const destinationRef = useRef<'main' | 'side'>('main');
  const sideComposerStash = useRef(new Map<string, StashedComposer<DroppedAttachment>>());
  const mainComposerOpenRef = useRef(false);
  const sideComposerOpenRef = useRef(new Map<string, boolean>());
  const applySideSnapshotRef = useRef<(next: SideChatSnapshot) => void>(() => undefined);
  const sideSubmitLockRef = useRef(new Set<string>());
  const [sideSendingIds, setSideSendingIds] = useState<Set<string>>(() => new Set());
  const [expanded, setExpanded] = useState(false);
  const [bubbleWidth, setBubbleWidth] = useState(0);
  const resizePending = useRef(false);
  const drawerExit = useExitAnimation(190);
  const [libraryOpen, setLibraryOpenRaw] = useState(false);
  // The 534px expanded bubble can hold a 190px library and a 320px chat.
  // Smaller displays keep the overlay drawer so the composer remains usable.
  // Date headings ("今天/昨天/更早") only pay off in the wide shape. The drawer
  // itself is always a floating pane over the bubble — never a column that
  // squeezes the conversation beside it.
  const libraryGrouped = expanded && bubbleWidth >= 510 && (libraryOpen || drawerExit.closing);
  // Closing plays the drawer's exit animation first: the raw setter flips the
  // state, the wrapper starts the animation that keeps the drawer mounted
  // until it has slid away.
  function setLibraryOpen(open: boolean) {
    if (!open) {
      drawerExit.beginClose();
      setMultiSelect(false);
      setSelectedSessionIds(new Set());
      setBatchDeleteConfirm(false);
    }
    setLibraryOpenRaw(open);
  }
  // The drawer's distance from the workspace's bottom edge — the composer
  // dock's height at this moment; live values arrive from the dock observer.
  const [drawerBottom, setDrawerBottom] = useState<number | null>(null);
  const [libraryArchived, setLibraryArchived] = useState(false);
  const [libraryQuery, setLibraryQuery] = useState('');
  const [librarySearch, setLibrarySearch] = useState<{
    key: string; status: 'idle' | 'loading' | 'done' | 'error'; results: ConversationSummary[];
  }>({ key: '', status: 'idle', results: [] });
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [multiSelect, setMultiSelect] = useState(false);
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(() => new Set());
  const [batchDeleteConfirm, setBatchDeleteConfirm] = useState(false);
  const multiSelectRef = useRef(multiSelect);
  multiSelectRef.current = multiSelect;
  const batchDeleteConfirmRef = useRef(batchDeleteConfirm);
  batchDeleteConfirmRef.current = batchDeleteConfirm;
  const [compactBusy, setCompactBusy] = useState(false);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [tabMenu, setTabMenu] = useState<{ item: ConversationSummary; container: HTMLElement; x: number; y: number } | null>(null);
  const [turnMenu, setTurnMenu] = useState<{ turnUserId: string; title: string; running: boolean; container: HTMLElement; x: number; y: number } | null>(null);
  const [draft, setDraft] = useState('');
  const [caretIndex, setCaretIndex] = useState(0);
  const [suggestionItems, setSuggestionItems] = useState<ComposerSuggestion[]>([]);
  const [suggestionSelected, setSuggestionSelected] = useState(0);
  const [suggestionLoading, setSuggestionLoading] = useState(false);
  const [suggestionFailed, setSuggestionFailed] = useState(false);
  const [dismissedSuggestion, setDismissedSuggestion] = useState<string | null>(null);
  const [busy, setBusy] = useState<'approve' | 'reject' | 'stop' | null>(null);
  const [sendingConversationIds, setSendingConversationIds] = useState<Set<string | null>>(() => new Set());
  const composerExit = useExitAnimation(150);
  const [composerOpen, setComposerOpenRaw] = useState(false);
  function setComposerOpen(open: boolean) {
    if (!open) composerExit.beginClose();
    if (destinationRef.current === 'side') {
      const id = sideChatRef.current?.sessionId;
      if (id) sideComposerOpenRef.current.set(id, open);
    }
    else mainComposerOpenRef.current = open;
    setComposerOpenRaw(open);
  }
  // One-line fallback until fitEditorHeight measures the editor; the same
  // floor clampEditorHeight enforces, so a failed measurement can never
  // shrink the box below a readable line.
  const [composerHeight, setComposerHeight] = useState(EDITOR_ONE_LINE);
  const [attachments, setAttachments] = useState<DroppedAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  // Hover previews of image chips: data URLs land here keyed by file path, so a
  // second hover (or a conversation switch and back) never re-reads the disk.
  const [attachmentPreviews, setAttachmentPreviews] = useState<Record<string, string>>({});
  const [previewCard, setPreviewCard] = useState<{ path: string; name: string; placement: PreviewPlacement } | null>(null);
  const requestedPreviews = useRef(new Set<string>());
  const composerRef = useRef<HTMLFormElement>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const measure = () => setBubbleWidth(workspace.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, [expanded]);
  const composeDockRef = useRef<HTMLDivElement>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [effortMenuOpen, setEffortMenuOpen] = useState(false);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [goalPrompting, setGoalPrompting] = useState(false);
  const [imageViewer, setImageViewer] = useState<{ name: string; url: string } | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [feedAtBottom, setFeedAtBottom] = useState(true);
  const feedRef = useRef<HTMLDivElement>(null);
  const sessionHeaderRef = useRef<HTMLElement>(null);
  const quickTabsRef = useRef<HTMLElement>(null);
  // The tab drag: `tabDragOrder` is the live preview arrangement while a
  // pointer carries a tab around; the drop commits it and the store's own
  // `tabOrder` takes over.
  const [tabDragOrder, setTabDragOrder] = useState<string[] | null>(null);
  const tabDragRef = useRef<{ id: string; startX: number; moved: boolean } | null>(null);
  const tabClickSuppressRef = useRef(false);
  const followFeedRef = useRef(true);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const feedWrapRef = useRef<HTMLDivElement>(null);
  const openImageViewer = useCallback((name: string, url: string) => setImageViewer({ name, url }), []);
  openImageViewerRef.current = openImageViewer;
  const [quoteSelection, setQuoteSelection] = useState<{ text: string; x: number; y: number } | null>(null);
  const composerStash = useRef(new Map<string, StashedComposer<DroppedAttachment>>());
  const goalPromptStash = useRef(new Map<string, boolean>());
  const composerStateRef = useRef({ draft, attachments });
  composerStateRef.current = { draft, attachments };
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const effortMenuRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const composeTriggerRef = useRef<HTMLButtonElement>(null);
  const voiceManagerRef = useRef<VoiceManager | null>(null);
  const submitLockRef = useRef<Set<string | null>>(new Set());
  const workflowCacheRef = useRef<ClaudeWorkflowOption[] | null>(null);
  const pendingNewConversationRef = useRef(false);
  const library = mainSnapshot?.conversationLibrary;
  const activeConversationIdRef = useRef<string | null>(library?.activeConversationId ?? null);
  function sideSessionExists(sessionId: string): boolean {
    return [...sideSnapshots.current.values()].some((item) => item.sessionId === sessionId);
  }
  function forgetSideSession(sessionId: string | null | undefined): void {
    if (!sessionId) return;
    sideComposerStash.current.delete(sessionId);
    sideComposerOpenRef.current.delete(sessionId);
  }
  function forgetParentSide(parentId: string): void {
    const saved = sideSnapshots.current.get(parentId);
    if (!saved) return;
    if (activeConversationIdRef.current === parentId) {
      applySideSnapshotRef.current({ sessionId: null, parentConversationId: parentId, expanded: false,
        queuePaused: false, snapshot: null, pendingMessages: [] });
    }
    sideSnapshots.current.delete(parentId);
    forgetSideSession(saved.sessionId);
  }
  function rememberVisibleSide(): void {
    if (destinationRef.current !== 'side') return;
    const sessionId = sideChatRef.current?.sessionId;
    if (!sessionId || !sideSessionExists(sessionId)) return;
    const current = composerStateRef.current;
    stashComposerState(sideComposerStash.current, sessionId, current.draft, current.attachments);
    sideComposerOpenRef.current.set(sessionId, composerOpen);
  }
  useLayoutEffect(() => {
    const nextId = library?.activeConversationId ?? null;
    const previousId = activeConversationIdRef.current;
    if (library) {
      const valid = new Set(library.conversations.filter((item) => item.archivedAt === null).map((item) => item.id));
      for (const [parentId, saved] of sideSnapshots.current) {
        if (valid.has(parentId)) continue;
        sideSnapshots.current.delete(parentId);
        forgetSideSession(saved.sessionId);
      }
    }
    if (previousId !== nextId) {
      rememberVisibleSide();
      const carryNewDraft = pendingNewConversationRef.current && previousId === null && nextId !== null && destinationRef.current === 'main';
      if (destinationRef.current === 'main' && previousId) {
        if (library?.conversations.some((item) => item.id === previousId)) {
          const current = composerStateRef.current;
          stashComposerState(composerStash.current, previousId, current.draft, current.attachments);
          flushDraft(previousId, current.draft);
          goalPromptStash.current.set(previousId, goalPrompting);
        } else {
          composerStash.current.delete(previousId);
          goalPromptStash.current.delete(previousId);
        }
      }
      activeConversationIdRef.current = nextId;
      destinationRef.current = 'main';
      sideChatRef.current = null;
      setSideChat(null);
      if (carryNewDraft) {
        stashComposerState(composerStash.current, nextId, composerStateRef.current.draft, composerStateRef.current.attachments);
      } else {
        const restored = restoreComposerState(composerStash.current, nextId);
        composerStateRef.current = restored;
        setDraft(restored.draft);
        setAttachments(restored.attachments);
        setCaretIndex(restored.draft.length);
        const goalDraftOpen = Boolean(nextId && goalPromptStash.current.get(nextId));
        setGoalPrompting(goalDraftOpen);
        mainComposerOpenRef.current = Boolean(restored.draft || restored.attachments.length || goalDraftOpen);
        setComposerOpenRaw(mainComposerOpenRef.current);
      }
      setAttachmentError(null);
      setDismissedSuggestion(null);
      setModelPickerOpen(false);
      setEffortMenuOpen(false);
      setContextMenuOpen(false);
      pendingNewConversationRef.current = false;
      draftRestoredRef.current = false;
      const targetSide = nextId ? sideSnapshots.current.get(nextId) : null;
      if (targetSide) applySideSnapshotRef.current(targetSide);
      return;
    }
  }, [library?.activeConversationId, library?.conversations]);
  applySideSnapshotRef.current = (next) => {
    const parentId = next.parentConversationId;
    if (!parentId) return;
    if (library && !library.conversations.some((item) => item.id === parentId && item.archivedAt === null)) return;
    const saved = sideSnapshots.current.get(parentId);
    if (next.sessionId && saved?.sessionId === next.sessionId && next.snapshot &&
        saved.snapshot && next.snapshot.timelineRevision < saved.snapshot.timelineRevision) return;
    if (saved?.sessionId && saved.sessionId !== next.sessionId) forgetSideSession(saved.sessionId);
    sideSnapshots.current.set(parentId, next);
    if (parentId !== activeConversationIdRef.current) return;
    const previousSide = sideChatRef.current;
    const nextDestination = next.sessionId && next.expanded && next.snapshot &&
      next.parentConversationId === activeConversationIdRef.current ? 'side' : 'main';
    const previousDestination = destinationRef.current;
    sideChatRef.current = next;
    if (nextDestination !== previousDestination ||
        (nextDestination === 'side' && previousSide?.sessionId !== next.sessionId)) {
      const current = composerStateRef.current;
      if (previousDestination === 'side' && previousSide?.sessionId &&
          previousSide.sessionId === next.sessionId) {
        stashComposerState(sideComposerStash.current, previousSide.sessionId, current.draft, current.attachments);
      } else {
        if (previousDestination === 'main') {
          const id = activeConversationIdRef.current;
          stashComposerState(composerStash.current, id, current.draft, current.attachments);
          flushDraft(id, current.draft);
          if (id) goalPromptStash.current.set(id, goalPrompting);
        }
      }
      const restored = nextDestination === 'side'
        ? restoreComposerState(sideComposerStash.current, next.sessionId)
        : restoreComposerState(composerStash.current, activeConversationIdRef.current);
      composerStateRef.current = { draft: restored.draft, attachments: [...restored.attachments] };
      setDraft(restored.draft);
      setAttachments([...restored.attachments]);
      setCaretIndex(restored.draft.length);
      setAttachmentError(null);
      setDismissedSuggestion(null);
      setModelPickerOpen(false);
      setEffortMenuOpen(false);
      setContextMenuOpen(false);
      setGoalPrompting(nextDestination === 'main' && Boolean(goalPromptStash.current.get(activeConversationIdRef.current ?? '')));
      setComposerOpenRaw(nextDestination === 'side'
        ? sideComposerOpenRef.current.get(next.sessionId!) ?? true : mainComposerOpenRef.current);
      destinationRef.current = nextDestination;
    }
    setSideChat(next);
  };
  useEffect(() => {
    let mounted = true;
    let sawEvent = false;
    let bridge: PetAPI;
    try { bridge = petBridge(); } catch { return; }
    if (typeof bridge.onSideChatSnapshot !== 'function' || typeof bridge.getSideChat !== 'function') return;
    const unsubscribe = bridge.onSideChatSnapshot((next) => {
      if (!mounted) return;
      sawEvent = true;
      applySideSnapshotRef.current(next);
    });
    void bridge.getSideChat().then((next) => {
      if (mounted && !sawEvent) applySideSnapshotRef.current(next);
    }).catch(() => undefined);
    return () => { mounted = false; unsubscribe(); };
  }, []);
  const rowDisplay: RowDisplay = {
    showTimestamps: library?.settings.showMessageTimestamps ?? true,
    avatars: { user: library?.settings.userAvatar ?? null, assistant: library?.settings.assistantAvatar ?? null }
  };
  // Stable while the display settings are unchanged — that is what keeps the
  // memoized clusters from re-rendering on every stream tick. The image
  // viewer callback rides a ref for the same reason.
  const renderEntry = useCallback(
    (entry: TimelineEntry, running: boolean) => (
      <EntryItem entry={entry} running={running} onOpenImage={openImageViewerRef.current} display={rowDisplay} />
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rowDisplay.showTimestamps, rowDisplay.avatars.user, rowDisplay.avatars.assistant]
  );
  // The progress sentences inside a folded turn render the same way they do
  // outside one — the same RunParagraph rows, from a ref-stable callback.
  const renderNote = useCallback(
    (entry: TimelineEntry) => <RunParagraph entry={entry} onOpenImage={openImageViewerRef.current} />,
    []
  );
  const libraryRevision = JSON.stringify(library?.conversations.map((item) => [
    item.id, item.title, item.archivedAt, item.pinnedAt, item.updatedAt, item.messageCount
  ]) ?? []);
  const librarySearchKey = JSON.stringify([libraryQuery.trim(), libraryArchived, libraryRevision]);
  const sendingCurrent = sideExpanded ? sideSendingIds.has(sideSessionId!) : sendingConversationIds.has(library?.activeConversationId ?? null);
  const contextUsage = snapshot?.contextUsage;
  const contextCompacting = compactBusy || Boolean(snapshot?.contextCompacting);
  const recentSessions = (library?.conversations ?? []).filter((item) => !item.archivedAt);
  const tabLimit = quickTabLimit(library?.settings.visibleConversationTabs);
  // While a drag is in flight the preview order wins, so the tab under the
  // pointer sits where the user has carried it; the drop commits the order.
  const orderedSessions = orderConversationTabs(recentSessions, tabDragOrder ?? library?.settings.tabOrder ?? EMPTY_TAB_ORDER);
  const orderedSessionsRef = useRef(orderedSessions);
  orderedSessionsRef.current = orderedSessions;
  const tabDragOrderRef = useRef(tabDragOrder);
  tabDragOrderRef.current = tabDragOrder;
  const quickTabs = orderedSessions.slice(0, tabLimit);
  const selectedSession = recentSessions.find((item) => item.id === library?.activeConversationId);
  if (selectedSession && !quickTabs.some((item) => item.id === selectedSession.id)) quickTabs.splice(Math.max(0, tabLimit - 1), 1, selectedSession);
  const suggestionTrigger = detectComposerTrigger(draft, caretIndex);
  const suggestionKey = suggestionTrigger ? `${suggestionTrigger.kind}:${suggestionTrigger.start}:${suggestionTrigger.query}` : null;
  const suggestionOpen = Boolean(suggestionKey && suggestionKey !== dismissedSuggestion && composerOpen);
  function refreshContextUsage(): void {
    try {
      const bridge = petBridge();
      void (sideExpanded && sideSessionId
        ? bridge.getSideChatContextUsage(sideSessionId)
        : bridge.getContextUsage()).catch(() => undefined);
    } catch {
      // The static HTML preview has no desktop bridge.
    }
  }

  useEffect(() => {
    let bridge: PetAPI;
    try { bridge = petBridge(); } catch { return; }
    return bridge.onSlashUiAction((action) => {
      setSessionMenuOpen(false);
      if (action === 'sessions') {
        setLibraryOpen(true);
        setModelPickerOpen(false);
        setLibraryError(null);
      } else if (action === 'model') {
        setLibraryOpen(false);
        setComposerOpen(true);
        setModelPickerOpen(true);
      } else {
        setLibraryOpen(false);
        setComposerOpen(true);
        setModelPickerOpen(false);
        workflowCacheRef.current = null;
        setDismissedSuggestion(null);
        setDraft('/');
        setCaretIndex(1);
        requestAnimationFrame(() => {
          editorRef.current?.focus();
          editorRef.current?.setSelectionRange(1, 1);
        });
      }
    });
  }, []);

  useEffect(() => {
    if (!suggestionOpen || (suggestionTrigger?.kind !== 'workflow' && suggestionTrigger?.kind !== 'skill')) workflowCacheRef.current = null;
  }, [suggestionOpen, suggestionTrigger?.kind]);

  useEffect(() => {
    setSuggestionSelected(0);
    if (!suggestionOpen || !suggestionTrigger) {
      setSuggestionItems([]);
      setSuggestionLoading(false);
      setSuggestionFailed(false);
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    setSuggestionLoading(true);
    setSuggestionFailed(false);
    let bridge: PetAPI;
    try {
      bridge = petBridge();
    } catch {
      setSuggestionLoading(false);
      setSuggestionItems([]);
      setSuggestionFailed(true);
      return;
    }
    if (suggestionTrigger.kind === 'workflow' || suggestionTrigger.kind === 'skill') {
      const fetchOptions = workflowCacheRef.current
        ? Promise.resolve(workflowCacheRef.current)
        : bridge.listClaudeWorkflows().then((options) => { workflowCacheRef.current = options; return options; });
      void fetchOptions.then((options) => {
        if (cancelled) return;
        const available = sideExpanded
          ? options.filter((option) => option.kind !== 'command' || !MAIN_ONLY_SIDE_COMMANDS.has(option.name.replace(/^\//u, '').toLowerCase()))
          : options;
        setSuggestionItems(workflowSuggestionItems(available.map((option) =>
          !sideExpanded && option.kind === 'command' && (option.name === 'side' || option.name === 'btw')
            ? { ...option, description: '填写问题后开启临时侧聊；空命令不会开启' }
            : option), suggestionTrigger));
      }).catch(() => { if (!cancelled) { setSuggestionItems([]); setSuggestionFailed(true); } }).finally(() => { if (!cancelled) setSuggestionLoading(false); });
    } else {
      const sessions = sessionSuggestionItems(library?.conversations ?? [], suggestionTrigger.query, library?.activeConversationId ?? null);
      setSuggestionItems(sessions);
      timer = window.setTimeout(() => {
        void bridge.searchWorkspaceFiles(suggestionTrigger.query).then((files) => {
          if (cancelled) return;
          const fileItems = files.slice(0, 8).map((file) => ({
            id: file.relativePath,
            label: file.name,
            detail: `${file.kind === 'directory' ? '目录' : '文件'}，${file.relativePath}`,
            insertText: fileMention(file.relativePath)
          }));
          setSuggestionItems([...sessions, ...fileItems].slice(0, 8));
        }).catch(() => { if (!cancelled) { setSuggestionItems(sessions); setSuggestionFailed(true); } }).finally(() => { if (!cancelled) setSuggestionLoading(false); });
      }, 120);
    }
    return () => { cancelled = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [suggestionKey, suggestionOpen, libraryRevision, sideExpanded]);

  useEffect(() => {
    if (!sessionMenuOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!sessionHeaderRef.current?.contains(event.target as Node)) setSessionMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSessionMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [sessionMenuOpen]);

  useEffect(() => {
    if (!modelPickerOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!modelPickerRef.current?.contains(event.target as Node)) setModelPickerOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setModelPickerOpen(false);
    };
    const closeOnWindowBlur = () => setModelPickerOpen(false);
    document.addEventListener('pointerdown', closeOnOutsideClick, true);
    document.addEventListener('keydown', closeOnEscape);
    window.addEventListener('blur', closeOnWindowBlur);
    refreshContextUsage();
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick, true);
      document.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('blur', closeOnWindowBlur);
    };
  }, [modelPickerOpen, library?.activeConversationId, snapshot?.mode, sideSessionId, sideExpanded]);

  useEffect(() => {
    if (!effortMenuOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!effortMenuRef.current?.contains(event.target as Node)) setEffortMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setEffortMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsideClick, true);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick, true);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [effortMenuOpen]);

  useEffect(() => {
    if (!imageViewer) return;
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.stopPropagation(); setImageViewer(null); }
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [imageViewer]);

  useEffect(() => {
    if (!contextMenuOpen) return;
    // The panel shows the freshest reading, the same way the model menu does.
    refreshContextUsage();
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!contextMenuRef.current?.contains(event.target as Node)) setContextMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setContextMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsideClick, true);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick, true);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [contextMenuOpen, sideSessionId, sideExpanded]);

  // The meter has to be right the moment a conversation appears, not only after a
  // turn finishes: loading a conversation resets it to "unreadable", and waiting
  // for the next reply (or opening the model picker) left it blank for minutes.
  useEffect(() => {
    if (snapshot?.mode !== 'claude_code') return;
    refreshContextUsage();
  }, [library?.activeConversationId, snapshot?.mode, sideSessionId, sideExpanded]);

  // A finished turn just changed the context: refresh the meter on its own
  // instead of waiting for someone to open the model picker.
  useEffect(() => {
    if (!snapshot?.taskMetrics?.finishedAt || snapshot?.mode !== 'claude_code') return;
    refreshContextUsage();
  }, [snapshot?.taskMetrics?.finishedAt, snapshot?.mode, sideSessionId, sideExpanded]);

  useEffect(() => {
    if (!libraryOpen || !libraryQuery.trim()) {
      setLibrarySearch((current) => current.status === 'idle' ? current : { key: '', status: 'idle', results: [] });
      return;
    }
    let cancelled = false;
    setLibrarySearch({ key: librarySearchKey, status: 'loading', results: [] });
    const timer = window.setTimeout(() => {
      try {
        void petBridge().searchConversations(libraryQuery, libraryArchived).then((results) => {
          if (!cancelled) setLibrarySearch({ key: librarySearchKey, status: 'done', results });
        }).catch(() => {
          if (!cancelled) setLibrarySearch({ key: librarySearchKey, status: 'error', results: [] });
        });
      } catch {
        if (!cancelled) setLibrarySearch({ key: librarySearchKey, status: 'error', results: [] });
      }
    }, 150);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [libraryOpen, librarySearchKey]);

  // While the library drawer is open its lower edge tracks the composer's top
  // edge: the dock's distance from the workspace's bottom is re-measured
  // whenever either box resizes, so the drawer follows the composer through
  // collapses, expansions, and every added line.
  useLayoutEffect(() => {
    if (!libraryOpen) {
      // Closing: keep the frozen offset so the exit plays where it was.
      if (!drawerExit.closing) setDrawerBottom(null);
      return;
    }
    const workspace = workspaceRef.current;
    const dock = composeDockRef.current;
    if (!workspace || !dock) return;
    const measure = () => setDrawerBottom(drawerBottomOffset(workspace.getBoundingClientRect().bottom, dock.getBoundingClientRect().top));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(workspace);
    observer.observe(dock);
    return () => observer.disconnect();
  }, [libraryOpen, drawerExit.closing]);

  useEffect(() => {
    if (!voiceError) return
    const timer = window.setTimeout(() => setVoiceError(null), 4000)
    return () => window.clearTimeout(timer)
  }, [voiceError])

  useEffect(() => {
    if (!visible) {
      setComposerOpen(false);
      setModelPickerOpen(false);
      setSessionMenuOpen(false);
      setTabMenu(null);
      setLibraryOpen(false);
      voiceManagerRef.current?.stop();
    }
  }, [visible]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const bridge = petBridge();
        const voiceConfig = await bridge.getVoiceConfig();
        if (!active) return;
        const manager = new VoiceManager(bridge, {
          onPhaseChange: () => undefined,
          onPartial: () => undefined,
          onFinal: () => undefined,
          onError: (message) => { if (active) setVoiceError(message); },
          onRequestText: async (text) => {
            if (!active) return;
            const sideId = destinationRef.current === 'side' ? sideChatRef.current?.sessionId : null;
            if (sideId) await bridge.sendSideChatMessage(sideId, text);
            else await bridge.sendMessage(text);
          },
        }, voiceConfig);
        voiceManagerRef.current = manager;
      } catch {
        // ignore
      }
    })();
    return () => {
      active = false;
      voiceManagerRef.current?.destroy();
      voiceManagerRef.current = null;
    };
  }, []);

  useEffect(() => {
    voiceManagerRef.current?.updateFromSnapshot(mainSnapshot ?? {
      mode: 'demo',
      modelReady: false,
      claudeCodeReady: false,
      avatarState: 'idle',
      taskStatus: 'idle',
      timeline: [],
      timelineRevision: 0,
    });
  }, [mainSnapshot]);

  useEffect(() => {
    if (!composerOpen) return;
    const frame = requestAnimationFrame(() => editorRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [composerOpen]);

  const newestText = snapshot?.timeline[snapshot.timeline.length - 1]?.text;
  useEffect(() => {
    const feed = feedRef.current;
    if (!visible || !feed || !followFeedRef.current || window.getSelection()?.toString()) return;
    // Reading scrollHeight forces a layout; do it once per frame instead of once per snapshot.
    const frame = requestAnimationFrame(() => { feed.scrollTop = feed.scrollHeight; });
    return () => cancelAnimationFrame(frame);
  }, [visible, composerOpen, snapshot?.timeline.length, newestText, snapshot?.proposal?.id]);

  function restoreRejectedSubmission(originId: string | null, sentDraft: string,
    sentAttachments: DroppedAttachment[], goal = false): void {
    const stillHere = destinationRef.current === 'main' && activeConversationIdRef.current === originId;
    const current = stillHere ? composerStateRef.current : restoreComposerState(composerStash.current, originId);
    const restored = {
      draft: mergeComposerDraft(sentDraft, current.draft),
      attachments: mergeComposerAttachments(sentAttachments, current.attachments)
    };
    if (originId) {
      stashComposerState(composerStash.current, originId, restored.draft, restored.attachments);
      if (goal) goalPromptStash.current.set(originId, true);
    }
    if (!stillHere) return;
    composerStateRef.current = restored;
    setDraft(restored.draft);
    setAttachments(restored.attachments);
    if (restored.attachments.length > 5) setAttachmentError('已保留全部附件；一次最多发送 5 个，请先移除多余附件。');
    if (goal) setGoalPrompting(true);
    setComposerOpen(true);
  }

  function beginSubmission(conversationId: string | null): boolean {
    if (submitLockRef.current.has(conversationId)) return false;
    submitLockRef.current.add(conversationId);
    setSendingConversationIds(new Set(submitLockRef.current));
    return true;
  }

  function endSubmission(conversationId: string | null): void {
    submitLockRef.current.delete(conversationId);
    setSendingConversationIds(new Set(submitLockRef.current));
  }

  async function sendSide(strategy: 'queue' | 'steer'): Promise<void> {
    const sessionId = sideChatRef.current?.sessionId;
    if (!sessionId || sideSubmitLockRef.current.has(sessionId) || contextCompacting) return;
    const message = draft.trim() || (attachments.length ? '请阅读附件并帮助我。' : '');
    if (!message) return;
    const commandError = sideOnlySlashError(message);
    if (commandError) {
      setAttachmentError(commandError);
      return;
    }
    if (attachments.length > 5) {
      setAttachmentError('一次最多发送 5 个附件，请先移除多余附件。');
      return;
    }
    const attachmentSize = attachments.reduce((sum, item) => sum + item.content.length + (item.path?.length ?? 0) + item.name.length + 100, 0);
    if (message.length + attachmentSize > 8_000) {
      setAttachmentError('消息与附件内容合计不能超过 8000 字，请移除较大的文件。');
      return;
    }
    const sentDraft = draft;
    const sentAttachments = attachments;
    const payload = attachments.map(({ name, content, path }) => ({ name, content, path }));
    sideSubmitLockRef.current.add(sessionId);
    setSideSendingIds(new Set(sideSubmitLockRef.current));
    stashComposerState(sideComposerStash.current, sessionId, '', []);
    composerStateRef.current = { draft: '', attachments: [] };
    setDraft('');
    setAttachments([]);
    setAttachmentError(null);
    followFeedRef.current = true;
    let accepted = false;
    try {
      accepted = await run((bridge) => bridge.sendSideChatMessage(sessionId, message, payload, strategy));
    } catch {
      accepted = false;
    } finally {
      sideSubmitLockRef.current.delete(sessionId);
      setSideSendingIds(new Set(sideSubmitLockRef.current));
    }
    if (accepted || !sideSessionExists(sessionId)) return;
    const stillHere = destinationRef.current === 'side' && sideChatRef.current?.sessionId === sessionId;
    const current = stillHere ? composerStateRef.current : restoreComposerState(sideComposerStash.current, sessionId);
    const restored = {
      draft: mergeComposerDraft(sentDraft, current.draft),
      attachments: mergeComposerAttachments(sentAttachments, current.attachments)
    };
    stashComposerState(sideComposerStash.current, sessionId, restored.draft, restored.attachments);
    if (stillHere) {
      composerStateRef.current = restored;
      setDraft(restored.draft);
      setAttachments(restored.attachments);
      setComposerOpen(true);
      setAttachmentError('临时侧聊发送失败，草稿已恢复。');
    }
  }

  async function send(strategy: 'queue' | 'steer' = 'queue') {
    if (destinationRef.current === 'side') {
      await sendSide(strategy);
      return;
    }
    if (goalPrompting) {
      const goal = draft.trim();
      const originId = activeConversationIdRef.current;
      if (!goal || submitLockRef.current.has(originId) || contextCompacting) return;
      const sentDraft = draft;
      if (originId) {
        stashComposerState(composerStash.current, originId, '', attachments);
        goalPromptStash.current.set(originId, false);
      }
      composerStateRef.current = { draft: '', attachments };
      setDraft('');
      setGoalPrompting(false);
      const accepted = await sendGoal(`/goal ${goal}`, originId);
      if (!accepted) restoreRejectedSubmission(originId, sentDraft, [], true);
      return;
    }
    const message = draft.trim() || (attachments.length ? '请阅读附件并帮助我。' : '');
    const originId = activeConversationIdRef.current;
    if (!message || submitLockRef.current.has(originId) || contextCompacting) return;
    if (attachments.length > 5) {
      setAttachmentError('一次最多发送 5 个附件，请先移除多余附件。');
      return;
    }
    const attachmentSize = attachments.reduce((sum, item) => sum + item.content.length + (item.path?.length ?? 0) + item.name.length + 100, 0);
    if (message.length + attachmentSize > 8_000) {
      setAttachmentError('消息与附件内容合计不能超过 8000 字，请移除较大的文件。');
      return;
    }
    followFeedRef.current = true;
    const sentDraft = draft;
    const sentAttachments = attachments;
    const payload = attachments.map(({ name, content, path }) => ({ name, content, path }));
    if (!beginSubmission(originId)) return;
    if (originId) stashComposerState(composerStash.current, originId, '', []);
    composerStateRef.current = { draft: '', attachments: [] };
    setDraft('');
    setAttachments([]);
    setAttachmentError(null);
    let accepted = false;
    try {
      accepted = await run((bridge) => bridge.sendMessage(message, payload, strategy, originId ?? undefined));
    } catch (cause) {
      setAttachmentError(cause instanceof Error ? cause.message : '发送失败，草稿已恢复。');
    } finally {
      endSubmission(originId);
    }
    if (!accepted) restoreRejectedSubmission(originId, sentDraft, sentAttachments);
  }

  function acceptSuggestion(item: ComposerSuggestion) {
    if (!suggestionTrigger) return;
    const after = draft.slice(suggestionTrigger.end);
    const inserted = item.insertText + (after && /^\s/.test(after) ? '' : ' ');
    const next = draft.slice(0, suggestionTrigger.start) + inserted + after;
    const nextCaret = suggestionTrigger.start + inserted.length;
    setDraft(next);
    setCaretIndex(nextCaret);
    setDismissedSuggestion(null);
    requestAnimationFrame(() => {
      editorRef.current?.focus();
      editorRef.current?.setSelectionRange(nextCaret, nextCaret);
      setCaretIndex(nextCaret);
    });
  }

  async function addFiles(files: File[]) {
    const origin = destinationRef.current;
    const originSideId = origin === 'side' ? sideChatRef.current?.sessionId : null;
    const originConversationId = origin === 'main' ? activeConversationIdRef.current : null;
    const originIsCurrent = () => destinationRef.current === origin && (origin === 'side'
      ? sideChatRef.current?.sessionId === originSideId
      : activeConversationIdRef.current === originConversationId);
    setAttachmentError(null);
    const remaining = Math.max(0, 5 - attachments.length);
    if (!remaining) { setAttachmentError('一次最多添加 5 个文件。'); return; }
    if (files.length > remaining) setAttachmentError('一次最多添加 5 个文件。');
    let bridge: PetAPI;
    try { bridge = petBridge(); }
    catch { if (originIsCurrent()) setAttachmentError('文件服务尚未就绪。'); return; }
    const prepared = await Promise.allSettled(files.slice(0, remaining).map((file) => prepareFileAttachment(bridge, file)));
    const failed = prepared.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected' && originIsCurrent()) setAttachmentError(failed.reason instanceof Error ? failed.reason.message : '文件读取失败。');
    if (origin === 'side' && (!originSideId || !sideSessionExists(originSideId))) return;
    const mergePrepared = (current: DroppedAttachment[]): DroppedAttachment[] => {
      const next = [...current];
      for (const result of prepared) {
        if (result.status !== 'fulfilled' || next.length >= 5) continue;
        if (!next.some((item) => item.path === result.value.path)) next.push({ id: crypto.randomUUID(), ...result.value });
      }
      return next;
    };
    if (originIsCurrent()) setAttachments(mergePrepared);
    else if (origin === 'side' && originSideId) {
      const saved = restoreComposerState(sideComposerStash.current, originSideId);
      stashComposerState(sideComposerStash.current, originSideId, saved.draft, mergePrepared(saved.attachments));
    }
    else if (originConversationId) {
      const stashed = restoreComposerState(composerStash.current, originConversationId);
      stashComposerState(composerStash.current, originConversationId, stashed.draft, mergePrepared(stashed.attachments));
    }
  }

  /** Fetch an image chip's bytes once; later hovers reuse the data URL. */
  function requestAttachmentPreview(attachment: UserAttachment) {
    const target = attachment.path;
    if (!target || requestedPreviews.current.has(target)) return;
    requestedPreviews.current.add(target);
    try {
      void petBridge().readImagePreview(target).then((url) => {
        if (url) setAttachmentPreviews((current) => ({ ...current, [target]: url }));
        else requestedPreviews.current.delete(target); // Let a later hover retry a file that was briefly unreadable.
      }).catch(() => requestedPreviews.current.delete(target));
    } catch { requestedPreviews.current.delete(target); }
  }

  function showAttachmentPreview(attachment: UserAttachment, chip: HTMLElement) {
    const composer = composerRef.current?.getBoundingClientRect();
    if (!composer || !isImageAttachmentName(attachment.name)) return;
    requestAttachmentPreview(attachment);
    if (attachment.path) setPreviewCard({ path: attachment.path, name: attachment.name, placement: previewPlacement(composer, chip.getBoundingClientRect()) });
  }

  /** A chip click opens the same full-screen viewer the timeline images use;
   *  the bytes are fetched on demand when no hover preview ran before. */
  async function openAttachmentImage(attachment: UserAttachment): Promise<void> {
    const target = attachment.path;
    if (!target || !isImageAttachmentName(attachment.name)) return;
    let url: string | undefined = attachmentPreviews[target];
    if (!url) {
      try { url = (await petBridge().readImagePreview(target)) ?? undefined; } catch { url = undefined; }
    }
    if (url) {
      const resolved = url;
      setAttachmentPreviews((current) => ({ ...current, [target]: resolved }));
      setPreviewCard(null);
      openImageViewer(attachment.name, resolved);
    }
  }

  async function chooseEffort(level: EffortLevel) {
    if (destinationRef.current === 'side') return;
    if (snapshot?.effort === level) return;
    await run((bridge) => bridge.setEffort(level));
  }

  async function choosePlanMode(on: boolean) {
    if (Boolean(snapshot?.planMode) === on) return;
    const sideId = destinationRef.current === 'side' ? sideChatRef.current?.sessionId : null;
    await run((bridge) => sideId ? bridge.setSideChatPlanMode(sideId, on) : bridge.setPlanMode(on));
  }

  /** Goal mode is the CLI's own /goal: the command starts the stop-hook loop.
   *  Setting it is an ordinary queued turn; clearing it goes through clearGoal
   *  instead — steered into the running loop the command never reaches the CLI
   *  as a command. The composer draft is left untouched. */
  async function sendGoal(text: string, conversationId: string | null = activeConversationIdRef.current): Promise<boolean> {
    if (!snapshot || !text.trim() || !beginSubmission(conversationId)) return false;
    try {
      return await run((bridge) => bridge.sendMessage(text, [], 'queue', conversationId ?? undefined));
    } catch (cause) {
      setAttachmentError(cause instanceof Error ? cause.message : '目标发送失败，内容已恢复。');
      return false;
    } finally {
      endSubmission(conversationId);
    }
  }

  /** The banner's stop button: the main process interrupts the goal loop's
   *  current turn and delivers /goal clear as the next turn of its own. */
  function clearGoal(): void {
    void run((bridge) => bridge.clearGoal(activeConversationIdRef.current ?? undefined));
  }

  /** The goal switch flips the composer into "write the goal" mode: opening
   *  closes the menu and prompts in place; closing clears a running goal, or
   *  just backs out of the prompt. */
  function toggleGoal(): void {
    if (goalPrompting) { setGoalPrompting(false); return; }
    if (snapshot?.goal) { clearGoal(); return; }
    setGoalPrompting(true);
    setModelPickerOpen(false);
    setComposerOpen(true);
    requestAnimationFrame(() => editorRef.current?.focus());
  }

  async function chooseModel(mode: ModelMode) {
    const sideId = destinationRef.current === 'side' ? sideChatRef.current?.sessionId : null;
    const accepted = await run((bridge) => sideId ? bridge.setSideChatModelMode(sideId, mode) : bridge.setModelMode(mode));
    if (accepted) setModelPickerOpen(false);
  }

  async function switchModelProfile(id: string): Promise<void> {
    if (destinationRef.current === 'side') return;
    await run((bridge) => bridge.setModelProfile(id));
  }

  async function compactContext() {
    if (compactBusy || snapshot?.contextCompacting) return;
    setCompactBusy(true);
    try {
      const sideId = destinationRef.current === 'side' ? sideChatRef.current?.sessionId : null;
      const accepted = await run((bridge) => sideId ? bridge.compactSideChat(sideId) : bridge.compactConversation());
      if (accepted) setModelPickerOpen(false);
    } finally {
      setCompactBusy(false);
    }
  }

  function closeComposer() {
    setComposerOpen(false);
    setModelPickerOpen(false);
  }

  async function decide(approved: boolean) {
    const id = snapshot?.proposal?.id;
    if (!id || busy || sendingCurrent) return;
    setBusy(approved ? 'approve' : 'reject');
    const sideId = destinationRef.current === 'side' ? sideChatRef.current?.sessionId : null;
    await run((bridge) => sideId
      ? approved ? bridge.approveSideChatAction(sideId, id) : bridge.rejectSideChatAction(sideId, id)
      : approved ? bridge.approveAction(id) : bridge.rejectAction(id));
    setBusy(null);
  }

  async function stop() {
    if (busy) return;
    setBusy('stop');
    voiceManagerRef.current?.stopSpeaking();
    const sideId = destinationRef.current === 'side' ? sideChatRef.current?.sessionId : null;
    await run((bridge) => sideId ? bridge.stopSideChat(sideId) : bridge.stop());
    setBusy(null);
  }

  async function setSideExpanded(expanded: boolean): Promise<void> {
    const sessionId = sideChatRef.current?.sessionId;
    if (!sessionId) return;
    await run(async (bridge) => { await bridge.setSideChatExpanded(sessionId, expanded); });
  }

  async function discardSide(): Promise<void> {
    const sessionId = sideChatRef.current?.sessionId;
    if (!sessionId) return;
    await run((bridge) => bridge.discardSideChat(sessionId));
  }

  async function editQueuedMessage(message: PendingMessage) {
    const origin = destinationRef.current;
    const sideId = origin === 'side' ? sideChatRef.current?.sessionId : null;
    const conversationId = origin === 'main' ? activeConversationIdRef.current : null;
    const accepted = await run((bridge) => sideId
      ? bridge.removeSideQueuedMessage(sideId, message.id) : bridge.removeQueuedMessage(message.id));
    if (!accepted) return;
    if (sideId && !sideSessionExists(sideId)) return;
    const stillHere = destinationRef.current === origin && (origin === 'side'
      ? sideChatRef.current?.sessionId === sideId
      : activeConversationIdRef.current === conversationId);
    const current = stillHere ? composerStateRef.current : origin === 'side'
      ? restoreComposerState(sideComposerStash.current, sideId) : restoreComposerState(composerStash.current, conversationId);
    const recalled = message.text;
    const next: StashedComposer<DroppedAttachment> = {
      draft: current.draft.trim() ? `${recalled}\n\n${current.draft}` : recalled,
      attachments: [...current.attachments]
    };
    let dropped = false;
    for (const attachment of message.attachments) {
      if (next.attachments.length >= 5) { dropped = true; continue; }
      if (next.attachments.some((item) => item.name === attachment.name && (item.path ?? '') === (attachment.path ?? ''))) continue;
      next.attachments.push({ id: crypto.randomUUID(), ...attachment });
    }
    if (!stillHere) {
      if (origin === 'side') stashComposerState(sideComposerStash.current, sideId, next.draft, next.attachments);
      else if (conversationId) stashComposerState(composerStash.current, conversationId, next.draft, next.attachments);
      return;
    }
    composerStateRef.current = next;
    setDraft(next.draft);
    setAttachments(next.attachments);
    if (dropped) setAttachmentError('最多 5 个附件，部分附件未剪切回。');
    setComposerOpen(true);
    const recalledEnd = recalled.length;
    setCaretIndex(recalledEnd);
    requestAnimationFrame(() => {
      editorRef.current?.focus();
      editorRef.current?.setSelectionRange(recalledEnd, recalledEnd);
      setCaretIndex(recalledEnd);
    });
  }

  function scrollToBottom() {
    const feed = feedRef.current;
    if (!feed) return;
    followFeedRef.current = true;
    setFeedAtBottom(true);
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    feed.scrollTo({ top: feed.scrollHeight, behavior: reduceMotion ? 'auto' : 'smooth' });
  }

  function openLibrary() {
    setLibraryOpen(true);
    setModelPickerOpen(false);
    setSessionMenuOpen(false);
    setTabMenu(null);
    setDeleteId(null);
    setRenameId(null);
    setLibraryError(null);
  }

  function showTabMenu(event: MouseEvent<HTMLButtonElement>, item: ConversationSummary) {
    event.preventDefault();
    event.stopPropagation();
    const container = event.currentTarget.closest<HTMLElement>('.panel-bubble');
    if (!container) return;
    const bounds = container.getBoundingClientRect();
    setSessionMenuOpen(false);
    setTabMenu({ item, container, x: event.clientX - bounds.left, y: event.clientY - bounds.top });
  }

  function showTurnMenu(event: MouseEvent<HTMLElement>, turnUserId: string, title: string, running: boolean) {
    event.preventDefault();
    event.stopPropagation();
    const container = event.currentTarget.closest<HTMLElement>('.panel-bubble');
    if (!container) return;
    const bounds = container.getBoundingClientRect();
    setTurnMenu({ turnUserId, title, running, container, x: event.clientX - bounds.left, y: event.clientY - bounds.top });
  }

  function beginTabDrag(event: ReactPointerEvent<HTMLButtonElement>, item: ConversationSummary) {
    if (event.button !== 0 || libraryBusy) return;
    tabDragRef.current = { id: item.id, startX: event.clientX, moved: false };
  }

  // The drag's settle animation: whenever the tab order can change, each tab
  // that moved glides from its old spot — a DOM reorder has no transition of
  // its own, so the old x is captured and replayed as a one-off transform
  // (the FLIP pass), skipped under reduced motion.
  const tabPositionsRef = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const tabs = quickTabsRef.current;
    if (!tabs) return;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const next = new Map<string, number>();
    for (const button of tabs.querySelectorAll<HTMLElement>('.panel-quick-tab[data-tab-id]')) {
      const id = button.dataset.tabId!;
      const x = button.getBoundingClientRect().left;
      next.set(id, x);
      const before = tabPositionsRef.current.get(id);
      if (reduceMotion || before === undefined || Math.abs(before - x) < 1) continue;
      for (const animation of button.getAnimations()) {
        if (animation.id === 'tab-flip') animation.cancel();
      }
      const flip = button.animate(
        [{ transform: `translateX(${before - x}px)` }, { transform: 'none' }],
        { duration: 160, easing: 'ease-out' }
      );
      flip.id = 'tab-flip';
    }
    tabPositionsRef.current = next;
  }, [tabDragOrder, libraryRevision, tabLimit, expanded, quickTabs.length, library?.activeConversationId]);

  // A press on a tab becomes a drag after five pixels; the row reorders under
  // the pointer and the drop commits the arrangement. Pointer events (not
  // HTML5 dnd) keep the ghost image out and the click suppression close by.
  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const drag = tabDragRef.current;
      if (!drag) return;
      if (!drag.moved) {
        if (Math.abs(event.clientX - drag.startX) < 5) return;
        drag.moved = true;
        setTabDragOrder(orderedSessionsRef.current.map((item) => item.id));
      }
      const tabs = quickTabsRef.current;
      if (!tabs) return;
      const buttons = Array.from(tabs.querySelectorAll<HTMLElement>('.panel-quick-tab:not(.panel-quick-tab-new)'));
      let toIndex = Math.max(0, buttons.length - 1);
      for (let index = 0; index < buttons.length; index += 1) {
        const rect = buttons[index].getBoundingClientRect();
        if (event.clientX < rect.left + rect.width / 2) { toIndex = index; break; }
      }
      setTabDragOrder((current) => (current ? moveTab(current, drag.id, toIndex) : current));
    };
    const onEnd = () => {
      const drag = tabDragRef.current;
      if (!drag) return;
      tabDragRef.current = null;
      if (!drag.moved) return;
      // Swallow the click the pointerup is about to send — this gesture was a
      // drag, not a tab switch.
      tabClickSuppressRef.current = true;
      window.setTimeout(() => { tabClickSuppressRef.current = false; }, 0);
      const order = tabDragOrderRef.current;
      if (!order) return;
      void run((bridge) => bridge.setConversationTabOrder(order)).then(() => {
        setTabDragOrder((latest) => (latest === order ? null : latest));
      });
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onEnd);
    document.addEventListener('pointercancel', onEnd);
    return () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onEnd);
      document.removeEventListener('pointercancel', onEnd);
    };
  }, [run]);

  async function libraryAction(action: (bridge: PetAPI) => Promise<void>, onSuccess?: () => void) {
    if (libraryBusy) return;
    setLibraryBusy(true);
    setLibraryError(null);
    const accepted = await run(action);
    setLibraryBusy(false);
    if (accepted) onSuccess?.();
  }

  function clearSelection(): void {
    setSelectedSessionIds(new Set());
    setBatchDeleteConfirm(false);
  }

  function toggleSelected(id: string): void {
    if (!selectedSessionIds.has(id) && selectedSessionIds.size >= 100) {
      setLibraryError('一次最多选择 100 个会话。');
      return;
    }
    setMultiSelect(true);
    setBatchDeleteConfirm(false);
    setSelectedSessionIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function batchManage(action: 'archive' | 'restore' | 'delete' | 'pin' | 'unpin', ids: string[]): Promise<void> {
    if (libraryBusy || ids.length === 0) return;
    let outcomes: Array<{ id: string; status: 'updated' | 'skipped'; reason?: string }> = [];
    await libraryAction(async (bridge) => {
      outcomes = (await bridge.batchManageConversations(action, ids)).outcomes;
    }, () => {
      const updated = outcomes.filter((item) => item.status === 'updated');
      const unresolved = outcomes.filter((item) => item.status === 'skipped' && ['busy', 'archived'].includes(item.reason ?? ''));
      const missing = outcomes.filter((item) => item.status === 'skipped' && item.reason === 'not_found');
      const resolved = new Set(outcomes.filter((item) => item.status === 'updated' || !unresolved.includes(item)).map((item) => item.id));
      setSelectedSessionIds((current) => new Set([...current].filter((id) => !resolved.has(id))));
      if (action === 'delete' || action === 'archive') for (const item of updated) {
        forgetParentSide(item.id);
        if (action === 'delete') composerStash.current.delete(item.id);
      }
      if (unresolved.length === 0) {
        setMultiSelect(false);
        clearSelection();
        if (missing.length) setLibraryError(`${missing.length} 个会话已不存在，其余操作已完成。`);
      } else {
        const reasons = new Set(unresolved.map((item) => item.reason));
        setLibraryError(`已处理 ${updated.length} 个，跳过 ${unresolved.length} 个${reasons.has('busy') ? '（会话仍在运行或排队）' : ''}${missing.length ? `；${missing.length} 个已不存在` : ''}。`);
      }
    });
    setBatchDeleteConfirm(false);
  }

  async function createConversation() {
    const currentId = activeConversationIdRef.current;
    const mainComposer = destinationRef.current === 'main'
      ? composerStateRef.current : restoreComposerState(composerStash.current, currentId);
    flushDraft(currentId, mainComposer.draft);
    stashComposerState(composerStash.current, currentId, mainComposer.draft, mainComposer.attachments);
    if (currentId && destinationRef.current === 'main') goalPromptStash.current.set(currentId, goalPrompting);
    await libraryAction((bridge) => bridge.createConversation(), () => {
      if (activeConversationIdRef.current !== currentId) {
        setLibraryOpen(false);
        setComposerOpen(true);
        return;
      }
      pendingNewConversationRef.current = true;
      rememberVisibleSide();
      activeConversationIdRef.current = null;
      destinationRef.current = 'main';
      sideChatRef.current = null;
      setSideChat(null);
      setLibraryOpen(false);
      composerStateRef.current = { draft: '', attachments: [] };
      setDraft('');
      setAttachments([]);
      setGoalPrompting(false);
      setComposerOpen(true);
    });
  }

  /** A draft write that must never surface an error: it runs on a debounce
   *  and on every switch, and a failed save must not bother the writer. */
  function flushDraft(id: string | null, text: string): void {
    if (!id) return;
    try { void petBridge().saveDraft(id, text).catch(() => undefined); } catch { /* 静态预览无桥。 */ }
  }

  // 输入停一下即落盘：关窗或关机不会丢半句话。附件不存——它们的临时文件不跨重启。
  useEffect(() => {
    if (destinationRef.current !== 'main') return;
    const id = library?.activeConversationId;
    if (!id || activeConversationIdRef.current !== id || composerStateRef.current.draft !== draft) return;
    const timer = window.setTimeout(() => {
      if (destinationRef.current === 'main' && activeConversationIdRef.current === id && composerStateRef.current.draft === draft) {
        flushDraft(id, draft);
      }
    }, 800);
    return () => window.clearTimeout(timer);
  }, [draft, library?.activeConversationId]);

  // 应用重启后第一次进入：当前会话的草稿从会话记录里拿回来。内存里的 stash
  // 优先（它是这次运行中最新的），只有它没有记录时才碰磁盘。
  const draftRestoredRef = useRef(false);
  useEffect(() => {
    if (destinationRef.current !== 'main') return;
    const id = library?.activeConversationId;
    if (!id || draftRestoredRef.current || composerStash.current.has(id)) return;
    draftRestoredRef.current = true;
    let bridge: PetAPI;
    try { bridge = petBridge(); } catch { return; }
    void bridge.getDraft(id).then((text) => {
      if (!text || activeConversationIdRef.current !== id) return;
      if (destinationRef.current === 'side') {
        if (!composerStash.current.has(id)) stashComposerState(composerStash.current, id, text, []);
        return;
      }
      if (composerStateRef.current.draft) return;
      composerStateRef.current = { draft: text, attachments: [] };
      setDraft(text);
      setCaretIndex(text.length);
      setComposerOpen(true);
    }).catch(() => undefined);
  }, [library?.activeConversationId, sideExpanded]);

  async function selectConversation(item: ConversationSummary) {
    const currentId = activeConversationIdRef.current;
    const mainComposer = destinationRef.current === 'main'
      ? composerStateRef.current : restoreComposerState(composerStash.current, currentId);
    flushDraft(currentId, mainComposer.draft);
    stashComposerState(composerStash.current, currentId, mainComposer.draft, mainComposer.attachments);
    if (currentId && destinationRef.current === 'main') goalPromptStash.current.set(currentId, goalPrompting);
    const operation = item.archivedAt === null
      ? (bridge: PetAPI) => bridge.selectConversation(item.id)
      : (bridge: PetAPI) => bridge.restoreConversation(item.id);
    await libraryAction(operation, () => {
      rememberVisibleSide();
      activeConversationIdRef.current = item.id;
      destinationRef.current = 'main';
      sideChatRef.current = null;
      setSideChat(null);
      setLibraryOpen(false);
      setSessionMenuOpen(false);
      const goalDraftOpen = goalPromptStash.current.get(item.id) ?? false;
      setGoalPrompting(goalDraftOpen);
      const stashed = composerStash.current.get(item.id);
      if (stashed) {
        const saved = { draft: stashed.draft, attachments: [...stashed.attachments] };
        composerStateRef.current = saved;
        setDraft(saved.draft);
        setAttachments(saved.attachments);
        setCaretIndex(saved.draft.length);
        setAttachmentError(saved.attachments.length > 5 ? '已保留全部附件；一次最多发送 5 个，请先移除多余附件。' : null);
        setComposerOpen(Boolean(saved.draft || saved.attachments.length || goalDraftOpen));
        const targetSide = sideSnapshots.current.get(item.id);
        if (targetSide) applySideSnapshotRef.current(targetSide);
        return;
      }
      // 内存里没有这个会话的草稿（应用重启后的第一次切换）：从会话记录
      // 里拿回来，晚到的磁盘值不覆盖已经开始的新输入。
      composerStateRef.current = { draft: '', attachments: [] };
      setDraft('');
      setAttachments([]);
      setCaretIndex(0);
      setAttachmentError(null);
      setComposerOpen(goalDraftOpen);
      let bridge: PetAPI;
      try { bridge = petBridge(); } catch { return; }
      void bridge.getDraft(item.id).then((text) => {
        if (!text || activeConversationIdRef.current !== item.id) return;
        if (destinationRef.current === 'side') {
          if (!composerStash.current.has(item.id)) stashComposerState(composerStash.current, item.id, text, []);
          return;
        }
        if (composerStateRef.current.draft) return;
        composerStateRef.current = { draft: text, attachments: [] };
        setDraft(text);
        setCaretIndex(text.length);
        setComposerOpen(true);
      }).catch(() => undefined);
      const targetSide = sideSnapshots.current.get(item.id);
      if (targetSide) applySideSnapshotRef.current(targetSide);
    });
  }

  async function saveRename(id: string) {
    const title = renameDraft.trim();
    if (!title) { setLibraryError('请输入会话名称。'); return; }
    await libraryAction((bridge) => bridge.renameConversation(id, title), () => setRenameId(null));
  }

  const searchActive = Boolean(libraryQuery.trim());
  const searchStatus = searchActive
    ? librarySearch.key === librarySearchKey ? librarySearch.status : 'loading'
    : 'idle';
  const visibleConversations = searchActive
    ? searchStatus === 'done' ? librarySearch.results : []
    : library?.conversations.filter((item) => (item.archivedAt !== null) === libraryArchived) ?? [];
  const selectedVisibleConversations = visibleConversations.filter((item) => selectedSessionIds.has(item.id));
  const selectedVisibleIds = selectedVisibleConversations.map((item) => item.id);
  const batchUnpin = selectedVisibleConversations.length > 0 && selectedVisibleConversations.every((item) => item.pinnedAt !== null);
  const visibleSessionIds = visibleConversations.map((item) => item.id);
  const visibleSessionKey = JSON.stringify(visibleSessionIds);
  useEffect(() => {
    if (searchStatus === 'loading') return;
    const visible = new Set(visibleSessionIds);
    setSelectedSessionIds((current) => {
      const remaining = [...current].filter((id) => visible.has(id));
      return remaining.length === current.size ? current : new Set(remaining);
    });
  }, [visibleSessionKey, searchStatus]);
  const displayedGroups: Array<{ key: string; label: string | null; conversations: ConversationSummary[] }> =
    libraryGrouped
      ? groupSessionSummaries(visibleConversations, libraryArchived, Date.now())
      : [{ key: 'all', label: null, conversations: visibleConversations }];

  const status = snapshot?.proposal ? 'awaiting_approval' : snapshot?.taskStatus ?? 'idle';
  const sideStatus = sideSessionId
    ? sideChat?.snapshot?.proposal ? 'awaiting_approval' : sideChat?.snapshot?.taskStatus ?? 'idle'
    : 'idle';
  // Live per-conversation statuses arrive through the library summaries now,
  // so every tab dot is truthful — the displayed conversation included.
  const conversationStatus = (item: ConversationSummary): TaskStatus => item.taskStatus;
  const statusRunning = (item: ConversationSummary): boolean => ['planning', 'awaiting_approval', 'executing', 'verifying'].includes(conversationStatus(item));
  const active = ['planning', 'awaiting_approval', 'executing', 'verifying'].includes(status);
  const statusLive = status === 'planning' || status === 'executing' || status === 'verifying';
  const pendingMessages = sideExpanded ? sideChat?.pendingMessages ?? [] : snapshot?.pendingMessages ?? [];
  const queuedCount = pendingMessages.length;
  const empty = !libraryOpen && !sendingCurrent && !error && !voiceError && status === 'idle' && !snapshot?.currentTask && !snapshot?.timeline.length && !snapshot?.proposal && queuedCount === 0;
  // With no conversation left the bubble keeps its full shape: the ball form
  // has no tab strip and no room for the "+", and starting fresh is exactly
  // what the owner wants to do next.
  const compactEmpty = empty && !sideSessionId && !expanded && !modelPickerOpen && !suggestionOpen && recentSessions.length > 0;
  const layout: BubbleLayout = !compactEmpty ? 'full' : !composerOpen ? 'empty' : attachments.length ? 'composer_attachments' : 'composer';
  const compactComposerHeight = 112 + composerHeight + (attachments.length ? 26 : 0);
  // 30fps 的呼吸式动效：扫光与脉冲点改用 CSS 变量推进，值每 1/30 秒走一步——
  // 合成器只在步进的帧上提交新内容（60fps 时是每帧），dwm 的合成次数减半。
  // 没有动效在跑时这个计时器根本不启动，变量停在各自的静止位。
  useEffect(() => {
    if (!active && !sendingCurrent) return;
    const started = performance.now();
    const tri = (now: number, period: number, offset: number): number => {
      const t = ((((now - started + offset) % period) + period) % period) / period;
      return t < 0.5 ? t * 2 : (1 - t) * 2;
    };
    const tick = (): void => {
      const now = performance.now();
      const root = document.documentElement.style;
      root.setProperty('--panel-sweep-p', tri(now, 3400, 0).toFixed(3));
      root.setProperty('--panel-pulse-p', tri(now, 1200, 0).toFixed(3));
      root.setProperty('--panel-bounce-p1', tri(now, 1200, 0).toFixed(3));
      root.setProperty('--panel-bounce-p2', tri(now, 1200, -180).toFixed(3));
      root.setProperty('--panel-bounce-p3', tri(now, 1200, -360).toFixed(3));
    };
    tick();
    const timer = window.setInterval(tick, 33);
    return () => window.clearInterval(timer);
  }, [active, sendingCurrent]);
  // Grouping and task extraction scan the whole history; with incremental
  // snapshots an unchanged timeline keeps its identity, so these memos let
  // every render that doesn't touch the timeline reuse the last result.
  const timeline = snapshot?.timeline ?? EMPTY_TIMELINE;
  // While a turn runs, its start marks the live window: a user line past it
  // was steered into the running turn. New records carry the flag on the entry
  // itself; this covers the steers already on disk without one.
  const liveTurnStart = active && snapshot?.taskMetrics && !snapshot.taskMetrics.finishedAt
    ? Date.parse(snapshot.taskMetrics.startedAt) : NaN;
  const liveTurnStartMs = Number.isFinite(liveTurnStart) ? liveTurnStart : undefined;
  const timelineGroups = useMemo(() => groupTimeline(timeline, liveTurnStartMs), [timeline, liveTurnStartMs]);
  const transcriptEstimateYuan = useMemo(() => {
    let amount = 0;
    for (const entry of timeline) {
      if (entry.kind === 'user' && entry.metrics?.usageSource === 'transcript_estimate' &&
          typeof entry.metrics.spentYuan === 'number' && Number.isFinite(entry.metrics.spentYuan)) {
        amount += entry.metrics.spentYuan;
      }
    }
    return amount > 0 ? amount : undefined;
  }, [timeline]);
  const tasks = useMemo(() => agentTasks(timeline), [timeline]);
  const navMarkList = useMemo(() => navMarks(timelineGroups), [timelineGroups]);
  const [earlierGroups, setEarlierGroups] = useState(0);
  const earlierAnchorRef = useRef<{ height: number } | null>(null);
  const pendingJumpRef = useRef<string | null>(null);
  const visibleGroups = useMemo(
    () => tailWindow(timelineGroups, EARLIER_MIN_ENTRIES, earlierGroups),
    [timelineGroups, earlierGroups]
  );
  const hasEarlier = visibleGroups.length < timelineGroups.length;
  // Reaching the top of the feed pulls in the next stretch of older history,
  // keeping the reader's place by the height the new rows added above.
  function loadEarlier(): void {
    const feed = feedRef.current;
    if (!feed || !hasEarlier) return;
    earlierAnchorRef.current = { height: feed.scrollHeight };
    setEarlierGroups((count) => count + EARLIER_STEP_GROUPS);
  }
  /** The rail's click: scroll to a message, widening the rendered window to
   *  include it first when it lies in the folded history above. */
  function jumpToEntry(id: string): void {
    const target = feedRef.current?.querySelector(`[data-entry-id="${id}"]`);
    if (target) {
      followFeedRef.current = false;
      target.scrollIntoView({ block: 'start' });
      return;
    }
    const groupIndex = timelineGroups.findIndex((group) => group.kind === 'turn'
      ? group.user.id === id || group.items.some((item) => item.id === id)
      : group.entry.id === id);
    if (groupIndex < 0) return;
    const visibleStart = timelineGroups.length - visibleGroups.length;
    if (groupIndex >= visibleStart) return; // Rendered but somehow not found; leave it be.
    pendingJumpRef.current = id;
    setEarlierGroups((count) => count + (visibleStart - groupIndex));
  }
  let latestTurnIndex = -1;
  for (let index = visibleGroups.length - 1; index >= 0; index--) {
    if (visibleGroups[index].kind === 'turn') { latestTurnIndex = index; break; }
  }
  // What the panel should say while nothing is streaming: the model is thinking,
  // or a specific command is running.
  const liveEntry = active ? timeline[timeline.length - 1] : undefined;
  const liveThinking = Boolean(liveEntry && liveEntry.kind === 'thinking' && !liveEntry.endedAt);
  let runningTool: string | undefined;
  for (let index = timeline.length - 1; index >= 0; index--) {
    const entry = timeline[index];
    if (entry.kind === 'tool' && entry.tool?.status === 'running') { runningTool = entry.tool.name; break; }
  }

  useLayoutEffect(() => {
    const feed = feedRef.current;
    const anchor = earlierAnchorRef.current;
    if (!feed || !anchor) return;
    earlierAnchorRef.current = null;
    // Keep the reader's place: the taller history must not push the viewport.
    feed.scrollTop += feed.scrollHeight - anchor.height;
  }, [earlierGroups]);

  useLayoutEffect(() => {
    const feed = feedRef.current;
    const id = pendingJumpRef.current;
    if (!feed || !id) return;
    const target = feed.querySelector(`[data-entry-id="${id}"]`);
    if (!target) return;
    pendingJumpRef.current = null;
    followFeedRef.current = false;
    target.scrollIntoView({ block: 'start' });
  }, [earlierGroups, visibleGroups]);

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!composerOpen || !editor) return;
    const nextHeight = fitEditorHeight(editor);
    if (nextHeight === null) return;
    setComposerHeight((current) => current === nextHeight ? current : nextHeight);
  }, [draft, composerOpen, expanded, compactEmpty]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!composerOpen || !editor) return;
    let width = editor.clientWidth;
    const observer = new ResizeObserver(() => {
      if (editor.clientWidth === width) return;
      width = editor.clientWidth;
      const nextHeight = fitEditorHeight(editor);
      if (nextHeight === null) return;
      setComposerHeight((current) => current === nextHeight ? current : nextHeight);
    });
    observer.observe(editor);
    return () => observer.disconnect();
  }, [composerOpen]);

  // Selecting text inside a message floats a 引用／复制 bar over the feed; the
  // mousedown handler clears it, and the bar itself cancels that clear so the
  // click can read the selection back.
  useEffect(() => {
    if (!visible) return;
    const onMouseUp = (): void => {
      const wrap = feedWrapRef.current;
      const selection = window.getSelection?.();
      const text = selection?.toString().trim() ?? '';
      const anchor = selection?.anchorNode;
      const element = anchor instanceof Element ? anchor : anchor?.parentElement ?? null;
      const message = element?.closest('.panel-event-assistant, .panel-event-user') ?? null;
      if (!text || !selection?.rangeCount || !message || !wrap?.contains(message)) { setQuoteSelection(null); return; }
      const range = selection.getRangeAt(0).getBoundingClientRect();
      if (!range.width && !range.height) { setQuoteSelection(null); return; }
      const frame = wrap.getBoundingClientRect();
      // The bar rides above the selection: the drag ends with the pointer just
      // below it, and a bar in that spot sits under the cursor's own shadow.
      // Only when the selection is too close to the top does it drop below.
      const above = range.top - frame.top - 30;
      setQuoteSelection({
        text,
        // 52 ≈ half of the 引用＋复制 capsule, so it never slides off the edge.
        x: Math.max(52, Math.min(range.left + range.width / 2 - frame.left, frame.width - 52)),
        y: above >= 6 ? above : range.bottom - frame.top + 6
      });
    };
    const onMouseDown = (): void => setQuoteSelection(null);
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, [visible]);

  function applyQuote(): void {
    const selected = quoteSelection;
    if (!selected) return;
    setQuoteSelection(null);
    const block = formatSelectionQuote(selected.text);
    setDraft((current) => (current.trim() ? `${current.trimEnd()}\n\n${block}\n` : `${block}\n`));
    setComposerOpen(true);
    requestAnimationFrame(() => {
      const editor = editorRef.current;
      if (!editor) return;
      editor.focus();
      editor.setSelectionRange(editor.value.length, editor.value.length);
    });
  }

  // Copy is the quiet sibling of 引用: same selection, straight to the
  // clipboard, no toast (the standard keeps success silent; the bar closing
  // is the acknowledgement).
  async function copyQuote(): Promise<void> {
    const selected = quoteSelection;
    if (!selected) return;
    setQuoteSelection(null);
    await writeClipboard(selected.text);
  }

  // A popover owns Escape while it is open: the first Esc closes the popover, a
  // second one stops the task. Without this guard the capture-phase listener
  // below would steal the key from an open menu and kill the running turn.
  const escOwners = libraryOpen || modelPickerOpen || effortMenuOpen || contextMenuOpen || sessionMenuOpen || Boolean(tabMenu) || suggestionOpen || renameId !== null || deleteId !== null;
  const escOwnersRef = useRef(escOwners);
  escOwnersRef.current = escOwners;

  // The compose trigger comes back only once the exit animation has fully
  // unmounted the form, so it takes the focus after that — not in the frame
  // the form disappeared.
  const composerWasOpenRef = useRef(false);
  useEffect(() => {
    if (composerWasOpenRef.current && !composerOpen && !composerExit.closing) composeTriggerRef.current?.focus();
    composerWasOpenRef.current = composerOpen;
  }, [composerOpen, composerExit.closing]);

  // A click anywhere outside the rename row gives up on it — the same as
  // pressing 取消, without needing to aim at the button.
  useEffect(() => {
    if (renameId === null) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target || target.closest('.panel-session-edit')) return;
      setRenameId(null);
    };
    document.addEventListener('pointerdown', closeOutside, true);
    return () => document.removeEventListener('pointerdown', closeOutside, true);
  }, [renameId]);

  // Clicking outside the open library drawer puts it away — the conversation
  // beside it is the obvious target, so a plain click there should just work.
  // The buttons that open the drawer toggle it themselves, so they are left
  // alone to avoid closing and reopening in one gesture.
  useEffect(() => {
    if (!libraryOpen) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target || target.closest('.panel-library-drawer')) return;
      if (target.closest('.panel-library-toggle, .panel-conversations-button, .panel-session-menu-all')) return;
      setLibraryOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside, true);
    return () => document.removeEventListener('pointerdown', closeOutside, true);
  }, [libraryOpen]);

  // Escape first dismisses a batch confirmation, then exits selection, then
  // closes the drawer. The capture listener must handle each layer before the
  // document-wide Esc-to-stop handler sees the key.
  useEffect(() => {
    if (!libraryOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || renameId !== null || deleteId !== null) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (batchDeleteConfirmRef.current) { setBatchDeleteConfirm(false); return; }
      if (multiSelectRef.current) { setMultiSelect(false); clearSelection(); return; }
      setLibraryOpen(false);
    };
    // Window capture runs before the document's Esc-to-stop listener.
    window.addEventListener('keydown', closeOnEscape, true);
    return () => window.removeEventListener('keydown', closeOnEscape, true);
  }, [libraryOpen, renameId, deleteId]);

  useEffect(() => {
    if (!visible || !active) return;
    const interruptOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229) return;
      if (escOwnersRef.current) return;
      if (document.querySelector('.panel-image-viewer')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void stop();
    };
    document.addEventListener('keydown', interruptOnEscape, true);
    return () => document.removeEventListener('keydown', interruptOnEscape, true);
  }, [visible, active, busy, run]);

  useEffect(() => {
    const tabs = quickTabsRef.current;
    const current = tabs?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!tabs || !current) return;
    const left = current.offsetLeft - tabs.offsetLeft;
    const right = left + current.offsetWidth;
    if (left < tabs.scrollLeft) tabs.scrollLeft = left;
    else if (right > tabs.scrollLeft + tabs.clientWidth) tabs.scrollLeft = right - tabs.clientWidth;
  }, [library?.activeConversationId, expanded, tabLimit, libraryRevision, compactEmpty]);

  async function toggleExpanded() {
    if (resizePending.current) return;
    resizePending.current = true;
    const next = !expanded;
    try {
      await petBridge().setBubbleExpanded(next);
      setSessionMenuOpen(false);
      setExpanded(next);
    } finally {
      resizePending.current = false;
    }
  }

  useEffect(() => {
    try {
      void petBridge().setBubbleLayout(layout, layout === 'composer' || layout === 'composer_attachments' ? compactComposerHeight : undefined).catch(() => undefined);
    } catch {
      // The HTML preview can render before the desktop bridge exists.
    }
  }, [layout, compactComposerHeight]);

  // A parked question or plan takes over the composer slot until it is settled.
  const ask = snapshot?.question ?? null;
  const plan = snapshot?.plan ?? null;

  return (
    <section className={`panel-bubble${compactEmpty ? ' is-empty' : ''}${expanded ? ' is-expanded' : ''}${sideExpanded ? ' is-side-chat' : ''}${composerOpen || composerExit.closing || ask || plan ? ' is-composing' : ''}${attachments.length ? ' has-attachments' : ''}${modelPickerOpen ? ' is-choosing-model' : ''}`} style={compactEmpty && (composerOpen || composerExit.closing) ? { height: compactComposerHeight } : undefined} aria-label="交互气泡" hidden={!visible} onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={(event) => {
      if (!event.dataTransfer.files.length) return;
      event.preventDefault();
      if (libraryOpen) return;
      setComposerOpen(true);
      void addFiles(Array.from(event.dataTransfer.files));
    }}>
      {(!compactEmpty || composerOpen) && <button type="button" className="panel-expand-toggle panel-window-action" aria-label={expanded ? '还原对话气泡' : '放大对话气泡'} title={expanded ? '还原对话' : '放大对话'} onClick={() => { void toggleExpanded().catch(() => undefined); }}>
        {expanded ? <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 8h4V4M12 4v4h4M16 12h-4v4M8 16v-4H4" /></svg> : <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M8 4H4v4M12 4h4v4M16 12v4h-4M4 12v4h4" /></svg>}
      </button>}
      {(!compactEmpty || composerOpen) && <button type="button" className="panel-window-close panel-window-action" aria-label="关闭聊天窗口" title="关闭聊天窗口" onClick={() => { void run((bridge) => bridge.hidePanel()); }}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg></button>}
      {(error || voiceError) && (
        <div className="panel-toast-stack" aria-label="通知">
          {error && <div className="panel-toast panel-toast-error" role="alert">{error}</div>}
          {voiceError && <div className="panel-toast panel-toast-voice" role="status">{voiceError}</div>}
        </div>
      )}
      {tabMenu && visible && <TabContextMenu
        title={tabMenu.item.title}
        x={tabMenu.x}
        y={tabMenu.y}
        container={tabMenu.container}
        busy={libraryBusy}
        running={statusRunning(tabMenu.item)}
        current={tabMenu.item.id === library?.activeConversationId}
        onRename={() => { openLibrary(); setRenameDraft(tabMenu.item.title); setRenameId(tabMenu.item.id); }}
        onArchive={() => { void libraryAction((bridge) => bridge.archiveConversation(tabMenu.item.id), () => forgetParentSide(tabMenu.item.id)); }}
        onDelete={() => { openLibrary(); setDeleteId(tabMenu.item.id); }}
        onClose={() => setTabMenu(null)}
      />}
      {turnMenu && visible && <TurnContextMenu
        title={turnMenu.title}
        x={turnMenu.x}
        y={turnMenu.y}
        container={turnMenu.container}
        running={turnMenu.running}
        onDelete={() => { const id = library?.activeConversationId; if (id) void run((bridge) => bridge.deleteTurn(id, turnMenu.turnUserId)); }}
        onClose={() => setTurnMenu(null)}
      />}
      <section className="panel-workspace" ref={workspaceRef}>
        {!compactEmpty && <header className={`panel-chat-header${expanded ? ' is-browser' : ' is-numeric'}`} ref={sessionHeaderRef}>
          <button type="button" className="panel-library-toggle" aria-label={expanded ? '会话库' : '会话菜单'} title={expanded ? '会话库' : '会话菜单'} aria-haspopup={expanded ? undefined : 'menu'} aria-expanded={expanded ? libraryOpen : sessionMenuOpen} onClick={expanded ? () => libraryOpen ? setLibraryOpen(false) : openLibrary() : () => setSessionMenuOpen((open) => !open)}><ConversationsIcon /></button>
          {!expanded && sessionMenuOpen && <div className="panel-session-menu" id="panel-session-menu" role="menu" aria-label="会话菜单"
            onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setSessionMenuOpen(false); } }}>
            <div className="panel-session-menu-heading">快捷会话</div>
            {quickTabs.map((item, index) => <button key={item.id} type="button" role="menuitem" aria-current={item.id === library?.activeConversationId ? 'page' : undefined} aria-disabled={libraryBusy || item.id === library?.activeConversationId} onContextMenu={(event) => showTabMenu(event, item)} title={`${item.title}，${taskLabels[conversationStatus(item)]}`} onClick={() => { if (!libraryBusy && item.id !== library?.activeConversationId) void selectConversation(item); }}><i className={`panel-task-dot panel-task-dot-${conversationStatus(item)}`} aria-hidden="true" /><span className="panel-session-menu-number">{index + 1}</span><span className="panel-session-menu-title">{item.title}</span></button>)}
            <button type="button" role="menuitem" className="panel-session-menu-all" onClick={openLibrary}>查看全部会话</button>
          </div>}
          {/* The strip keeps its place even when the last conversation is
              closed: the "+" stays put so a new session is one click away,
              and the row never blinks out under the pointer. */}
          <nav className={`panel-quick-tabs${tabDragOrder ? ' is-dragging' : ''}`} ref={quickTabsRef} aria-label={expanded ? '顶部会话标签' : '顶部会话数字快捷切换'}>
            {quickTabs.map((item, index) => <button key={item.id} type="button" data-tab-id={item.id} className={`panel-quick-tab${item.id === library?.activeConversationId ? ' is-current' : ''}${tabDragOrder && tabDragRef.current?.id === item.id ? ' is-dragging' : ''}`} aria-label={`${index + 1}：${item.title}，${taskLabels[conversationStatus(item)]}`} aria-current={item.id === library?.activeConversationId ? 'page' : undefined} title={`${item.title}，${taskLabels[conversationStatus(item)]}`} aria-disabled={libraryBusy || item.id === library?.activeConversationId} onContextMenu={(event) => showTabMenu(event, item)} onPointerDown={(event) => beginTabDrag(event, item)} onClick={() => { if (tabClickSuppressRef.current) { tabClickSuppressRef.current = false; return; } if (!libraryBusy && item.id !== library?.activeConversationId) void selectConversation(item); }}><i className={`panel-task-dot panel-task-dot-${conversationStatus(item)}`} aria-hidden="true" /><span className="panel-quick-tab-label">{expanded ? item.title : index + 1}</span></button>)}
            {showNewTabButton(quickTabs.length, tabLimit) && <button type="button" className="panel-quick-tab panel-quick-tab-new" aria-label="新建会话" title="新建会话" onClick={() => { if (!libraryBusy) void createConversation(); }}><PlusIcon /></button>}
          </nav>
        </header>}
        <div className="panel-chat-body">
        {(libraryOpen || drawerExit.closing) && drawerBottom !== null && <aside className={`panel-library-drawer${libraryOpen ? '' : ' is-closing'}`} style={{ bottom: drawerBottom ?? 0 }} aria-label="会话列表" onAnimationEnd={drawerExit.endClose}>
          <header className="panel-library-header">
            <button type="button" className="panel-library-icon panel-library-back" aria-label="返回对话" title="返回对话" onClick={() => setLibraryOpen(false)}><BackIcon /></button>
            <h2>会话</h2>
            <button type="button" className="panel-library-icon panel-library-select" aria-label={multiSelect ? '退出多选' : '多选会话'} title={multiSelect ? '退出多选' : '多选会话'} aria-pressed={multiSelect} disabled={libraryBusy} onClick={() => { if (multiSelect) { setMultiSelect(false); clearSelection(); } else { setMultiSelect(true); setDeleteId(null); setRenameId(null); } }}><SelectIcon /></button>
            <button type="button" className="panel-library-icon panel-library-new" disabled={libraryBusy} aria-label="新建会话" title="新建会话" onClick={() => { void createConversation(); }}><PlusIcon /></button>
          </header>
          <div className="panel-library-tabs" role="tablist" aria-label="会话状态">
            <button type="button" role="tab" aria-selected={!libraryArchived} onClick={() => { setLibraryArchived(false); clearSelection(); }}>未归档</button>
            <button type="button" role="tab" aria-selected={libraryArchived} onClick={() => { setLibraryArchived(true); clearSelection(); }}>已归档</button>
          </div>
          <input className="panel-library-search" type="search" aria-label="搜索会话" placeholder="搜索会话与消息" value={libraryQuery} onChange={(event) => { setLibraryQuery(event.target.value); clearSelection(); }} />
          {libraryError && <div className="panel-library-error" role="alert">{libraryError}</div>}
          <div className="panel-session-list" aria-label={libraryArchived ? '已归档会话' : '未归档会话'}>
            {searchStatus === 'loading' && <div className="panel-library-empty" role="status">正在搜索…</div>}
            {searchStatus === 'error' && <div className="panel-library-empty" role="alert">搜索失败，请重新输入或切换分类后重试。</div>}
            {visibleConversations.length === 0 && (searchStatus === 'done' || !searchActive) && <div className="panel-library-empty">{searchActive ? '没有找到会话' : libraryArchived ? '暂无归档会话' : '开始一个新对话'}</div>}
            {displayedGroups.map((group) => <div key={group.key} className="panel-library-group">
              {group.label && <div className="panel-library-group-heading">{group.label}</div>}
              {group.conversations.map((item) => <div key={item.id} className={`panel-session${library?.activeConversationId === item.id ? ' is-current' : ''}${selectedSessionIds.has(item.id) ? ' is-selected' : ''}`}>
              {!multiSelect && renameId === item.id ? <form className="panel-session-edit" onSubmit={(event) => { event.preventDefault(); void saveRename(item.id); }}>
                <input autoFocus aria-label="会话名称" maxLength={120} value={renameDraft} onChange={(event) => setRenameDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') setRenameId(null); }} />
                <button type="submit" className="panel-session-save" aria-label="保存名称" title="保存名称" disabled={libraryBusy}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4.8 10.6 3.4 3.4 7-7.4" /></svg></button><button type="button" onClick={() => setRenameId(null)}>取消</button>
              </form> : !multiSelect && deleteId === item.id ? <div className="panel-session-confirm">
                <span>永久删除“{item.title}”？</span>
                <button type="button" disabled={libraryBusy} onClick={() => { void libraryAction((bridge) => bridge.deleteConversation(item.id), () => { forgetParentSide(item.id); composerStash.current.delete(item.id); setDeleteId(null); }); }}>确认删除</button>
                <button type="button" onClick={() => setDeleteId(null)}>取消</button>
              </div> : <>
                <button type="button" className={`panel-session-main${multiSelect ? ' is-selecting' : ''}`} disabled={libraryBusy} aria-pressed={multiSelect ? selectedSessionIds.has(item.id) : undefined} aria-label={multiSelect ? `${selectedSessionIds.has(item.id) ? '取消选择' : '选择'} ${item.title}` : undefined} onKeyDown={(event) => { if (event.altKey && event.key === 'Enter') { event.preventDefault(); toggleSelected(item.id); } }} onClick={(event) => { if (multiSelect || event.altKey) toggleSelected(item.id); else void selectConversation(item); }}>
                  {multiSelect && <i className={`panel-session-check${selectedSessionIds.has(item.id) ? ' is-checked' : ''}`} aria-hidden="true">{selectedSessionIds.has(item.id) ? '✓' : ''}</i>}
                  <strong>{item.title}</strong><span>{item.preview || (item.archivedAt ? '点击恢复' : '暂无消息')}</span>
                </button>
                {!multiSelect && <div className="panel-session-actions">
                  {!item.archivedAt && <button type="button" aria-label={item.pinnedAt ? '取消置顶' : '置顶会话'} title={item.pinnedAt ? '取消置顶' : '置顶会话'} disabled={libraryBusy} onClick={() => { void libraryAction((bridge) => bridge.setConversationPinned(item.id, !item.pinnedAt)); }}><PinIcon pinned={Boolean(item.pinnedAt)} /></button>}
                  <button type="button" aria-label={`重命名 ${item.title}`} title="重命名" onClick={() => { setRenameId(item.id); setRenameDraft(item.title); }}><EditIcon /></button>
                  <button type="button" aria-label={`${item.archivedAt ? '恢复' : '归档'} ${item.title}`} title={statusRunning(item) ? '这个会话还在运行，结束后才能归档' : item.archivedAt ? '恢复' : '归档'} disabled={libraryBusy || statusRunning(item)} onClick={() => { void libraryAction((bridge) => item.archivedAt ? bridge.restoreConversation(item.id) : bridge.archiveConversation(item.id), () => { if (!item.archivedAt) forgetParentSide(item.id); }); }}><ArchiveIcon restore={Boolean(item.archivedAt)} /></button>
                  <button type="button" aria-label={`删除 ${item.title}`} title={statusRunning(item) ? '这个会话还在运行，结束后才能删除' : '删除'} disabled={libraryBusy || statusRunning(item)} onClick={() => setDeleteId(item.id)}><DeleteIcon /></button>
                </div>}
                {!multiSelect && <div className="panel-session-meta" aria-hidden="true">
                  <span>{modeLabels[item.mode]}</span>
                  <span>创建 {stampText(item.createdAt)}</span>
                  <span>活动 {stampText(item.lastActivityAt)}</span>
                  <span>{item.messageCount} 条消息</span>
                </div>}
              </>}
              </div>)}
            </div>)}
          </div>
          {multiSelect && <div className="panel-library-batch" aria-label="批量会话操作">
            {batchDeleteConfirm ? <>
              <span className="panel-library-batch-confirm">永久删除 {selectedVisibleIds.length} 个会话？</span>
              <button type="button" disabled={libraryBusy || selectedVisibleIds.length === 0} onClick={() => { void batchManage('delete', selectedVisibleIds); }}>删除</button>
              <button type="button" onClick={() => setBatchDeleteConfirm(false)}>取消</button>
            </> : <>
              <span className="panel-library-batch-count">已选 {selectedVisibleIds.length}</span>
              <button type="button" aria-label="全选当前列表" title="全选当前列表" disabled={libraryBusy || visibleSessionIds.length === 0} onClick={() => { setSelectedSessionIds(new Set(visibleSessionIds.slice(0, 100))); if (visibleSessionIds.length > 100) setLibraryError('一次最多选择前 100 个会话。'); }}><SelectIcon /></button>
              {!libraryArchived && <button type="button" aria-label={batchUnpin ? '取消置顶已选会话' : '置顶已选会话'} title={batchUnpin ? '取消置顶已选会话' : '置顶已选会话'} disabled={libraryBusy || selectedVisibleIds.length === 0} onClick={() => { void batchManage(batchUnpin ? 'unpin' : 'pin', selectedVisibleIds); }}><PinIcon pinned={batchUnpin} /></button>}
              <button type="button" aria-label={libraryArchived ? '恢复已选会话' : '归档已选会话'} title={libraryArchived ? '恢复已选会话' : '归档已选会话'} disabled={libraryBusy || selectedVisibleIds.length === 0} onClick={() => { void batchManage(libraryArchived ? 'restore' : 'archive', selectedVisibleIds); }}><ArchiveIcon restore={libraryArchived} /></button>
              <button type="button" aria-label="删除已选会话" title="删除已选会话" disabled={libraryBusy || selectedVisibleIds.length === 0} onClick={() => setBatchDeleteConfirm(true)}><DeleteIcon /></button>
            </>}
          </div>}
        </aside>}
        <div className="panel-chat-main">
        {sideSessionId && <div className={`panel-side-strip${sideExpanded ? ' is-expanded' : ''}`} aria-label="临时侧聊">
          {sideExpanded ? <>
            <button type="button" className="panel-side-back" aria-label="收起侧聊，返回主线" title="返回主线，侧聊继续保留" onClick={() => { void setSideExpanded(false); }}><BackIcon /><span>主线</span></button>
            <span className="panel-side-name"><i className={`panel-task-dot panel-task-dot-${sideStatus}`} aria-hidden="true" />临时侧聊</span>
            {sideChat?.queuePaused && <span className="panel-side-paused" title={sideChat.pauseReason || '发送新消息后继续处理保留的队列'}>已停止，队列保留</span>}
          </> : <button type="button" className="panel-side-chip" aria-label={`展开临时侧聊，${sideChat?.queuePaused ? '已停止，队列保留' : taskLabels[sideStatus]}`} title={sideChat?.queuePaused ? '已停止，队列保留；点击展开' : '展开临时侧聊'} onClick={() => { void setSideExpanded(true); }}><i className={`panel-task-dot panel-task-dot-${sideStatus}`} aria-hidden="true" />侧聊</button>}
          <button type="button" className="panel-side-discard" aria-label="结束并丢弃临时侧聊" title="结束临时侧聊，记录不进入会话库" onClick={() => { void discardSide(); }}>×</button>
        </div>}
        {status !== 'idle' && (
          <div className="panel-status-row">
            <span className={`panel-status panel-status-${status}`} role="status"><i />{statusLive ? <span className="panel-live-label">{taskLabels[status]}</span> : taskLabels[status]}</span>
          </div>
        )}

        <div className="panel-feed-wrap" ref={feedWrapRef}>
          <TimelineNav marks={navMarkList} onJump={jumpToEntry} windowSize={expanded ? NAV_WINDOW_WIDE : NAV_WINDOW_COMPACT} />
          <div className="panel-feed" ref={feedRef} aria-label="对话与任务时间线" onScroll={(event) => {
            const feed = event.currentTarget;
            const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 48;
            followFeedRef.current = atBottom;
            setFeedAtBottom(atBottom);
            setQuoteSelection(null);
            // Reaching the top pulls in the next stretch of older history.
            if (feed.scrollTop < 240) loadEarlier();
          }}>
            {sideExpanded && <p className="panel-side-intro">临时侧聊，记录不进入会话库</p>}
            {visibleGroups.map((group, index) => {
              if (group.kind === 'single') return <EntryItem key={group.entry.id} entry={group.entry} running={false} onOpenImage={openImageViewer} display={rowDisplay} />;
              const segments = segmentTurn(group.items);
              const isLiveTurn = index === latestTurnIndex && active;
              // 思考中：插话按顺序留在过程流里——那就是当时的现场，不提前搬走。
              // 这一轮结束、过程合并成一条之后，插话才整体抬到折叠链的上方，
              // 按条数叠成一列：折叠不被插话打断，链任何时候都能收起来。
              const { asides, flow } = isLiveTurn
                ? { asides: [] as Array<Extract<TurnSegment, { kind: 'user' }>>, flow: segments }
                : liftAsides(segments);
              // A finished turn folds everything before its final sentence into
              // one process row, so the outcome is what stays in sight; while
              // the turn runs, nothing folds — its process is the view.
              const { head, tail } = splitTurnTail(flow, isLiveTurn);
              // One reply is one box — avatar and clock once at its top, the
              // pieces listed beneath like an unordered list — so alignment is
              // structural, and none of the pieces become rail marks.
              const firstReplyId = group.items.find((item) => item.kind === 'assistant')?.id;
              // "Latest reply" is the turn's final entry itself: a mid-turn
              const runAnchor = group.items[0];
              return <div className="panel-turn" key={group.user.id}>
                <TimelineItem entry={group.user} display={rowDisplay} onAvatarMenu={sideExpanded ? undefined : (event) => showTurnMenu(event, group.user.id, turnMenuTitle(group.user), isLiveTurn)} />
                {/* 插话夹在自己的消息和这条回复之间，按条数叠成一列——它们是
                    消息，不是小鲸气泡里的东西；过程依旧整条可折叠。 */}
                {asides.length > 0 && <div className="panel-turn-asides">
                  {asides.map((segment) => <TimelineItem key={segment.entry.id} entry={segment.entry} display={rowDisplay} onOpenImage={openImageViewer} />)}
                </div>}
                {runAnchor && <article className="panel-event panel-event-assistant is-run" data-entry-id={firstReplyId ?? runAnchor.id}
                  aria-label={`${kindLabels.assistant}，${timeText(runAnchor.time)}`}>
                  <div className="panel-event-avatar" aria-hidden="true" onContextMenu={sideExpanded ? undefined : (event) => showTurnMenu(event, group.user.id, turnMenuTitle(group.user), isLiveTurn)}>
                    <AvatarGlyph kind="assistant" fallback="鲸" name={rowDisplay.avatars.assistant} />
                    {rowDisplay.showTimestamps && <time className="panel-event-time" dateTime={runAnchor.time}>{timeText(runAnchor.time)}</time>}
                  </div>
                  <div className="panel-event-body">
                    {head.length > 0 && <TurnProcess segments={head} renderEntry={renderEntry} renderNote={renderNote} />}
                    {tail.map((segment, segmentIndex) => segment.kind === 'note'
                      ? <RunParagraph key={segment.entry.id} entry={segment.entry} onOpenImage={openImageViewer} />
                      : segment.kind === 'user'
                      ? <TimelineItem key={segment.entry.id} entry={segment.entry} display={rowDisplay} onOpenImage={openImageViewer} />
                      : <WorkCluster
                          key={segment.id}
                          items={segment.items}
                          running={isLiveTurn && segmentIndex === tail.length - 1}
                          renderEntry={renderEntry}
                        />)}
                  </div>
                </article>}
                <TurnStats entries={group.items}
                  metrics={group.user.metrics ?? (index === latestTurnIndex && active ? snapshot?.taskMetrics : undefined)}
                  running={index === latestTurnIndex && active}
                  spentYuan={index === latestTurnIndex ? snapshot?.conversationSpentYuan : undefined}
                  estimatedSpendYuan={index === latestTurnIndex ? transcriptEstimateYuan : undefined}
                  showMissingUsage={index === latestTurnIndex && !active} />
              </div>;
            })}
            <WorkingIndicator sending={sendingCurrent} thinking={liveThinking} status={status} tool={runningTool} startedAt={snapshot?.taskMetrics?.startedAt} />
            {snapshot?.proposal && (
              <ApprovalCard
                proposal={snapshot.proposal}
                busy={Boolean(busy) || sendingCurrent}
                onApprove={() => { void decide(true); }}
                onReject={() => { void decide(false); }}
              />
            )}
          </div>
          {quoteSelection && <div
            className="panel-quote-bar"
            style={{ left: quoteSelection.x, top: quoteSelection.y }}
            onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
          >
            <button
              type="button"
              className="panel-quote-button"
              aria-label="引用选中内容"
              title="把选中的内容作为引用放进输入框"
              onClick={applyQuote}
            >引用</button>
            <button
              type="button"
              className="panel-quote-button"
              aria-label="复制选中内容"
              title="复制选中的内容"
              onClick={() => { void copyQuote(); }}
            >复制</button>
          </div>}
          {!feedAtBottom && !modelPickerOpen && !effortMenuOpen && !contextMenuOpen && <button
            type="button"
            className={`panel-scroll-bottom${active ? ' is-running' : ''}`}
            aria-label="回到底部"
            title={active ? '回到底部（任务运行中）' : '回到底部'}
            onClick={scrollToBottom}
          >
            {active && <svg className="panel-scroll-ring" viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="16" pathLength="100" /></svg>}
            <svg className="panel-scroll-arrow" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4.8v10.4m-4.4-4.3L10 15.3l4.4-4.4" /></svg>
          </button>}
        </div>

        {pendingMessages.length > 0 && <div className="panel-queue" aria-label="待发送消息">
          <div className="panel-queue-heading">待发送 <strong>{pendingMessages.length}</strong></div>
          <div className="panel-queue-list">{pendingMessages.map((message) => <div key={message.id} className="panel-queue-item">
            <span title={message.text}>{message.text || `附件 ${message.attachments.length} 个`}</span>
            <button type="button" aria-label={`引导：${message.text.slice(0, 20)}`} title="引导（插队发送）" onClick={() => { const id = sideExpanded ? sideSessionId : null; void run((bridge) => id ? bridge.steerSideQueuedMessage(id, message.id) : bridge.steerQueuedMessage(message.id)); }}><ReturnIcon /></button>
            <button type="button" aria-label={`修改待发送消息：${message.text.slice(0, 20)}`} title="修改" onClick={() => { void editQueuedMessage(message); }}><EditIcon /></button>
            <button type="button" aria-label={`移除待发送消息：${message.text.slice(0, 20)}`} title="从队列移除" onClick={() => { const id = sideExpanded ? sideSessionId : null; void run((bridge) => id ? bridge.removeSideQueuedMessage(id, message.id) : bridge.removeQueuedMessage(message.id)); }}>×</button>
          </div>)}</div>
        </div>}

        {!compactEmpty && <TaskStrip key={sideExpanded ? sideSessionId : library?.activeConversationId} tasks={tasks} planMode={Boolean(snapshot?.planMode)} />}

        {!compactEmpty && !sideExpanded && snapshot?.goal && <GoalBanner goal={snapshot.goal} onClear={clearGoal} />}

        <div className={`panel-compose-dock${composerOpen || composerExit.closing || ask || plan ? ' is-open' : ''}`} ref={composeDockRef}>
          {ask ? (
            <AskQuestionPanel
              key={ask.id}
              request={ask}
              onSubmit={(answers) => run((bridge) => sideExpanded && sideSessionId ? bridge.answerSideChatQuestion(sideSessionId, ask.id, answers) : bridge.answerQuestion(ask.id, answers))}
              onSkip={() => run((bridge) => sideExpanded && sideSessionId ? bridge.answerSideChatQuestion(sideSessionId, ask.id, null) : bridge.answerQuestion(ask.id, null))}
            />
          ) : plan ? (
            <PlanApprovalPanel
              key={plan.id}
              request={plan}
              onDecide={(approved) => run((bridge) => sideExpanded && sideSessionId ? bridge.answerSideChatPlan(sideSessionId, plan.id, approved) : bridge.answerPlan(plan.id, approved))}
            />
          ) : composerOpen || composerExit.closing ? (
          <form className={`panel-composer${composerOpen ? '' : ' is-closing'}`} ref={composerRef} onAnimationEnd={composerExit.endClose} onSubmit={(event) => { event.preventDefault(); void send('queue'); }} onKeyDown={(event) => {
              if (event.key === 'Escape' && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
                event.preventDefault();
                event.stopPropagation();
                if (modelPickerOpen) setModelPickerOpen(false);
                else closeComposer();
              }
            }}>
              <button type="button" className="panel-composer-collapse" aria-label="收起输入框" title="收起输入框" onClick={closeComposer}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg></button>
              {suggestionOpen && suggestionTrigger && <ComposerSuggestions kind={suggestionTrigger.kind} query={suggestionTrigger.query} items={suggestionItems} selectedIndex={suggestionSelected} loading={suggestionLoading} failed={suggestionFailed} onSelect={acceptSuggestion} />}
              {attachments.length > 0 && <div className="panel-attachments" aria-label="已添加附件"
                onMouseLeave={() => setPreviewCard(null)} onBlur={() => setPreviewCard(null)}>
                {attachments.map((attachment) => { const badge = fileBadge(attachment.name); return <span key={attachment.id} className="panel-attachment-chip" title={attachment.name}
                  onMouseEnter={(event) => showAttachmentPreview(attachment, event.currentTarget)}
                  onFocus={(event) => showAttachmentPreview(attachment, event.currentTarget)}
                  onClick={(event) => { if (!(event.target as HTMLElement).closest('button')) void openAttachmentImage(attachment); }}>
                  <i aria-hidden="true">{badge.kind}</i>
                  <span>{badge.stem}</span>
                  <button type="button" aria-label={`移除 ${attachment.name}`} onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}>×</button>
                </span>})}
              </div>}
              {previewCard && attachmentPreviews[previewCard.path] && attachments.some((item) => item.path === previewCard.path) &&
                <AttachmentPreview placement={previewCard.placement} name={previewCard.name} src={attachmentPreviews[previewCard.path]} />}
              {attachmentError && <div className="panel-attachment-error" role="status">{attachmentError}</div>}
              <div className="panel-composer-inputrow">
                <textarea
                  ref={editorRef}
                  aria-label="输入消息"
                  value={draft}
                  maxLength={8000}
                  rows={1}
                  style={{ height: composerHeight }}
                  placeholder={sideExpanded ? '在临时侧聊中提问…' : goalPrompting ? '请输入当前的目标，回车设定' : '输入消息…'}
                  aria-controls={suggestionOpen ? 'panel-composer-suggestions' : undefined}
                  aria-expanded={suggestionOpen && (suggestionLoading || suggestionItems.length > 0)}
                  aria-activedescendant={suggestionOpen && suggestionItems.length > 0 ? `panel-suggestion-${suggestionSelected}` : undefined}
                  onChange={(event) => { setDraft(event.target.value); setCaretIndex(event.target.selectionStart); setDismissedSuggestion(null); }}
                  onClick={(event) => setCaretIndex(event.currentTarget.selectionStart)}
                  onKeyUp={(event) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) setCaretIndex(event.currentTarget.selectionStart); }}
                  onPaste={(event) => {
                    const files = pastedFiles(event.clipboardData);
                    if (!files.length) return;
                    event.preventDefault();
                    void addFiles(files);
                  }}
                  onKeyDown={(event) => {
                    if (suggestionOpen && !event.nativeEvent.isComposing) {
                      if (event.key === 'Escape') {
                        event.preventDefault();
                        event.stopPropagation();
                        setDismissedSuggestion(suggestionKey);
                        return;
                      }
                      if (suggestionItems.length > 0 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                        event.preventDefault();
                        setSuggestionSelected((current) => (current + (event.key === 'ArrowDown' ? 1 : -1) + suggestionItems.length) % suggestionItems.length);
                        return;
                      }
                      if (suggestionItems.length > 0 && event.key === 'Enter' && !event.ctrlKey && !event.metaKey) {
                        event.preventDefault();
                        acceptSuggestion(suggestionItems[suggestionSelected] ?? suggestionItems[0]);
                        return;
                      }
                    }
                    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      void send(event.ctrlKey || event.metaKey ? 'steer' : 'queue');
                    }
                  }}
                />
              </div>
              <div className="panel-composer-toolbar">
                {compactEmpty && (library?.conversations.length ?? 0) > 1 && <button type="button" className="panel-tool-button panel-conversations-button" aria-label="会话库" title="会话库" onClick={openLibrary}><ConversationsIcon /></button>}
                <div className="panel-model-picker-wrap" ref={modelPickerRef}>
                  <button type="button" className="panel-model-button" aria-label="模型与上下文" title="模型与上下文" aria-haspopup="dialog" aria-expanded={modelPickerOpen} onClick={() => setModelPickerOpen((open) => !open)}>
                    <ModelIcon />
                  </button>
                  <div className={`panel-model-menu${modelPickerOpen ? ' is-open' : ''}`} role="dialog" aria-label="模型与上下文" aria-hidden={!modelPickerOpen} inert={!modelPickerOpen}
                    onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setModelPickerOpen(false); } }}>
                    <div className="panel-popover-heading">模型</div>
                    <div className="panel-model-list" role="radiogroup" aria-label="选择模型配置">
                      {sideExpanded && <div className="panel-model-empty">临时侧聊沿用开启时的模型。回到主线可切换配置。</div>}
                      {(library?.settings.modelProfiles ?? []).length === 0 &&
                        <div className="panel-model-empty">还没有模型配置——<button type="button" className="panel-model-empty-link" onClick={() => { void run((bridge) => bridge.openOnboarding()); }}>打开配置向导</button></div>}
                      {(library?.settings.modelProfiles ?? []).map((profile) => (
                        <button key={profile.id} type="button" role="radio" aria-checked={profile.id === library?.settings.activeModelProfileId}
                          className={`panel-model-pick${profile.id === library?.settings.activeModelProfileId ? ' is-active' : ''}`}
                          disabled={sideExpanded}
                          onClick={() => { void switchModelProfile(profile.id); }}>
                          <span>{profile.name}</span>{profile.id === library?.settings.activeModelProfileId && <span className="panel-model-check">✓</span>}
                        </button>))}
                      <button type="button" className="panel-model-manage" onClick={() => { void run((bridge) => bridge.openSettings()); }}>在设置中管理…</button>
                    </div>
                    {/* Both modes are plain switches; the goal switch turns the
                        composer itself into the goal prompt instead of a nested
                        input, and a running goal shows under the task strip. */}
                    <div className="panel-popover-modes">
                      <div className="panel-popover-heading">模式</div>
                      <button type="button" role="switch" aria-checked={Boolean(snapshot?.planMode)} className={`panel-mode-toggle${snapshot?.planMode ? ' is-on' : ''}`} disabled={snapshot?.mode !== 'claude_code'}
                        onClick={() => { void choosePlanMode(!snapshot?.planMode); }}>
                        <span>计划模式</span>
                        <span className="panel-mode-switch" aria-hidden="true" />
                      </button>
                      <button type="button" role="switch" aria-checked={goalPrompting || Boolean(snapshot?.goal)} className={`panel-mode-toggle${goalPrompting || snapshot?.goal ? ' is-on' : ''}`} disabled={sideExpanded || snapshot?.mode !== 'claude_code'}
                        title={goalPrompting || snapshot?.goal ? '关闭目标模式' : '打开后在输入框里写下目标并回车'}
                        onClick={toggleGoal}>
                        <span>目标模式</span>
                        <span className="panel-mode-switch" aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                </div>
                {!sideExpanded && <div className="panel-effort-wrap" ref={effortMenuRef}>
                  <button type="button" className={`panel-tool-button panel-effort-button${snapshot?.effort && snapshot.effort !== 'max' ? ' is-on' : ''}`} aria-label={`思考强度：${EFFORT_LABELS[snapshot?.effort ?? 'max']}`} aria-haspopup="dialog" aria-expanded={effortMenuOpen} title={`思考强度：${EFFORT_LABELS[snapshot?.effort ?? 'max']}`} disabled={!snapshot} onClick={() => setEffortMenuOpen((open) => !open)}>
                    <EffortIcon />
                    <span className="panel-effort-badge">{EFFORT_LABELS[snapshot?.effort ?? 'max']}</span>
                  </button>
                  <div className={`panel-effort-menu${effortMenuOpen ? ' is-open' : ''}`} role="dialog" aria-label="思考强度" aria-hidden={!effortMenuOpen} inert={!effortMenuOpen}
                    onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setEffortMenuOpen(false); } }}>
                    <div className="panel-popover-heading">思考强度</div>
                    <EffortSlider value={snapshot?.effort ?? 'max'} disabled={!snapshot} onCommit={chooseEffort} />
                  </div>
                </div>}
                <div className="panel-context-wrap" ref={contextMenuRef}>
                  <ContextMeter usage={contextUsage} compacting={contextCompacting} open={contextMenuOpen} onToggle={() => setContextMenuOpen((open) => !open)} />
                  <div className={`panel-context-menu${contextMenuOpen ? ' is-open' : ''}`} role="dialog" aria-label="上下文" aria-hidden={!contextMenuOpen} inert={!contextMenuOpen}
                    onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setContextMenuOpen(false); } }}>
                    <div className="panel-popover-heading">上下文</div>
                    {contextUsage?.status === 'available' && Number.isFinite(contextUsage.usedPercent) ? <>
                      <div className="panel-context-stat"><span>已用</span><strong>{Math.round(contextUsage.usedPercent!)}%</strong></div>
                      {contextUsage.maxTokens !== undefined && contextUsage.usedTokens !== undefined && <div className="panel-context-tokens">{contextUsage.usedTokens.toLocaleString()} / {contextUsage.maxTokens.toLocaleString()} token</div>}
                      {contextUsage.autoCompactThresholdPercent !== undefined && <div className="panel-context-tokens">自动压缩阈值 {Math.round(contextUsage.autoCompactThresholdPercent)}%</div>}
                    </> : <div className="panel-context-unknown">用量暂不可读取</div>}
                    <button type="button" className="panel-compact-button" disabled={contextCompacting || !snapshot || snapshot.mode === 'demo'} onClick={() => { void compactContext(); }}>{contextCompacting ? '压缩中…' : '压缩上下文'}</button>
                  </div>
                </div>
                <button type={active && !draft.trim() && !attachments.length ? 'button' : 'submit'} className={`panel-send${sendingCurrent ? ' is-sending' : ''}`} disabled={(!active && !draft.trim() && !attachments.length) || Boolean(busy) || sendingCurrent || !snapshot || (contextCompacting && !(active && !draft.trim() && !attachments.length))} aria-label={goalPrompting ? '设定目标' : sendingCurrent ? '发送中…' : active && !draft.trim() && !attachments.length ? '停止任务' : active ? '排队发送消息' : '发送消息'} title={goalPrompting ? '回车设定目标' : sendingCurrent ? '发送中…' : active && !draft.trim() && !attachments.length ? '停止任务' : active ? snapshot?.mode === 'claude_code' ? 'Enter 排队发送，Ctrl+Enter 插队发送' : 'Enter 排队发送，Ctrl+Enter 优先排队' : '发送消息'} onClick={active && !draft.trim() && !attachments.length ? () => { void stop(); } : undefined}>
                  {sendingCurrent ? <span className="panel-send-spinner" aria-hidden="true" /> : active && !draft.trim() && !attachments.length ? <span className="panel-stop-square" /> : <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h11m-5-5 5 5-5 5" /></svg>}
                </button>
              </div>
            </form>
          ) : (
            <button ref={composeTriggerRef} type="button" className="panel-compose-trigger" aria-label="输入消息" onClick={() => setComposerOpen(true)}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 11.5a7.5 7.5 0 0 1-7.5 7.5c-1.2 0-2.4-.3-3.4-.8L4 19l.8-4.1A7.5 7.5 0 1 1 19 11.5Z" /><path d="M9 11.5h5" /></svg>
            </button>
          )}
        </div>
        </div>

        </div>
      </section>
      {imageViewer && <button type="button" className="panel-image-viewer" aria-label={`关闭图片预览：${imageViewer.name}`} onClick={() => setImageViewer(null)}>
        <img src={imageViewer.url} alt={imageViewer.name} />
      </button>}
    </section>
  );
}
