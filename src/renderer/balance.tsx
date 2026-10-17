import { useEffect, useState } from 'react';
import type { BalanceSnapshot } from '../shared/contracts';
import { getPeakStatus } from '../shared/deepseek-pricing';
import './balance.css';

interface BalanceCardProps {
  visible: boolean;
  snapshot: BalanceSnapshot | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onClose: () => void;
}

function formatNext(at: number, nextTier: 'peak' | 'off_peak'): string {
  const date = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(at));
  return `${date} 转${nextTier === 'peak' ? '峰时' : '谷时'}`;
}

export function BalanceCard({ visible, snapshot, loading, error, onRefresh, onClose }: BalanceCardProps) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!visible) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [visible]);
  if (!visible) return null;

  const peak = getPeakStatus(now);
  const checked = snapshot?.checkedAt ? new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(snapshot.checkedAt)) : null;
  const notice = error || (snapshot?.available === false ? '账户当前不可调用 API' : '');

  return (
    <aside className={`balance-peek${notice ? ' has-notice' : ''}`} aria-label="DeepSeek API 余额与峰谷时段">
      <div className="balance-header">
        <span className="balance-heading">
          <strong>DeepSeek</strong><small>余额</small>
          {/* 更新时间贴着「余额」，底行只在有提示时才占位——正常状态省下一行。 */}
          {checked && <small className="balance-updated" title="上次更新时间">{checked}</small>}
        </span>
        <div className="balance-actions">
          <button type="button" aria-label="刷新余额" title="刷新余额" disabled={loading} onClick={onRefresh}>↻</button>
          <button type="button" aria-label="收起余额卡片" title="收起" onClick={onClose}>×</button>
        </div>
      </div>
      <div className="balance-amounts" aria-live="polite">
        {snapshot?.balances.length ? snapshot.balances.map((line) => (
          <span className="balance-amount" key={line.currency}>
            <strong>{line.currency === 'CNY' ? '¥' : '$'}{line.total}</strong><small>{line.currency}</small>
          </span>
        )) : <span className="balance-placeholder">{loading ? '正在查询余额…' : '余额暂不可用'}</span>}
      </div>
      <div className="balance-period">
        <span className={`balance-period-badge balance-period-${peak.tier}`}>
          {peak.tier === 'peak' ? '峰时' : peak.tier === 'off_peak' ? '谷时' : '时段待更新'}
        </span>
        <span className="balance-next">{peak.nextChangeAt && peak.nextTier ? formatNext(peak.nextChangeAt, peak.nextTier) : '切换时间待确认'}</span>
      </div>
      {notice && <div className="balance-foot">
        <span title={error || undefined}>{notice}</span>
      </div>}
    </aside>
  );
}
