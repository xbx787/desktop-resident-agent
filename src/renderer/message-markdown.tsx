import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import Markdown, { type Components } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import 'katex/dist/katex.min.css';
import { fittedFontSize } from './formula-fit';
import { petBridge } from './pet-state';

function safeMarkdownUrl(value: string): string {
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

function nodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (node && typeof node === 'object' && 'props' in node) {
    return nodeText((node as { props: { children?: ReactNode } }).props.children);
  }
  return '';
}

export async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const copied = document.execCommand('copy');
      area.remove();
      return copied;
    } catch {
      return false;
    }
  }
}

function CopyCodeButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(resetTimer.current), []);
  async function copy() {
    if (!await writeClipboard(text)) return;
    setCopied(true);
    window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setCopied(false), 1600);
  }
  return <button type="button" className={`panel-code-copy${copied ? ' is-copied' : ''}`} aria-label={copied ? '代码已复制' : '复制代码'} title={copied ? '已复制' : '复制代码'} onClick={() => { void copy(); }}>
    {copied
      ? <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 10.5 3.2 3.2 6.8-7" /></svg>
      : <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="7.5" y="7.5" width="8" height="8" rx="1.5" /><path d="M12.5 4.5H6a1.5 1.5 0 0 0-1.5 1.5v6.5" /></svg>}
  </button>;
}

const components: Components = {
  // Message text should never trigger a remote image request.
  img: ({ alt }) => <span className="panel-markdown-image">{alt ? `[图片：${alt}]` : '[图片]'}</span>,
  a: ({ href, children }) => href
    ? <a href={href} title={href} onClick={(event) => {
        event.preventDefault();
        try { void petBridge().openExternal(href).catch(() => undefined); } catch { /* Static preview has no desktop bridge. */ }
      }}>{children}</a>
    : <span>{children}</span>,
  pre: ({ children }) => <div className="panel-code-block"><CopyCodeButton text={nodeText(children)} /><pre>{children}</pre></div>,
};

// Memoized on purpose: a streaming turn re-renders the panel on every published update,
// and re-parsing the whole conversation's Markdown each time costs tens of milliseconds
// per update. Only the message whose text changed is parsed again.
// While a turn streams, math stays plain text (`$…$` shown verbatim): a formula
// that is still arriving would render half-parsed and re-flow on every delta.
// The plugins come back once the turn settles and the text is final.
export const MessageMarkdown = memo(function MessageMarkdown({ text, streaming = false, breaks = false }: { text: string; streaming?: boolean; breaks?: boolean }) {
  const rootRef = useRef<HTMLDivElement>(null);
  // A block formula wider than its box (the compact bubble, a nested thinking
  // row) shrinks toward the available width instead of growing a horizontal
  // scrollbar; a width change re-fits every formula. The size is reset before
  // each measurement so the overflow is real, not yesterday's shrink. While a
  // turn streams there is no rendered math, so the pass is a no-op.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const fit = () => {
      for (const display of root.querySelectorAll<HTMLElement>('.katex-display')) {
        display.style.fontSize = '';
        const base = Number.parseFloat(getComputedStyle(display).fontSize);
        const size = fittedFontSize(base, display.clientWidth, display.scrollWidth);
        if (size < base) display.style.fontSize = `${size}px`;
      }
    };
    fit();
    // Static previews and DOM-less test environments have no ResizeObserver;
    // the one-shot pass above already did what it could.
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(fit);
    observer.observe(root);
    return () => observer.disconnect();
  }, [text, streaming]);
  return (
    <div className="panel-markdown" ref={rootRef}>
      <Markdown
        remarkPlugins={streaming
          ? [remarkGfm]
          : breaks ? [remarkGfm, remarkMath, remarkBreaks] : [remarkGfm, remarkMath]}
        rehypePlugins={streaming ? [] : [[rehypeKatex, { trust: false, strict: 'ignore', errorColor: '#bdd7ff' }]]}
        skipHtml
        urlTransform={safeMarkdownUrl}
        components={components}
      >
        {text}
      </Markdown>
    </div>
  );
});
