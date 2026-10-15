import { Fragment } from 'react';
import { DEEPSEEK_PRICES_YUAN_PER_MILLION, getPeakStatus } from '../shared/deepseek-pricing';
import { compactTokens, tokenBreakdownRows, type TokenBreakdownRow, type TokenBucket } from './token-usage';
import { toolLabel } from '../shared/tool-labels';
import { toolArgumentPreview } from './tool-arguments';
import type { TaskMetrics, TimelineEntry } from '../shared/contracts';

function secondsLabel(seconds: number): string {
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

/** All money in the bill reads at the same two decimals — rows, total and
 *  notes alike — so the written sum is easy to check by hand. */
const yuanText = (value: number): string => `¥${Math.max(0, value).toFixed(2)}`;

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
  // Output speed over the turn's wall clock. Only generated tokens count —
  // the cached input is prefilled, not written — and a turn younger than a
  // second says nothing reliable about speed.
  const elapsedSeconds = Number.isFinite(started) ? Math.max(0, (ended - started) / 1000) : 0;
  const outputRate = usage?.output !== undefined && elapsedSeconds >= 1 ? usage.output / elapsedSeconds : null;
  const rateLabel = outputRate === null ? null
    : `${outputRate >= 10 ? Math.round(outputRate) : Number(outputRate.toFixed(1))} token/s`;
  const formulaRows = usage ? tokenBreakdownRows(usage) : [];
  // The charge was priced at the tier in force when the turn finished
  // (main/agent-runtime accrueSpend), so the multipliers must read the same
  // clock — otherwise a peak-priced turn could show off-peak rates.
  const priceTier = getPeakStatus(ended).tier;
  const rates = priceTier === 'unknown' ? null : DEEPSEEK_PRICES_YUAN_PER_MILLION[priceTier];
  const multiplierFor = (bucket: TokenBucket): string => {
    if (!rates) return '';
    const rate = bucket === 'hit' ? rates.cacheHit : bucket === 'miss' ? rates.cacheMiss : rates.output;
    return `×${rate}`;
  };
  // Each row's own price — token count at that row's rate — so the written sum
  // adds up to the footer total, which is accrued with the same formula.
  const subtotalFor = (row: TokenBreakdownRow): string => {
    if (!rates) return '';
    const rate = row.bucket === 'hit' ? rates.cacheHit : row.bucket === 'miss' ? rates.cacheMiss : rates.output;
    return `= ${yuanText((row.tokens * rate) / 1_000_000)}`;
  };
  const spendTotal = metrics?.spentYuan !== undefined
    ? { label: '本轮花费', amount: yuanText(metrics.spentYuan) }
    : usage && !running ? { label: '本轮费用未统计', amount: null } : null;
  // The running cost of the whole conversation belongs only to the latest
  // turn's hover tip. Older turns keep only their own settled prices.
  const showSpend = spentYuan !== undefined && spentYuan > 0;
  const showEstimate = estimatedSpendYuan !== undefined && estimatedSpendYuan > 0;
  const notes: string[] = [];
  if (showSpend) notes.push(`本对话已记录 ${yuanText(spentYuan!)}`);
  if (showEstimate) notes.push(`转录可核对部分 ${yuanText(estimatedSpendYuan!)}`);
  const hasTip = formulaRows.length > 0 || spendTotal !== null || notes.length > 0;
  const missingUsage = showMissingUsage && !running && !usage;
  if (!toolCount && !elapsedLabel && !usage && !showSpend && !showEstimate && !missingUsage) return null;
  return <div className="panel-turn-stats" role="status">
    <span className={`panel-turn-stats-dot${running ? ' is-running' : ' is-done'}`} aria-hidden="true" />
    {elapsedLabel && <span>用时 {elapsedLabel}</span>}
    {(usage || showSpend || showEstimate || missingUsage) && <span className="panel-turn-usage" tabIndex={0} title={hasTip ? undefined : missingUsage ? '旧会话可能没有保存本轮用量' : '本轮主模型消耗；不含子代理和辅助调用'}>
      {usage ? `${compactTokens(usage.total)} token${rateLabel ? `（${rateLabel}）` : ''}` : missingUsage ? '用量未记录' : yuanText(spentYuan ?? estimatedSpendYuan!)}
      {hasTip && <span className="panel-turn-usage-tip" role="tooltip">
        {formulaRows.length > 0 && <span className="panel-turn-formula">
          {formulaRows.map((row) => (
            <Fragment key={row.label}>
              <span>{row.label}</span>
              <span className="panel-turn-formula-amount">{row.amount}</span>
              <span className="panel-turn-formula-mult">{multiplierFor(row.bucket)}</span>
              <span className="panel-turn-formula-sub">{subtotalFor(row)}</span>
            </Fragment>
          ))}
        </span>}
        {spendTotal && <span className="panel-turn-usage-total">
          <span>{spendTotal.label}</span>
          {spendTotal.amount !== null && <span className="panel-turn-usage-total-amount">{spendTotal.amount}</span>}
        </span>}
        {notes.map((row) => <span key={row}>{row}</span>)}
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
