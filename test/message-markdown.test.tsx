import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MessageMarkdown } from '../src/renderer/message-markdown';

describe('assistant message Markdown', () => {
  it('renders common formatting in the compact message view', () => {
    const html = renderToStaticMarkup(<MessageMarkdown text={'**重点**\n\n1. 第一项\n2. 第二项\n\n`code`'} />);
    expect(html).toContain('<strong>重点</strong>');
    expect(html).toContain('<ol>');
    expect(html).toContain('<code>code</code>');
  });

  it('drops raw HTML, unsafe links and external image requests', () => {
    const text = '<script>alert(1)</script>\n\n[危险链接](javascript:alert(1))\n\n![预览](https://example.com/image.png)';
    const html = renderToStaticMarkup(<MessageMarkdown text={text} />);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<img');
    expect(html).toContain('[图片：预览]');
  });

  it('keeps math as plain text while a turn streams and renders it once settled', () => {
    const streaming = renderToStaticMarkup(<MessageMarkdown text={'行内 $E=mc^2$ 未完成'} streaming />);
    expect(streaming).not.toContain('class="katex"');
    expect(streaming).toContain('$E=mc^2$');
    const settled = renderToStaticMarkup(<MessageMarkdown text={'行内 $E=mc^2$ 完成'} />);
    expect(settled).toContain('class="katex"');
  });

  it('renders inline math and multiline aligned display math locally', () => {
    const displayMath = [
      '$$',
      '\\begin{aligned}',
      'a &= b + c \\\\',
      'd &= e + f',
      '\\end{aligned}',
      '$$',
    ].join('\n');
    const html = renderToStaticMarkup(<MessageMarkdown text={`行内 $E=mc^2$\n\n${displayMath}`} />);
    expect(html).toContain('class="katex"');
    expect(html).toContain('class="katex-display"');
    expect(html).toContain('class="katex-mathml"');
    expect(html).toContain('<mtable ');
    expect(html.match(/<mtr>/g)).toHaveLength(2);
  });

  it('keeps a streaming, incomplete display formula from breaking the message', () => {
    const partial = ['前文', '', '$$', '\\begin{aligned}', 'a &='].join('\n');
    const html = renderToStaticMarkup(<MessageMarkdown text={partial} />);
    expect(html).toContain('前文');
    expect(html).toContain('aligned');
  });

  it('does not allow math markup to create external links', () => {
    const html = renderToStaticMarkup(<MessageMarkdown text={'$\\href{https://example.com}{外链}$'} />);
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('<img');
  });

  it('wraps fenced code blocks with a copy control', () => {
    const html = renderToStaticMarkup(<MessageMarkdown text={'```ts\nconst x = 1;\n```'} />);
    expect(html).toContain('class="panel-code-block"');
    expect(html).toContain('panel-code-copy');
    expect(html).toContain('aria-label="复制代码"');
    expect(html).toContain('const x = 1;');
    const inline = renderToStaticMarkup(<MessageMarkdown text={'行内 `code` 不包容器'} />);
    expect(inline).not.toContain('panel-code-block');
  });
});
