import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { AppSnapshot, BubbleLayout, ModelMode, PetAPI, ProposedAction, TaskStatus, TimelineEntry } from '../shared/contracts';
import { petBridge } from './pet-state';
import { VoiceManager, type VoiceManagerPhase } from './voice-manager';
import './panel.css';

const taskLabels: Record<TaskStatus, string> = {
  idle: '待命',
  planning: '整理任务',
  awaiting_approval: '等待批准',
  executing: '正在执行',
  verifying: '验证结果',
  done: '已完成',
  failed: '执行失败',
  cancelled: '已停止',
};

const kindLabels: Record<TimelineEntry['kind'], string> = {
  user: '你',
  assistant: '潮汐',
  system: '系统',
  tool: '工具',
};

function PlusIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12" /></svg>;
}

function ModelIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 5h12M4 10h12M4 15h12" /><circle cx="7" cy="5" r="1.5" /><circle cx="12" cy="10" r="1.5" /><circle cx="9" cy="15" r="1.5" /></svg>;
}

function MicrophoneIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="7" y="2.5" width="6" height="10" rx="3" /><path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v3m-3 0h6" /></svg>;
}

interface TextAttachment { id: string; name: string; content: string }

function TimelineItem({ entry }: { entry: TimelineEntry }) {
  const parsedTime = new Date(entry.time);
  const timeLabel = Number.isNaN(parsedTime.valueOf())
    ? entry.time
    : parsedTime.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  return (
    <article className={`panel-event panel-event-${entry.kind}`}>
      <div className="panel-event-glyph" aria-hidden="true">{entry.kind === 'user' ? '你' : entry.kind === 'assistant' ? '潮' : entry.kind === 'tool' ? '◇' : '·'}</div>
      <div className="panel-event-body">
        <div className="panel-event-meta"><strong>{kindLabels[entry.kind]}</strong><time dateTime={entry.time}>{timeLabel}</time></div>
        <p>{entry.text}</p>
      </div>
    </article>
  );
}

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

interface PanelBubbleProps {
  visible: boolean;
  snapshot: AppSnapshot | null;
  error: string | null;
  run: (action: (bridge: PetAPI) => Promise<void>) => Promise<boolean>;
}

export function PanelBubble({ visible, snapshot, error, run }: PanelBubbleProps) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<'send' | 'approve' | 'reject' | 'stop' | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [attachments, setAttachments] = useState<TextAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [voicePhase, setVoicePhase] = useState<VoiceManagerPhase>('idle');
  const [voicePartial, setVoicePartial] = useState('');
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const composeTriggerRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const voiceManagerRef = useRef<VoiceManager | null>(null);

  useEffect(() => {
    if (!visible) {
      setComposerOpen(false);
      setModelPickerOpen(false);
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
          onPhaseChange: (phase) => { if (active) setVoicePhase(phase); },
          onPartial: (text) => { if (active) setVoicePartial(text); },
          onFinal: (text) => { if (active) setVoicePartial(text); },
          onError: (message) => { if (active) setVoiceError(message); },
          onRequestText: async (text) => {
            if (!active) return;
            setVoicePartial('');
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
    });
  }, [snapshot]);

  useEffect(() => {
    if (!composerOpen) return;
    const frame = requestAnimationFrame(() => editorRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [composerOpen]);

  useEffect(() => {
    const feed = feedRef.current;
    if (feed) feed.scrollTo({ top: feed.scrollHeight, behavior: 'smooth' });
  }, [snapshot?.timeline.length, snapshot?.proposal?.id]);

  async function send() {
    const message = draft.trim() || (attachments.length ? '请阅读附件并帮助我。' : '');
    if (!message || busy) return;
    const attachmentSize = attachments.reduce((sum, item) => sum + item.content.length, 0);
    if (message.length + attachmentSize > 8_000) {
      setAttachmentError('消息与附件内容合计不能超过 8000 字，请移除较大的文件。');
      return;
    }
    setBusy('send');
    const accepted = await run((bridge) => bridge.sendMessage(message, attachments.map(({ name, content }) => ({ name, content }))));
    if (accepted) {
      setDraft('');
      setAttachments([]);
      setAttachmentError(null);
      setComposerOpen(false);
    }
    setBusy(null);
  }

  async function addFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
    setAttachmentError(null);
    const next = [...attachments];
    for (const file of files) {
      if (next.length >= 5) {
        setAttachmentError('一次最多添加 5 个文本文件。');
        break;
      }
      if (file.size > 32 * 1024) {
        setAttachmentError(`${file.name} 超过 32 KB，暂时无法添加。`);
        continue;
      }
      try {
        const content = await file.text();
        if (content.length + next.reduce((sum, item) => sum + item.content.length, 0) > 7_000) {
          setAttachmentError('附件内容合计过大，请选择较小的文件。');
          continue;
        }
        next.push({ id: crypto.randomUUID(), name: file.name, content });
      } catch {
        setAttachmentError(`${file.name} 读取失败。`);
      }
    }
    setAttachments(next);
  }

  async function chooseModel(mode: ModelMode) {
    const accepted = await run((bridge) => bridge.setModelMode(mode));
    if (accepted) setModelPickerOpen(false);
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

  function toggleVoice() {
    const manager = voiceManagerRef.current;
    if (!manager || !manager.available) {
      setVoiceError('本机不支持语音功能，请使用文字输入。');
      return;
    }
    setVoiceError(null);
    if (voicePhase === 'listening') {
      manager.stop();
    } else {
      manager.stop();
      requestAnimationFrame(() => manager.start());
    }
  }

  const status = snapshot?.taskStatus ?? 'idle';
  const active = ['planning', 'awaiting_approval', 'executing', 'verifying'].includes(status);
  const empty = !error && status === 'idle' && !snapshot?.currentTask && !snapshot?.timeline.length && !snapshot?.proposal;
  const layout: BubbleLayout = !empty ? 'full' : !composerOpen ? 'empty' : modelPickerOpen ? 'composer_models' : attachments.length ? 'composer_attachments' : 'composer';

  useEffect(() => {
    try {
      void petBridge().setBubbleLayout(layout).catch(() => undefined);
    } catch {
      // The HTML preview can render before the desktop bridge exists.
    }
  }, [layout]);

  return (
    <section className={`panel-bubble${empty ? ' is-empty' : ''}${composerOpen ? ' is-composing' : ''}${attachments.length ? ' has-attachments' : ''}${modelPickerOpen ? ' is-choosing-model' : ''}`} aria-label="交互气泡" hidden={!visible}>
      <section className="panel-workspace">
        {(status !== 'idle' || snapshot?.currentTask) && (
          <div className="panel-status-row">
            <span className={`panel-status panel-status-${status}`} role="status"><i />{taskLabels[status]}</span>
            {snapshot?.currentTask && <span className="panel-current-task">{snapshot.currentTask}</span>}
            {active && <button type="button" className="panel-stop" disabled={Boolean(busy) && busy !== 'send'} onClick={() => { void stop(); }}>
              <span className="panel-stop-square" />{busy === 'stop' ? '停止中…' : '停止任务'}
            </button>}
          </div>
        )}

        {error && <div className="panel-error" role="alert">{error}</div>}
        {voiceError && <div className="panel-voice-error" role="status">{voiceError}</div>}

        <div className="panel-feed" ref={feedRef} aria-label="对话与任务时间线">
          {snapshot?.timeline.map((entry) => <TimelineItem key={entry.id} entry={entry} />)}
          {snapshot?.proposal && (
            <ApprovalCard
              proposal={snapshot.proposal}
              busy={Boolean(busy)}
              onApprove={() => { void decide(true); }}
              onReject={() => { void decide(false); }}
            />
          )}
        </div>

        <div className={`panel-compose-dock${composerOpen ? ' is-open' : ''}`}>
          {composerOpen ? (
            <form className="panel-composer" onSubmit={(event) => { event.preventDefault(); void send(); }} onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                closeComposer();
              }
            }}>
              <input ref={fileInputRef} className="panel-file-input" type="file" multiple accept=".txt,.md,.markdown,.csv,.json,.log,text/plain,text/markdown,text/csv,application/json" onChange={(event) => { void addFiles(event); }} />
              {(voicePhase === 'listening' || voicePhase === 'processing' || voicePartial) && (
                <div className="panel-voice-caption" aria-live="polite">
                  <span className={`panel-voice-dot${voicePhase === 'listening' ? ' is-active' : ''}`} aria-hidden="true" />
                  <span>{voicePhase === 'processing' ? '正在处理…' : voicePartial || '正在听…'}</span>
                </div>
              )}
              {attachments.length > 0 && <div className="panel-attachments" aria-label="已添加附件">
                {attachments.map((attachment) => <span key={attachment.id} className="panel-attachment-chip" title={attachment.name}>
                  <span>{attachment.name}</span>
                  <button type="button" aria-label={`移除 ${attachment.name}`} onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}>×</button>
                </span>)}
              </div>}
              {attachmentError && <div className="panel-attachment-error" role="status">{attachmentError}</div>}
              <div className="panel-composer-inputrow">
                <textarea
                  ref={editorRef}
                  aria-label="输入消息"
                  value={draft}
                  maxLength={2000}
                  rows={2}
                  placeholder="输入消息…"
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                />
                <button type="button" className="panel-composer-close" aria-label="收起输入" title="收起输入" onClick={closeComposer}>
                  <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg>
                </button>
              </div>
              <div className="panel-composer-toolbar">
                <button type="button" className="panel-tool-button panel-add-file" aria-label="添加文件" title="添加文本文件" onClick={() => fileInputRef.current?.click()}><PlusIcon /></button>
                <div className="panel-model-picker-wrap">
                  <button type="button" className="panel-model-button" aria-haspopup="menu" aria-expanded={modelPickerOpen} onClick={() => setModelPickerOpen((open) => !open)}>
                    <ModelIcon /><span>{snapshot?.mode === 'claude_code' ? 'Claude Code' : snapshot?.mode === 'live' ? 'DeepSeek Flash' : '演示模式'}</span>
                  </button>
                  {modelPickerOpen && <div className="panel-model-menu" role="menu" aria-label="选择模型">
                    <button type="button" role="menuitemradio" aria-checked={snapshot?.mode === 'demo'} onClick={() => { void chooseModel('demo'); }}>演示模式{snapshot?.mode === 'demo' && <span>✓</span>}</button>
                    <button type="button" role="menuitemradio" aria-checked={snapshot?.mode === 'claude_code'} disabled={!snapshot?.claudeCodeReady} title={!snapshot?.claudeCodeReady ? '需要本机 Claude Code 和 DeepSeek API Key' : undefined} onClick={() => { void chooseModel('claude_code'); }}>Claude Code · DeepSeek{snapshot?.mode === 'claude_code' && <span>✓</span>}</button>
                    <button type="button" role="menuitemradio" aria-checked={snapshot?.mode === 'live'} disabled={!snapshot?.modelReady} title={!snapshot?.modelReady ? '请先在启动环境中配置 DeepSeek API Key' : undefined} onClick={() => { void chooseModel('live'); }}>DeepSeek Flash{snapshot?.mode === 'live' && <span>✓</span>}</button>
                  </div>}
                </div>
                <button type="button" className={`panel-tool-button panel-microphone-button${voicePhase === 'listening' ? ' is-listening' : voicePhase === 'speaking' ? ' is-speaking' : ''}`} aria-label={voicePhase === 'listening' ? '停止语音输入' : voicePhase === 'speaking' ? '停止朗读' : '语音对话'} title={voicePhase === 'listening' ? '停止语音输入' : voicePhase === 'speaking' ? '停止朗读' : '语音对话'} onClick={() => { toggleVoice(); }}><MicrophoneIcon /></button>
                <button type="submit" className="panel-send" disabled={(!draft.trim() && !attachments.length) || Boolean(busy) || !snapshot} aria-label="发送消息" title="发送消息">
                  {busy === 'send' ? <span className="panel-send-spinner" /> : <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h11m-5-5 5 5-5 5" /></svg>}
                </button>
              </div>
            </form>
          ) : (
            <button ref={composeTriggerRef} type="button" className="panel-compose-trigger" aria-label="输入消息" onClick={() => setComposerOpen(true)}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 11.5a7.5 7.5 0 0 1-7.5 7.5c-1.2 0-2.4-.3-3.4-.8L4 19l.8-4.1A7.5 7.5 0 1 1 19 11.5Z" /><path d="M9 11.5h5" /></svg>
            </button>
          )}
        </div>
      </section>
    </section>
  );
}
