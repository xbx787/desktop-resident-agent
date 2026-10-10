import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import type { AppSnapshot, BubbleLayout, ClaudeWorkflowOption, ContextUsageSnapshot, ConversationSummary, EffortLevel, ModelMode, ModelProfile, PendingMessage, PetAPI, ProposedAction, TaskMetrics, TaskStatus, TimelineEntry, UserAttachment } from '../shared/contracts';
import { isImageAttachmentName } from '../shared/image-preview';
import { EFFORT_LABELS } from '../shared/effort';
import { EffortSlider } from './effort-slider';
import { EventImages } from './event-images';
import { formatSelectionQuote } from './message-quote';
import { toolLabel } from '../shared/tool-labels';
import { AttachmentPreview, previewPlacement, type PreviewPlacement } from './attachment-preview';
import { agentTasks } from './agent-tasks';
import { splitAttachmentNote } from './attachment-note';
import { ComposerSuggestions, detectComposerTrigger, fileMention, type ComposerSuggestion } from './composer-suggestions';
import { conversationSwitchReason, pastedFileName, pastedFiles, restoreComposerState, stashComposerState, type StashedComposer } from './composer-drafts';
import { GoalBanner } from './goal-banner';
import { MessageMarkdown, writeClipboard } from './message-markdown';
import { TabContextMenu } from './tab-context-menu';
import { TaskStrip } from './task-strip';
import { AskQuestionPanel } from './ask-question';
import { PlanApprovalPanel } from './plan-approval';
import { ThinkingItem } from './thinking-item';
import { groupTimeline, sameTimelineEntry, segmentTurn, splitTurnTail, tailWindow } from './timeline-groups';
import { navMarks, NAV_WINDOW_COMPACT, NAV_WINDOW_WIDE, TimelineNav } from './timeline-nav';
import { ToolDiffBody } from './tool-diff-body';
import { ToolIcon } from './tool-icons';
import { toolArgumentPreview, toolPlanText } from './tool-arguments';
import { toolDiffPreview } from './tool-diff';
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

const kindLabels: Record<TimelineEntry['kind'], string> = {
  user: '你',
  assistant: '小鲸',
  system: '系统',
  tool: '工具',
  thinking: '思考',
};

const switchBlockLabels = { running: '当前任务运行中，暂不能切换会话', queue: '待发送消息未处理完，暂不能切换会话' } as const;

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

/** One message's body: attachment pictures, else the text — markdown for the
 *  model's own words, plain paragraphs for everyone else. Shared by the
 *  standalone rows and by the list-like pieces of a split reply. */
function MessageBody({ entry, running = false, onOpenImage }: { entry: TimelineEntry; running?: boolean; onOpenImage?: (name: string, url: string) => void }) {
  const attachmentNote = entry.kind === 'user' ? splitAttachmentNote(entry.text) : null;
  return <>
    {attachmentNote
      ? <EventImages note={attachmentNote} prompt={attachmentNote.prompt} images={entry.images} onOpen={onOpenImage ?? noopOpenImage} />
      : entry.kind === 'assistant' ? <MessageMarkdown text={entry.text} streaming={running} /> : <p>{entry.text}</p>}
  </>;
}

/** One piece of a split reply: a list-like paragraph whose dot is its own
 *  pseudo-element, so the alignment can never drift again. */
const RunParagraph = memo(function RunParagraph({ entry, onOpenImage }: { entry: TimelineEntry; onOpenImage?: (name: string, url: string) => void }) {
  return <div className="panel-run-item"><MessageBody entry={entry} onOpenImage={onOpenImage} /></div>;
});

const TimelineItem = memo(function TimelineItem({ entry, running = false, onOpenImage, display }: { entry: TimelineEntry; running?: boolean; onOpenImage?: (name: string, url: string) => void; display: RowDisplay }) {
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
  // own row; the tick stops the moment the switch appears.
  const [killable, setKillable] = useState(false);
  useEffect(() => {
    if (entry.kind !== 'tool' || !running || entry.tool?.status !== 'running') { setKillable(false); return; }
    const started = Date.parse(entry.time);
    if (!Number.isFinite(started)) return;
    const overdue = () => Date.now() - started >= KILL_AFTER_MS;
    if (overdue()) { setKillable(true); return; }
    const timer = window.setInterval(() => { if (overdue()) { setKillable(true); window.clearInterval(timer); } }, 1000);
    return () => window.clearInterval(timer);
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
      : detail ? <pre className="panel-tool-output">{detail}</pre>
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
        {killable && <button type="button" className="panel-tool-kill" aria-label="中断这个命令" title="中断这个命令"
          onClick={(event) => { event.preventDefault(); event.stopPropagation(); void petBridge().interruptTurn(); }}>×</button>}
      </summary>
      {toolOpened && body}
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
      <div className="panel-event-avatar" aria-hidden="true">
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

function fitEditorHeight(editor: HTMLTextAreaElement): number {
  editor.style.height = 'auto';
  const nextHeight = Math.min(94, editor.scrollHeight);
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

export function PanelBubble({ visible, snapshot, error, run }: PanelBubbleProps) {
  const [expanded, setExpanded] = useState(false);
  const resizePending = useRef(false);
  const [workspaceView, setWorkspaceView] = useState<'chat' | 'library'>('chat');
  const [libraryArchived, setLibraryArchived] = useState(false);
  const [libraryQuery, setLibraryQuery] = useState('');
  const [libraryResults, setLibraryResults] = useState<ConversationSummary[]>([]);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [compactBusy, setCompactBusy] = useState(false);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [tabMenu, setTabMenu] = useState<{ item: ConversationSummary; container: HTMLElement; x: number; y: number } | null>(null);
  const [draft, setDraft] = useState('');
  const [caretIndex, setCaretIndex] = useState(0);
  const [suggestionItems, setSuggestionItems] = useState<ComposerSuggestion[]>([]);
  const [suggestionSelected, setSuggestionSelected] = useState(0);
  const [suggestionLoading, setSuggestionLoading] = useState(false);
  const [suggestionFailed, setSuggestionFailed] = useState(false);
  const [dismissedSuggestion, setDismissedSuggestion] = useState<string | null>(null);
  const [busy, setBusy] = useState<'send' | 'approve' | 'reject' | 'stop' | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  // One-line fallback until fitEditorHeight measures the editor (13px * 1.45 line height + 4px padding).
  const [composerHeight, setComposerHeight] = useState(23);
  const [attachments, setAttachments] = useState<DroppedAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  // Hover previews of image chips: data URLs land here keyed by file path, so a
  // second hover (or a conversation switch and back) never re-reads the disk.
  const [attachmentPreviews, setAttachmentPreviews] = useState<Record<string, string>>({});
  const [previewCard, setPreviewCard] = useState<{ path: string; name: string; placement: PreviewPlacement } | null>(null);
  const requestedPreviews = useRef(new Set<string>());
  const composerRef = useRef<HTMLFormElement>(null);
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
  const followFeedRef = useRef(true);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const feedWrapRef = useRef<HTMLDivElement>(null);
  const openImageViewer = useCallback((name: string, url: string) => setImageViewer({ name, url }), []);
  openImageViewerRef.current = openImageViewer;
  const [quoteSelection, setQuoteSelection] = useState<{ text: string; x: number; y: number } | null>(null);
  const composerStash = useRef(new Map<string, StashedComposer<DroppedAttachment>>());
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const effortMenuRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const composeTriggerRef = useRef<HTMLButtonElement>(null);
  const voiceManagerRef = useRef<VoiceManager | null>(null);
  const submitLockRef = useRef(false);
  const workflowCacheRef = useRef<ClaudeWorkflowOption[] | null>(null);
  const library = snapshot?.conversationLibrary;
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
  const libraryRevision = library?.conversations.map((item) => `${item.id}:${item.title}:${item.archivedAt ?? ''}`).join('|') ?? '';
  const contextUsage = snapshot?.contextUsage;
  const contextCompacting = compactBusy || Boolean(snapshot?.contextCompacting);
  const recentSessions = (library?.conversations ?? []).filter((item) => !item.archivedAt).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const tabLimit = Math.max(1, Math.min(12, library?.settings.visibleConversationTabs ?? 5));
  const quickTabs = recentSessions.slice(0, tabLimit);
  const selectedSession = recentSessions.find((item) => item.id === library?.activeConversationId);
  if (selectedSession && !quickTabs.some((item) => item.id === selectedSession.id)) quickTabs.splice(Math.max(0, tabLimit - 1), 1, selectedSession);
  const suggestionTrigger = detectComposerTrigger(draft, caretIndex);
  const suggestionKey = suggestionTrigger ? `${suggestionTrigger.kind}:${suggestionTrigger.start}:${suggestionTrigger.query}` : null;
  const suggestionOpen = Boolean(suggestionKey && suggestionKey !== dismissedSuggestion && composerOpen);

  useEffect(() => {
    let bridge: PetAPI;
    try { bridge = petBridge(); } catch { return; }
    return bridge.onSlashUiAction((action) => {
      setSessionMenuOpen(false);
      if (action === 'sessions') {
        setWorkspaceView('library');
        setModelPickerOpen(false);
        setLibraryError(null);
      } else if (action === 'model') {
        setWorkspaceView('chat');
        setComposerOpen(true);
        setModelPickerOpen(true);
      } else {
        setWorkspaceView('chat');
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
    if (!suggestionOpen || suggestionTrigger?.kind !== 'workflow') workflowCacheRef.current = null;
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
    const query = suggestionTrigger.query.toLocaleLowerCase();
    if (suggestionTrigger.kind === 'workflow') {
      const fetchOptions = workflowCacheRef.current
        ? Promise.resolve(workflowCacheRef.current)
        : bridge.listClaudeWorkflows().then((options) => { workflowCacheRef.current = options; return options; });
      void fetchOptions.then((options) => {
        if (cancelled) return;
        setSuggestionItems(options.filter((option) => option.name.replace(/^\/+/, '').toLocaleLowerCase().includes(query)).slice(0, 50).map((option) => ({
          id: `${option.kind}:${option.source}:${option.name}`,
          label: `/${option.name.replace(/^\/+/, '')}`,
          detail: `${option.kind === 'skill' ? '技能' : '命令'}，${option.source === 'project' ? '项目' : String(option.source) === 'builtin' ? '内置' : '用户'}${option.description ? `，${option.description}` : ''}`,
          insertText: `/${option.name.replace(/^\/+/, '')}`,
        })));
      }).catch(() => { if (!cancelled) { setSuggestionItems([]); setSuggestionFailed(true); } }).finally(() => { if (!cancelled) setSuggestionLoading(false); });
    } else {
      timer = window.setTimeout(() => {
        void bridge.searchWorkspaceFiles(suggestionTrigger.query).then((files) => {
          if (cancelled) return;
          setSuggestionItems(files.slice(0, 8).map((file) => ({ id: file.relativePath, label: file.name, detail: file.relativePath, insertText: fileMention(file.relativePath) })));
        }).catch(() => { if (!cancelled) { setSuggestionItems([]); setSuggestionFailed(true); } }).finally(() => { if (!cancelled) setSuggestionLoading(false); });
      }, 120);
    }
    return () => { cancelled = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [suggestionKey, suggestionOpen]);

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
    try {
      void petBridge().getContextUsage().catch(() => undefined);
    } catch {
      // The static HTML preview has no desktop bridge.
    }
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick, true);
      document.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('blur', closeOnWindowBlur);
    };
  }, [modelPickerOpen, library?.activeConversationId, snapshot?.mode]);

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
    try {
      void petBridge().getContextUsage().catch(() => undefined);
    } catch {
      // The static HTML preview has no desktop bridge.
    }
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
  }, [contextMenuOpen]);

  // The meter has to be right the moment a conversation appears, not only after a
  // turn finishes: loading a conversation resets it to "unreadable", and waiting
  // for the next reply (or opening the model picker) left it blank for minutes.
  useEffect(() => {
    if (snapshot?.mode !== 'claude_code') return;
    try {
      void petBridge().getContextUsage().catch(() => undefined);
    } catch {
      // The static HTML preview has no desktop bridge.
    }
  }, [library?.activeConversationId, snapshot?.mode]);

  // A finished turn just changed the context: refresh the meter on its own
  // instead of waiting for someone to open the model picker.
  useEffect(() => {
    if (!snapshot?.taskMetrics?.finishedAt || snapshot?.mode !== 'claude_code') return;
    try {
      void petBridge().getContextUsage().catch(() => undefined);
    } catch {
      // The static HTML preview has no desktop bridge.
    }
  }, [snapshot?.taskMetrics?.finishedAt, snapshot?.mode]);

  useEffect(() => {
    if (workspaceView !== 'library' || !libraryQuery.trim()) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      try {
        void petBridge().searchConversations(libraryQuery, libraryArchived).then((results) => {
          if (!cancelled) { setLibraryResults(results); setLibraryError(null); }
        }).catch((cause: unknown) => {
          if (!cancelled) setLibraryError(cause instanceof Error ? cause.message : String(cause));
        });
      } catch (cause) {
        if (!cancelled) setLibraryError(cause instanceof Error ? cause.message : String(cause));
      }
    }, 150);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [workspaceView, libraryQuery, libraryArchived, libraryRevision]);

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
      setWorkspaceView('chat');
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
            await bridge.sendMessage(text);
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
    voiceManagerRef.current?.updateFromSnapshot(snapshot ?? {
      mode: 'demo',
      modelReady: false,
      claudeCodeReady: false,
      avatarState: 'idle',
      taskStatus: 'idle',
      timeline: [],
      timelineRevision: 0,
    });
  }, [snapshot]);

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

  async function send(strategy: 'queue' | 'steer' = 'queue') {
    if (goalPrompting) {
      const goal = draft.trim();
      if (!goal || submitLockRef.current || contextCompacting) return;
      setDraft('');
      setGoalPrompting(false);
      await sendGoal(`/goal ${goal}`);
      return;
    }
    const message = draft.trim() || (attachments.length ? '请阅读附件并帮助我。' : '');
    if (!message || submitLockRef.current || contextCompacting) return;
    const attachmentSize = attachments.reduce((sum, item) => sum + item.content.length + (item.path?.length ?? 0) + item.name.length + 100, 0);
    if (message.length + attachmentSize > 8_000) {
      setAttachmentError('消息与附件内容合计不能超过 8000 字，请移除较大的文件。');
      return;
    }
    followFeedRef.current = true;
    const sentDraft = draft;
    const sentAttachments = attachments;
    const payload = attachments.map(({ name, content, path }) => ({ name, content, path }));
    submitLockRef.current = true;
    setBusy('send');
    setDraft('');
    setAttachments([]);
    setAttachmentError(null);
    let accepted = false;
    try {
      accepted = await run((bridge) => bridge.sendMessage(message, payload, strategy));
    } finally {
      submitLockRef.current = false;
      setBusy((current) => current === 'send' ? null : current);
    }
    if (!accepted) {
      setDraft((current) => current || sentDraft);
      setAttachments((current) => current.length ? current : sentAttachments);
      setComposerOpen(true);
    }
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
    setAttachmentError(null);
    const remaining = Math.max(0, 5 - attachments.length);
    if (!remaining) { setAttachmentError('一次最多添加 5 个文件。'); return; }
    if (files.length > remaining) setAttachmentError('一次最多添加 5 个文件。');
    let bridge: PetAPI;
    try { bridge = petBridge(); }
    catch { setAttachmentError('文件服务尚未就绪。'); return; }
    const prepared = await Promise.allSettled(files.slice(0, remaining).map((file) => prepareFileAttachment(bridge, file)));
    const failed = prepared.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') setAttachmentError(failed.reason instanceof Error ? failed.reason.message : '文件读取失败。');
    setAttachments((current) => {
      const next = [...current];
      for (const result of prepared) {
        if (result.status !== 'fulfilled' || next.length >= 5) continue;
        if (!next.some((item) => item.path === result.value.path)) next.push({ id: crypto.randomUUID(), ...result.value });
      }
      return next;
    });
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
    if (snapshot?.effort === level) return;
    await run((bridge) => bridge.setEffort(level));
  }

  async function choosePlanMode(on: boolean) {
    if (Boolean(snapshot?.planMode) === on) return;
    await run((bridge) => bridge.setPlanMode(on));
  }

  /** Goal mode is the CLI's own /goal: the command starts the stop-hook loop,
   *  /goal clear ends it. The composer draft is left untouched. */
  async function sendGoal(text: string) {
    if (!snapshot || !text.trim() || submitLockRef.current) return;
    submitLockRef.current = true;
    setBusy('send');
    try {
      await run((bridge) => bridge.sendMessage(text, [], 'queue'));
    } finally {
      submitLockRef.current = false;
      setBusy((current) => current === 'send' ? null : current);
    }
  }

  /** The goal switch flips the composer into "write the goal" mode: opening
   *  closes the menu and prompts in place; closing clears a running goal, or
   *  just backs out of the prompt. */
  function toggleGoal(): void {
    if (goalPrompting) { setGoalPrompting(false); return; }
    if (snapshot?.goal) { void sendGoal('/goal clear'); return; }
    setGoalPrompting(true);
    setModelPickerOpen(false);
    setComposerOpen(true);
    requestAnimationFrame(() => editorRef.current?.focus());
  }

  async function chooseModel(mode: ModelMode) {
    const accepted = await run((bridge) => bridge.setModelMode(mode));
    if (accepted) setModelPickerOpen(false);
  }

  async function switchModelProfile(id: string): Promise<void> {
    await run((bridge) => bridge.setModelProfile(id));
  }

  async function compactContext() {
    if (compactBusy || snapshot?.contextCompacting) return;
    setCompactBusy(true);
    try {
      const accepted = await run((bridge) => bridge.compactConversation());
      if (accepted) setModelPickerOpen(false);
    } finally {
      setCompactBusy(false);
    }
  }

  function closeComposer() {
    setComposerOpen(false);
    setModelPickerOpen(false);
    requestAnimationFrame(() => composeTriggerRef.current?.focus());
  }

  async function decide(approved: boolean) {
    const id = snapshot?.proposal?.id;
    if (!id || busy) return;
    setBusy(approved ? 'approve' : 'reject');
    await run((bridge) => approved ? bridge.approveAction(id) : bridge.rejectAction(id));
    setBusy(null);
  }

  async function stop() {
    if (busy && busy !== 'send') return;
    setBusy('stop');
    voiceManagerRef.current?.stopSpeaking();
    await run((bridge) => bridge.stop());
    setBusy(null);
  }

  async function editQueuedMessage(message: PendingMessage) {
    const accepted = await run((bridge) => bridge.removeQueuedMessage(message.id));
    if (!accepted) return;
    const recalled = message.text;
    setDraft((current) => current.trim() ? `${recalled}\n\n${current}` : recalled);
    if (message.attachments.length) {
      const next = [...attachments];
      let dropped = false;
      for (const attachment of message.attachments) {
        if (next.length >= 5) { dropped = true; continue; }
        if (next.some((item) => item.name === attachment.name && (item.path ?? '') === (attachment.path ?? ''))) continue;
        next.push({ id: crypto.randomUUID(), ...attachment });
      }
      if (dropped) setAttachmentError('最多 5 个附件，部分附件未剪切回。');
      setAttachments(next);
    }
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
    setWorkspaceView('library');
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

  async function libraryAction(action: (bridge: PetAPI) => Promise<void>, onSuccess?: () => void) {
    if (libraryBusy) return;
    setLibraryBusy(true);
    setLibraryError(null);
    const accepted = await run(action);
    setLibraryBusy(false);
    if (accepted) onSuccess?.();
  }

  async function createConversation() {
    stashComposerState(composerStash.current, library?.activeConversationId, draft, attachments);
    await libraryAction((bridge) => bridge.createConversation(), () => {
      setWorkspaceView('chat');
      setDraft('');
      setAttachments([]);
      setComposerOpen(true);
    });
  }

  async function selectConversation(item: ConversationSummary) {
    stashComposerState(composerStash.current, library?.activeConversationId, draft, attachments);
    const operation = item.archivedAt === null
      ? (bridge: PetAPI) => bridge.selectConversation(item.id)
      : (bridge: PetAPI) => bridge.restoreConversation(item.id);
    await libraryAction(operation, () => {
      setWorkspaceView('chat');
      setSessionMenuOpen(false);
      const saved = restoreComposerState(composerStash.current, item.id);
      setDraft(saved.draft);
      setAttachments(saved.attachments);
      setCaretIndex(saved.draft.length);
      setAttachmentError(null);
      setComposerOpen(Boolean(saved.draft || saved.attachments.length));
    });
  }

  function tabBlockLabel(item: ConversationSummary): string | null {
    const reason = conversationSwitchReason({ running: active, queued: queuedCount, current: item.id === library?.activeConversationId });
    return reason ? switchBlockLabels[reason] : null;
  }

  async function saveRename(id: string) {
    const title = renameDraft.trim();
    if (!title) { setLibraryError('请输入会话名称。'); return; }
    await libraryAction((bridge) => bridge.renameConversation(id, title), () => setRenameId(null));
  }

  const visibleConversations = libraryQuery.trim()
    ? libraryResults
    : library?.conversations.filter((item) => (item.archivedAt !== null) === libraryArchived) ?? [];

  const status = snapshot?.proposal ? 'awaiting_approval' : snapshot?.taskStatus ?? 'idle';
  const conversationStatus = (item: ConversationSummary): TaskStatus => item.id === library?.activeConversationId ? status : item.taskStatus;
  const active = ['planning', 'awaiting_approval', 'executing', 'verifying'].includes(status);
  const statusLive = status === 'planning' || status === 'executing' || status === 'verifying';
  const queuedCount = snapshot?.pendingMessages?.length ?? 0;
  const empty = workspaceView === 'chat' && busy !== 'send' && !error && !voiceError && status === 'idle' && !snapshot?.currentTask && !snapshot?.timeline.length && !snapshot?.proposal && queuedCount === 0;
  const compactEmpty = empty && !expanded && !modelPickerOpen && !suggestionOpen;
  const layout: BubbleLayout = !compactEmpty ? 'full' : !composerOpen ? 'empty' : attachments.length ? 'composer_attachments' : 'composer';
  const compactComposerHeight = 112 + composerHeight + (attachments.length ? 26 : 0);
  // Grouping and task extraction scan the whole history; with incremental
  // snapshots an unchanged timeline keeps its identity, so these memos let
  // every render that doesn't touch the timeline reuse the last result.
  const timeline = snapshot?.timeline ?? EMPTY_TIMELINE;
  const timelineGroups = useMemo(() => groupTimeline(timeline), [timeline]);
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
  const escOwners = modelPickerOpen || effortMenuOpen || contextMenuOpen || sessionMenuOpen || Boolean(tabMenu) || suggestionOpen || renameId !== null || deleteId !== null;
  const escOwnersRef = useRef(escOwners);
  escOwnersRef.current = escOwners;

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
    <section className={`panel-bubble${compactEmpty ? ' is-empty' : ''}${expanded ? ' is-expanded' : ''}${composerOpen || ask || plan ? ' is-composing' : ''}${attachments.length ? ' has-attachments' : ''}${modelPickerOpen ? ' is-choosing-model' : ''}`} style={compactEmpty && composerOpen ? { height: compactComposerHeight } : undefined} aria-label="交互气泡" hidden={!visible} onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={(event) => {
      if (!event.dataTransfer.files.length) return;
      event.preventDefault();
      if (workspaceView !== 'chat') return;
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
        running={active}
        current={tabMenu.item.id === library?.activeConversationId}
        onRename={() => { openLibrary(); setRenameDraft(tabMenu.item.title); setRenameId(tabMenu.item.id); }}
        onArchive={() => { void libraryAction((bridge) => bridge.archiveConversation(tabMenu.item.id)); }}
        onDelete={() => { openLibrary(); setDeleteId(tabMenu.item.id); }}
        onClose={() => setTabMenu(null)}
      />}
      <section className="panel-workspace">
        {workspaceView === 'chat' ? <>
        {!compactEmpty && <header className={`panel-chat-header${expanded ? ' is-browser' : ' is-numeric'}`} ref={sessionHeaderRef}>
          <button type="button" className="panel-library-toggle" aria-label={expanded ? '会话库' : '会话菜单'} title={expanded ? '会话库' : '会话菜单'} aria-haspopup={expanded ? undefined : 'menu'} aria-expanded={expanded ? undefined : sessionMenuOpen} onClick={expanded ? openLibrary : () => setSessionMenuOpen((open) => !open)}><ConversationsIcon /></button>
          {!expanded && sessionMenuOpen && <div className="panel-session-menu" id="panel-session-menu" role="menu" aria-label="会话菜单"
            onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setSessionMenuOpen(false); } }}>
            <div className="panel-session-menu-heading">快捷会话</div>
            {quickTabs.map((item, index) => <button key={item.id} type="button" role="menuitem" aria-current={item.id === library?.activeConversationId ? 'page' : undefined} aria-disabled={libraryBusy || Boolean(tabBlockLabel(item)) || item.id === library?.activeConversationId} onContextMenu={(event) => showTabMenu(event, item)} title={tabBlockLabel(item) ?? `${item.title}，${taskLabels[conversationStatus(item)]}`} onClick={() => { if (!libraryBusy && !tabBlockLabel(item) && item.id !== library?.activeConversationId) void selectConversation(item); }}><i className={`panel-task-dot panel-task-dot-${conversationStatus(item)}`} aria-hidden="true" /><span className="panel-session-menu-number">{index + 1}</span><span className="panel-session-menu-title">{item.title}</span></button>)}
            <button type="button" role="menuitem" className="panel-session-menu-all" onClick={openLibrary}>查看全部会话</button>
          </div>}
          {quickTabs.length > 0 && <nav className="panel-quick-tabs" ref={quickTabsRef} aria-label={expanded ? '顶部会话标签' : '顶部会话数字快捷切换'}>
            {quickTabs.map((item, index) => <button key={item.id} type="button" className={`panel-quick-tab${item.id === library?.activeConversationId ? ' is-current' : ''}`} aria-label={`${index + 1}：${item.title}，${taskLabels[conversationStatus(item)]}`} aria-current={item.id === library?.activeConversationId ? 'page' : undefined} title={tabBlockLabel(item) ?? `${item.title}，${taskLabels[conversationStatus(item)]}`} aria-disabled={libraryBusy || Boolean(tabBlockLabel(item)) || item.id === library?.activeConversationId} onContextMenu={(event) => showTabMenu(event, item)} onClick={() => { if (!libraryBusy && !tabBlockLabel(item) && item.id !== library?.activeConversationId) void selectConversation(item); }}><i className={`panel-task-dot panel-task-dot-${conversationStatus(item)}`} aria-hidden="true" /><span className="panel-quick-tab-label">{expanded ? item.title : index + 1}</span></button>)}
          </nav>}
        </header>}
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
            {visibleGroups.map((group, index) => {
              if (group.kind === 'single') return <EntryItem key={group.entry.id} entry={group.entry} running={false} onOpenImage={openImageViewer} display={rowDisplay} />;
              const segments = segmentTurn(group.items);
              const isLiveTurn = index === latestTurnIndex && active;
              // A finished turn folds everything before its final sentence into
              // one process row, so the outcome is what stays in sight; while
              // the turn runs, nothing folds — its process is the view.
              const { head, tail } = splitTurnTail(segments, isLiveTurn);
              // One reply is one box — avatar and clock once at its top, the
              // pieces listed beneath like an unordered list — so alignment is
              // structural, and none of the pieces become rail marks.
              const firstReplyId = group.items.find((item) => item.kind === 'assistant')?.id;
              const runAnchor = group.items[0];
              return <div className="panel-turn" key={group.user.id}>
                <TimelineItem entry={group.user} display={rowDisplay} />
                {runAnchor && <article className="panel-event panel-event-assistant is-run" data-entry-id={firstReplyId ?? runAnchor.id}
                  aria-label={`${kindLabels.assistant}，${timeText(runAnchor.time)}`}>
                  <div className="panel-event-avatar" aria-hidden="true">
                    <AvatarGlyph kind="assistant" fallback="鲸" name={rowDisplay.avatars.assistant} />
                    {rowDisplay.showTimestamps && <time className="panel-event-time" dateTime={runAnchor.time}>{timeText(runAnchor.time)}</time>}
                  </div>
                  <div className="panel-event-body">
                    {head.length > 0 && <TurnProcess segments={head} renderEntry={renderEntry} renderNote={renderNote} />}
                    {tail.map((segment, segmentIndex) => segment.kind === 'note'
                      ? <RunParagraph key={segment.entry.id} entry={segment.entry} onOpenImage={openImageViewer} />
                      : <WorkCluster
                          key={segment.id}
                          items={segment.items}
                          running={isLiveTurn && segmentIndex === tail.length - 1}
                          renderEntry={renderEntry}
                        />)}
                  </div>
                </article>}
                <TurnStats entries={group.items} metrics={index === latestTurnIndex ? snapshot?.taskMetrics : undefined} running={index === latestTurnIndex && active} />
              </div>;
            })}
            <WorkingIndicator sending={busy === 'send'} thinking={liveThinking} status={status} tool={runningTool} startedAt={snapshot?.taskMetrics?.startedAt} />
            {snapshot?.proposal && (
              <ApprovalCard
                proposal={snapshot.proposal}
                busy={Boolean(busy)}
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

        {(snapshot?.pendingMessages?.length ?? 0) > 0 && <div className="panel-queue" aria-label="待发送消息">
          <div className="panel-queue-heading">待发送 <strong>{snapshot?.pendingMessages?.length}</strong></div>
          <div className="panel-queue-list">{snapshot?.pendingMessages?.map((message) => <div key={message.id} className="panel-queue-item">
            <span title={message.text}>{message.text || `附件 ${message.attachments.length} 个`}</span>
            <button type="button" aria-label={`引导：${message.text.slice(0, 20)}`} title="引导" onClick={() => { void run((bridge) => bridge.steerQueuedMessage(message.id)); }}><ReturnIcon /></button>
            <button type="button" aria-label={`修改待发送消息：${message.text.slice(0, 20)}`} title="修改" onClick={() => { void editQueuedMessage(message); }}><EditIcon /></button>
            <button type="button" aria-label={`移除待发送消息：${message.text.slice(0, 20)}`} title="从队列移除" onClick={() => { void run((bridge) => bridge.removeQueuedMessage(message.id)); }}>×</button>
          </div>)}</div>
        </div>}

        {!compactEmpty && <TaskStrip key={library?.activeConversationId} tasks={tasks} planMode={Boolean(snapshot?.planMode)} />}

        {!compactEmpty && snapshot?.goal && <GoalBanner goal={snapshot.goal} onClear={() => { void sendGoal('/goal clear'); }} />}

        <div className={`panel-compose-dock${composerOpen || ask || plan ? ' is-open' : ''}`}>
          {ask ? (
            <AskQuestionPanel
              key={ask.id}
              request={ask}
              onSubmit={(answers) => run((bridge) => bridge.answerQuestion(ask.id, answers))}
              onSkip={() => run((bridge) => bridge.answerQuestion(ask.id, null))}
            />
          ) : plan ? (
            <PlanApprovalPanel
              key={plan.id}
              request={plan}
              onDecide={(approved) => run((bridge) => bridge.answerPlan(plan.id, approved))}
            />
          ) : composerOpen ? (
          <form className="panel-composer" ref={composerRef} onSubmit={(event) => { event.preventDefault(); void send('queue'); }} onKeyDown={(event) => {
              if (event.key === 'Escape') {
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
                {attachments.map((attachment) => <span key={attachment.id} className="panel-attachment-chip" title={attachment.name}
                  onMouseEnter={(event) => showAttachmentPreview(attachment, event.currentTarget)}
                  onFocus={(event) => showAttachmentPreview(attachment, event.currentTarget)}
                  onClick={(event) => { if (!(event.target as HTMLElement).closest('button')) void openAttachmentImage(attachment); }}>
                  <span>{attachment.name}</span>
                  <button type="button" aria-label={`移除 ${attachment.name}`} onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}>×</button>
                </span>)}
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
                  placeholder={goalPrompting ? '请输入当前的目标，回车设定' : '输入消息…'}
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
                      {(library?.settings.modelProfiles ?? []).length === 0 &&
                        <div className="panel-model-empty">还没有模型配置——<button type="button" className="panel-model-empty-link" onClick={() => { void run((bridge) => bridge.openOnboarding()); }}>打开配置向导</button></div>}
                      {(library?.settings.modelProfiles ?? []).map((profile) => (
                        <button key={profile.id} type="button" role="radio" aria-checked={profile.id === library?.settings.activeModelProfileId}
                          className={`panel-model-pick${profile.id === library?.settings.activeModelProfileId ? ' is-active' : ''}`}
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
                      <button type="button" role="switch" aria-checked={goalPrompting || Boolean(snapshot?.goal)} className={`panel-mode-toggle${goalPrompting || snapshot?.goal ? ' is-on' : ''}`} disabled={snapshot?.mode !== 'claude_code'}
                        title={goalPrompting || snapshot?.goal ? '关闭目标模式' : '打开后在输入框里写下目标并回车'}
                        onClick={toggleGoal}>
                        <span>目标模式</span>
                        <span className="panel-mode-switch" aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                </div>
                <div className="panel-effort-wrap" ref={effortMenuRef}>
                  <button type="button" className={`panel-tool-button panel-effort-button${snapshot?.effort && snapshot.effort !== 'max' ? ' is-on' : ''}`} aria-label={`思考强度：${EFFORT_LABELS[snapshot?.effort ?? 'max']}`} aria-haspopup="dialog" aria-expanded={effortMenuOpen} title={`思考强度：${EFFORT_LABELS[snapshot?.effort ?? 'max']}`} disabled={!snapshot} onClick={() => setEffortMenuOpen((open) => !open)}>
                    <EffortIcon />
                    <span className="panel-effort-badge">{EFFORT_LABELS[snapshot?.effort ?? 'max']}</span>
                  </button>
                  <div className={`panel-effort-menu${effortMenuOpen ? ' is-open' : ''}`} role="dialog" aria-label="思考强度" aria-hidden={!effortMenuOpen} inert={!effortMenuOpen}
                    onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setEffortMenuOpen(false); } }}>
                    <div className="panel-popover-heading">思考强度</div>
                    <EffortSlider value={snapshot?.effort ?? 'max'} disabled={!snapshot} onCommit={chooseEffort} />
                  </div>
                </div>
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
                <button type={active && !draft.trim() && !attachments.length ? 'button' : 'submit'} className={`panel-send${busy === 'send' ? ' is-sending' : ''}`} disabled={(!active && !draft.trim() && !attachments.length) || Boolean(busy) || !snapshot || (contextCompacting && !(active && !draft.trim() && !attachments.length))} aria-label={goalPrompting ? '设定目标' : busy === 'send' ? '发送中…' : active && !draft.trim() && !attachments.length ? '停止任务' : active ? '排队发送消息' : '发送消息'} title={goalPrompting ? '回车设定目标' : busy === 'send' ? '发送中…' : active && !draft.trim() && !attachments.length ? '停止任务' : active ? snapshot?.mode === 'claude_code' ? 'Enter 排队发送，Ctrl+Enter 尝试介入当前任务' : 'Enter 排队发送，Ctrl+Enter 优先排队' : '发送消息'} onClick={active && !draft.trim() && !attachments.length ? () => { void stop(); } : undefined}>
                  {busy === 'send' ? <span className="panel-send-spinner" aria-hidden="true" /> : active && !draft.trim() && !attachments.length ? <span className="panel-stop-square" /> : <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h11m-5-5 5 5-5 5" /></svg>}
                </button>
              </div>
            </form>
          ) : (
            <button ref={composeTriggerRef} type="button" className="panel-compose-trigger" aria-label="输入消息" onClick={() => setComposerOpen(true)}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 11.5a7.5 7.5 0 0 1-7.5 7.5c-1.2 0-2.4-.3-3.4-.8L4 19l.8-4.1A7.5 7.5 0 1 1 19 11.5Z" /><path d="M9 11.5h5" /></svg>
            </button>
          )}
        </div>
        </> : <div className="panel-library-view">
          <header className="panel-library-header">
            <button type="button" className="panel-library-icon panel-library-back" aria-label="返回对话" title="返回对话" onClick={() => setWorkspaceView('chat')}><BackIcon /></button>
            <h2>会话</h2>
            <button type="button" className="panel-library-icon panel-library-new" disabled={libraryBusy || active || queuedCount > 0} aria-label="新建会话" title={active ? '当前任务运行中，暂不能新建会话' : queuedCount > 0 ? '待发送消息未处理完，暂不能新建会话' : '新建会话'} onClick={() => { void createConversation(); }}><PlusIcon /></button>
          </header>
          <div className="panel-library-tabs" role="tablist" aria-label="会话状态">
            <button type="button" role="tab" aria-selected={!libraryArchived} onClick={() => { setLibraryArchived(false); setLibraryResults([]); }}>未归档</button>
            <button type="button" role="tab" aria-selected={libraryArchived} onClick={() => { setLibraryArchived(true); setLibraryResults([]); }}>已归档</button>
          </div>
          <input className="panel-library-search" type="search" aria-label="搜索会话" placeholder="搜索会话与消息" value={libraryQuery} onChange={(event) => { setLibraryQuery(event.target.value); setLibraryResults([]); }} />
          {libraryError && <div className="panel-library-error" role="alert">{libraryError}</div>}
          <div className="panel-session-list" aria-label={libraryArchived ? '已归档会话' : '未归档会话'}>
            {visibleConversations.length === 0 && <div className="panel-library-empty">{libraryQuery ? '没有找到会话' : libraryArchived ? '暂无归档会话' : '开始一个新对话'}</div>}
            {visibleConversations.map((item) => <div key={item.id} className={`panel-session${library?.activeConversationId === item.id ? ' is-current' : ''}`}>
              {renameId === item.id ? <form className="panel-session-edit" onSubmit={(event) => { event.preventDefault(); void saveRename(item.id); }}>
                <input autoFocus aria-label="会话名称" maxLength={120} value={renameDraft} onChange={(event) => setRenameDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') setRenameId(null); }} />
                <button type="submit" disabled={libraryBusy}>保存</button><button type="button" onClick={() => setRenameId(null)}>取消</button>
              </form> : deleteId === item.id ? <div className="panel-session-confirm">
                <span>永久删除“{item.title}”？</span>
                <button type="button" disabled={libraryBusy} onClick={() => { void libraryAction((bridge) => bridge.deleteConversation(item.id), () => { composerStash.current.delete(item.id); setDeleteId(null); }); }}>确认删除</button>
                <button type="button" onClick={() => setDeleteId(null)}>取消</button>
              </div> : <>
                <button type="button" className="panel-session-main" disabled={libraryBusy || active || queuedCount > 0} title={tabBlockLabel(item) ?? undefined} onClick={() => { void selectConversation(item); }}>
                  <strong>{item.title}</strong><span>{item.preview || (item.archivedAt ? '点击恢复' : '暂无消息')}</span>
                </button>
                <div className="panel-session-actions">
                  {!item.archivedAt && <button type="button" aria-label={item.pinnedAt ? '取消置顶' : '置顶会话'} title={item.pinnedAt ? '取消置顶' : '置顶会话'} disabled={libraryBusy} onClick={() => { void libraryAction((bridge) => bridge.setConversationPinned(item.id, !item.pinnedAt)); }}><PinIcon pinned={Boolean(item.pinnedAt)} /></button>}
                  <button type="button" aria-label={`重命名 ${item.title}`} title="重命名" onClick={() => { setRenameId(item.id); setRenameDraft(item.title); }}><EditIcon /></button>
                  <button type="button" aria-label={`${item.archivedAt ? '恢复' : '归档'} ${item.title}`} title={active && item.id === library?.activeConversationId ? '当前任务运行中，暂不能归档' : item.archivedAt ? '恢复' : '归档'} disabled={libraryBusy || (active && item.id === library?.activeConversationId)} onClick={() => { void libraryAction((bridge) => item.archivedAt ? bridge.restoreConversation(item.id) : bridge.archiveConversation(item.id)); }}><ArchiveIcon restore={Boolean(item.archivedAt)} /></button>
                  <button type="button" aria-label={`删除 ${item.title}`} title={active && item.id === library?.activeConversationId ? '当前任务运行中，暂不能删除' : '删除'} disabled={active && item.id === library?.activeConversationId} onClick={() => setDeleteId(item.id)}><DeleteIcon /></button>
                </div>
              </>}
            </div>)}
          </div>
        </div>}
      </section>
      {imageViewer && <button type="button" className="panel-image-viewer" aria-label={`关闭图片预览：${imageViewer.name}`} onClick={() => setImageViewer(null)}>
        <img src={imageViewer.url} alt={imageViewer.name} />
      </button>}
    </section>
  );
}
