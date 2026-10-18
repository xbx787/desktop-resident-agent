import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PROVIDER_CATALOG } from '../shared/provider-catalog';
import { apiKeyHint, normalizeApiKey } from '../shared/onboarding';
import { canAdvance, nextStep, ONBOARDING_STEPS, previousStep, stepIndex, type OnboardingStep } from './onboarding-flow';
import './onboarding.css';

interface OnboardingBridge {
  test(apiKey: string, model: string): Promise<{ ok: boolean; message: string }>;
  save(apiKey: string, model: string): Promise<void>;
  defaultWorkspace(): Promise<string>;
  pickWorkspace(): Promise<string | null>;
  setWorkspace(path: string): Promise<{ path: string }>;
  open(page: 'signup' | 'api-keys' | 'top-up'): Promise<void>;
  finish(outcome: 'completed' | 'skipped'): Promise<void>;
}

declare global {
  interface Window { whaleOnboarding?: OnboardingBridge }
}

function bridge(): OnboardingBridge {
  if (!window.whaleOnboarding) throw new Error('配置向导未连接到主进程。');
  return window.whaleOnboarding;
}

const DEEPSEEK = PROVIDER_CATALOG.find((provider) => provider.id === 'deepseek')!;
const DEFAULT_MODEL = DEEPSEEK.models[0]?.id ?? 'deepseek-flash[1m]';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Turns a failed probe into one actionable line. */
function resultTip(message: string): string {
  if (message.includes('401') || message.includes('403')) return '回到上一步检查 Key 是否复制完整。';
  if (message.includes('402')) return '账户余额不足，到充值页充值后再试。';
  if (message.includes('超时') || message.includes('无法连接')) return '检查网络或代理后重试。';
  return '';
}

function Onboarding() {
  const [step, setStep] = useState<OnboardingStep>('welcome');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [revealKey, setRevealKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [notice, setNotice] = useState('');
  const [finished, setFinished] = useState(false);
  const [workspace, setWorkspace] = useState('');
  const [workspaceBusy, setWorkspaceBusy] = useState(false);

  const hint = apiKeyHint(apiKey);

  // Start from whatever the app already resolved (the project directory in a
  // source checkout), so the common case is a single click on "下一步".
  useEffect(() => {
    let active = true;
    bridge().defaultWorkspace()
      .then((path) => { if (active) setWorkspace(path); })
      .catch(() => { /* the picker still works without a default */ });
    return () => { active = false; };
  }, []);

  function go(direction: 1 | -1): void {
    const target = direction > 0 ? nextStep(step) : previousStep(step);
    if (!target) return;
    setResult(null);
    setNotice('');
    setStep(target);
  }

  async function openPage(page: 'signup' | 'api-keys' | 'top-up'): Promise<void> {
    try { await bridge().open(page); } catch (error) { setNotice(errorText(error)); }
  }

  async function testConnection(): Promise<void> {
    if (testing || saving) return;
    setTesting(true);
    setResult(null);
    setNotice('');
    try {
      setResult(await bridge().test(normalizeApiKey(apiKey), model));
    } catch (error) {
      setResult({ ok: false, message: errorText(error) });
    } finally {
      setTesting(false);
    }
  }

  async function saveAndFinish(): Promise<void> {
    if (saving || testing) return;
    setSaving(true);
    setNotice('');
    try {
      await bridge().save(normalizeApiKey(apiKey), model);
      setFinished(true);
    } catch (error) {
      setNotice(errorText(error));
    } finally {
      setSaving(false);
    }
  }

  async function chooseWorkspace(): Promise<void> {
    if (workspaceBusy) return;
    setNotice('');
    try {
      const picked = await bridge().pickWorkspace();
      if (picked) setWorkspace(picked);
    } catch (error) {
      setNotice(errorText(error));
    }
  }

  /** Saves the directory on its own, before the key is ever involved. */
  async function saveWorkspaceAndContinue(): Promise<void> {
    if (workspaceBusy || !canAdvance('workspace', apiKey, workspace)) return;
    setWorkspaceBusy(true);
    setNotice('');
    try {
      const saved = await bridge().setWorkspace(workspace.trim());
      setWorkspace(saved.path);
      go(1);
    } catch (error) {
      setNotice(errorText(error));
    } finally {
      setWorkspaceBusy(false);
    }
  }

  /** Records the outcome (best effort — main also infers a skip from the
   *  window's close) and lets the window go. */
  async function close(outcome: 'completed' | 'skipped'): Promise<void> {
    try { await bridge().finish(outcome); } catch { /* closing is best-effort */ }
    window.close();
  }

  return (
    <main className="onboarding-shell">
      {!finished && <header className="onboarding-progress">
        {ONBOARDING_STEPS.map((item, index) => (
          <i
            key={item}
            aria-hidden="true"
            className={`onboarding-dot${stepIndex(step) >= index ? ' is-on' : ''}${step === item ? ' is-current' : ''}`}
          />
        ))}
        <span className="onboarding-step-label">第 {stepIndex(step) + 1} / {ONBOARDING_STEPS.length} 步</span>
      </header>}

      {finished ? (
        <section className="onboarding-card">
          <h1>配置完成</h1>
          <p className="onboarding-copy">现在点击桌面上的小鲸就能对话了。以后要添加 Kimi、智谱等其他模型或更换 Key，右键托盘图标 →「选项」里随时可以管理。</p>
          {workspace && <p className="onboarding-note">工作目录：<code>{workspace}</code>。之后可以在「选项 → 对话 → 工作目录」里迁移。</p>}
          <div className="onboarding-actions">
            <button type="button" className="onboarding-primary" onClick={() => { void close('completed'); }}>开始使用</button>
          </div>
        </section>
      ) : step === 'welcome' ? (
        <section className="onboarding-card">
          <h1>让小鲸即刻就能帮到你</h1>
          <ul className="onboarding-points">
            <li>小鲸通过 <strong>DeepSeek</strong> 提供的模型与你对话。</li>
            <li>需要你注册一个 DeepSeek 账号，并创建一个 API Key。</li>
            <li>全程约 2 分钟。Key 只保存在这台电脑上，只用于向 DeepSeek 发请求。</li>
          </ul>
          <div className="onboarding-actions">
            <button type="button" className="onboarding-secondary" onClick={() => { void close('skipped'); }}>稍后再说</button>
            <button type="button" className="onboarding-primary" onClick={() => go(1)}>开始配置</button>
          </div>
        </section>
      ) : step === 'register' ? (
        <section className="onboarding-card">
          <h2>注册并创建 API Key</h2>
          <ol className="onboarding-steps">
            <li>
              <p>打开 DeepSeek 开放平台，用手机号或邮箱注册 / 登录。</p>
              <button type="button" className="onboarding-link" onClick={() => { void openPage('signup'); }}>打开注册页 ↗</button>
            </li>
            <li>
              <p>登录后，在左侧菜单打开「API keys」，点「创建 API key」，起个名字（例如 xiaojing）。</p>
              <button type="button" className="onboarding-link" onClick={() => { void openPage('api-keys'); }}>打开 API keys 页 ↗</button>
            </li>
            <li>
              <p>复制生成的那串以 <code>sk-</code> 开头的字符，粘贴到下一步。</p>
            </li>
          </ol>
          <p className="onboarding-note">
            Key 只在创建时完整显示一次，请先粘贴再关闭网页。API 按量计费，账户需要少量余额；
            <button type="button" className="onboarding-inline-link" onClick={() => { void openPage('top-up'); }}>查看充值页 ↗</button>
          </p>
          <div className="onboarding-actions">
            <button type="button" className="onboarding-secondary" onClick={() => go(-1)}>上一步</button>
            <button type="button" className="onboarding-primary" onClick={() => go(1)}>我已经有 Key</button>
          </div>
        </section>
      ) : step === 'key' ? (
        <section className="onboarding-card">
          <h2>粘贴 API Key</h2>
          <div className="onboarding-key-row">
            <input
              type={revealKey ? 'text' : 'password'}
              value={apiKey}
              placeholder="sk-…"
              autoFocus
              spellCheck={false}
              onChange={(event) => { setApiKey(event.target.value); setResult(null); }}
            />
            <button type="button" className="onboarding-reveal" onClick={() => setRevealKey((current) => !current)}>
              {revealKey ? '隐藏' : '显示'}
            </button>
          </div>
          <p className={`onboarding-hint${hint === 'good' ? ' is-ok' : hint === 'suspicious' ? ' is-warn' : ''}`}>
            {hint === 'empty'
              ? '把刚才复制的 Key 粘贴到这里（Ctrl+V）'
              : hint === 'good'
                ? '格式看起来没问题'
                : '看起来不太像 DeepSeek 的 Key（通常以 sk- 开头），仍可继续'}
          </p>
          {notice && <p className="onboarding-notice">{notice}</p>}
          <div className="onboarding-actions">
            <button type="button" className="onboarding-secondary" onClick={() => go(-1)}>上一步</button>
            <button type="button" className="onboarding-primary" disabled={!canAdvance(step, apiKey)} onClick={() => go(1)}>下一步</button>
          </div>
        </section>
      ) : step === 'workspace' ? (
        <section className="onboarding-card">
          <h2>工作目录</h2>
          <p className="onboarding-copy">小鲸读写文件、搜索文件都从这个目录开始。选一个你希望它工作的文件夹。</p>
          <div className="onboarding-key-row">
            <input
              type="text"
              value={workspace}
              readOnly
              placeholder="选择一个文件夹"
              spellCheck={false}
            />
            <button type="button" className="onboarding-reveal" disabled={workspaceBusy} onClick={() => { void chooseWorkspace(); }}>
              选择…
            </button>
          </div>
          <p className="onboarding-hint">小鲸会在这个文件夹里工作，不会修改 Windows 系统设置。</p>
          {notice && <p className="onboarding-notice">{notice}</p>}
          <div className="onboarding-actions">
            <button type="button" className="onboarding-secondary" onClick={() => go(-1)}>上一步</button>
            <button type="button" className="onboarding-primary" disabled={workspaceBusy || !canAdvance(step, apiKey, workspace)} onClick={() => { void saveWorkspaceAndContinue(); }}>
              {workspaceBusy ? '保存中…' : '下一步'}
            </button>
          </div>
        </section>
      ) : (
        <section className="onboarding-card">
          <h2>测试连接</h2>
          <label className="onboarding-field">
            <span>模型</span>
            <select value={model} onChange={(event) => { setModel(event.target.value); setResult(null); }}>
              {DEEPSEEK.models.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          {result && <div className={`onboarding-result${result.ok ? ' is-ok' : ' is-error'}`}>
            <p>{result.message}</p>
            {!result.ok && resultTip(result.message) && <p className="onboarding-result-tip">{resultTip(result.message)}</p>}
          </div>}
          {notice && <p className="onboarding-notice">{notice}</p>}
          <div className="onboarding-actions">
            <button type="button" className="onboarding-secondary" onClick={() => go(-1)}>上一步</button>
            <button type="button" className="onboarding-secondary" disabled={testing || saving} onClick={() => { void testConnection(); }}>
              {testing ? '测试中…' : '测试连接'}
            </button>
            <button type="button" className="onboarding-primary" disabled={!result?.ok || saving} onClick={() => { void saveAndFinish(); }}>
              {saving ? '保存中…' : '完成配置'}
            </button>
          </div>
        </section>
      )}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<Onboarding />);
