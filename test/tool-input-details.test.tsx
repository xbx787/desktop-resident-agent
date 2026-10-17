// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolInputDetails } from '../src/renderer/tool-input-details';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('ToolInputDetails', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
  });

  async function render(input: string | undefined): Promise<void> {
    await act(async () => { root.render(<ToolInputDetails input={input} />); });
  }

  it('adds no row for a missing input and leaves full input unmounted by default', async () => {
    await render(undefined);
    expect(container.innerHTML).toBe('');
    await render('  ');
    expect(container.innerHTML).toBe('');
    await render('{"command":"npm test","description":"完整说明"}');
    expect(container.querySelector('details')?.open).toBe(false);
    expect(container.querySelector('summary')?.textContent).toBe('输入参数');
    expect(container.querySelector('pre')).toBeNull();
    expect(container.textContent).not.toContain('完整说明');
  });

  it('reveals every JSON field on open and keeps the body scrollable by keyboard', async () => {
    await render('{"command":"cd src\\nls -la","description":"查看源码"}');
    const details = container.querySelector('details')!;
    await act(async () => { details.querySelector('summary')!.click(); });
    expect(details.open).toBe(true);
    const body = details.querySelector('pre')!;
    expect(body.textContent).toBe('{\n  "command": "cd src\\nls -la",\n  "description": "查看源码"\n}');
    expect(body.tabIndex).toBe(0);
    await act(async () => { details.querySelector('summary')!.click(); });
    expect(details.open).toBe(false);
  });

  it('shows non-JSON input without discarding its line breaks', async () => {
    await render('first\nsecond');
    const details = container.querySelector('details')!;
    await act(async () => { details.querySelector('summary')!.click(); });
    expect(details.querySelector('pre')?.textContent).toBe('first\nsecond');
  });
});
