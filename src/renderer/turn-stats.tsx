import { formatYuan } from '../shared/deepseek-pricing';
import { compactTokens, tokenBreakdownRows } from './token-usage';
import { toolLabel } from '../shared/tool-labels';
import { toolArgumentPreview } from './tool-arguments';
import type { TaskMetrics, TimelineEntry } from '../shared/contracts';

function secondsLabel(seconds: number): string {
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

/** The turn's tool calls by type, most used first: [["编辑", 6], …]. Ties
 *  keep first-seen order (Map preserves insertion, sort is stable). The
 *  pieces are phrases, not a sentence — the panel spaces them out instead of
 *  gluing them with punctuation. */
export function toolCountGroups(tools: TimelineEntry[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const entry of tools) {
    const label = toolLabel(entry.tool?.name ?? '');
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/** The only calls worth spelling out: the ones that failed. */
export function toolFailures(tools: TimelineEntry[]): string[] {
  return tools
    .filter((entry) => entry.tool?.status === 'error')
    .map((entry) => {
      const label = toolLabel(entry.tool?.name ?? '');
      const preview = toolArgumentPreview(entry.tool?.input);
      return preview ? `${label} ${preview}` : label;
    });
}

/**
 * A quiet footer that closes a segment of work, Claude Code style ("Worked
 * for…"): failures, elapsed time, main-model tokens and the tool count — the
 * last two each open a hover list on focus. The tools list is one line of
 * type counts, every type carrying its own count ("编辑 ×6" "执行命令 ×12");
 * only failed calls get spelled out below it. It never folds the entries
 * above it — those stay visible on their own.
 */
export function TurnStats({ entries, metrics, running, spentYuan, estimatedSpendYuan, showMissingUsage = false }: {
  entries: TimelineEntry[]; metrics?: TaskMetrics; running: boolean; spentYuan?: number;
  estimatedSpendYuan?: number; showMissingUsage?: boolean
}) {
  const tools = entries.filter((entry) => entry.kind === 'tool');
  const toolCount = tools.length;
  const countGroups = toolCountGroups(tools);
  const failures = toolFailures(tools);
  const errorCount = failures.length;
  const started = metrics?.startedAt ? Date.parse(metrics.startedAt) : NaN;
  // While the turn runs the waiting row owns the clock (it also says what is
  // running), so this footer only carries what nothing else shows: the live
  // token count, and — once the turn settles — the frozen totals.
  const ended = metrics?.finishedAt ? Date.parse(metrics.finishedAt) : Date.now();
  const elapsedLabel = !running && Number.isFinite(started) ? secondsLabel(Math.max(0, Math.floor((ended - started) / 1000))) : null;
  const usage = metrics?.usage ?? (metrics?.usedTokens !== undefined ? { total: metrics.usedTokens } : undefined);
  const breakdown = usage ? tokenBreakdownRows(usage) : [];
  if (metrics?.spentYuan !== undefined) breakdown.push(`本轮花费 ${formatYuan(metrics.spentYuan)}`);
  else if (usage && !running) breakdown.push('本轮费用未统计');
  if (metrics?.usageSource === 'transcript_estimate') breakdown.push('从本机转录恢复的估算，非完整账单');
  // The running cost of the whole conversation belongs only to the latest
  // turn's hover tip. Older turns keep only their own settled prices.
  const showSpend = spentYuan !== undefined && spentYuan > 0;
  if (showSpend) breakdown.push(`本对话已记录 ${formatYuan(spentYuan!)}`);
  const showEstimate = estimatedSpendYuan !== undefined && estimatedSpendYuan > 0;
  if (showEstimate) breakdown.push(`转录可核对部分 ${formatYuan(estimatedSpendYuan!)}`);
  const missingUsage = showMissingUsage && !running && !usage;
  if (!toolCount && !elapsedLabel && !usage && !showSpend && !showEstimate && !missingUsage) return null;
  return <div className="panel-turn-stats" role="status">
    <span className={`panel-turn-stats-dot${running ? ' is-running' : ' is-done'}`} aria-hidden="true" />
    {elapsedLabel && <span>用时 {elapsedLabel}</span>}
    {(usage || showSpend || showEstimate || missingUsage) && <span className="panel-turn-usage" tabIndex={0} title={breakdown.length ? undefined : missingUsage ? '旧会话可能没有保存本轮用量' : '本轮主模型消耗；不含子代理和辅助调用'}>
      {usage ? `${compactTokens(usage.total)} token` : missingUsage ? '用量未记录' : formatYuan(spentYuan ?? estimatedSpendYuan!)}
      {breakdown.length > 0 && <span className="panel-turn-usage-tip" role="tooltip">
        {breakdown.map((row) => <span key={row}>{row}</span>)}
        <span className="panel-turn-usage-note">不含子代理和辅助调用</span>
      </span>}
    </span>}
    {toolCount > 0 && <span className="panel-turn-usage panel-turn-tools" tabIndex={0}>
      {toolCount} 次工具
      {errorCount > 0 && <span className="panel-turn-tools-errors">（{errorCount} 次失败）</span>}
      <span className="panel-turn-usage-tip panel-turn-tools-tip" role="tooltip">
        <span className="panel-turn-tools-count">
          {countGroups.map(([label, count]) => <span key={label}>{label} ×{count}</span>)}
        </span>
        {failures.map((line, index) => <span key={`${index}-${line}`} className="panel-turn-tools-line is-error">失败：{line}</span>)}
      </span>
    </span>}
  </div>;
}
