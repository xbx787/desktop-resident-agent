// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WhalePortrait } from '../src/renderer/WhalePortrait';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = '';
  document.documentElement.style.removeProperty('--avatar-w');
  document.documentElement.style.removeProperty('--avatar-h');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('avatar motion geometry', () => {
  it('keeps the same hit box when idle, focus and smile sprites switch rapidly', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
    vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(1016);
    vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockReturnValue(1218);
    let complete = false;
    vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockImplementation(() => complete);
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    const root = createRoot(mount);
    const onBoxChange = vi.fn();
    const render = (artworkUrl: string | null, size: 'small' | 'medium' | 'large' = 'small') => (
      <button className="avatar-hit-target">
        <WhalePortrait personaId="xiaojing" artworkUrl={artworkUrl} size={size} onBoxChange={onBoxChange} />
      </button>
    );
    await act(async () => root.render(render(null)));
    const hit = mount.querySelector('.avatar-hit-target') as HTMLButtonElement;
    vi.spyOn(hit, 'getBoundingClientRect').mockImplementation(() => {
      const width = Number.parseFloat(document.documentElement.style.getPropertyValue('--avatar-w')) || 0;
      const height = Number.parseFloat(document.documentElement.style.getPropertyValue('--avatar-h')) || 0;
      return { x: 10, y: 20, width, height: height + 12, left: 10, top: 20,
        right: 10 + width, bottom: 32 + height, toJSON: () => ({}) } as DOMRect;
    });
    const base = mount.querySelector('.avatar-artwork:not(.avatar-artwork-variant)') as HTMLImageElement;
    complete = true;
    await act(async () => base.dispatchEvent(new Event('load')));
    expect(onBoxChange).toHaveBeenCalledTimes(1);
    const initial = onBoxChange.mock.lastCall?.[0];
    for (const src of ['focus.png', 'smile.png', 'surprise.png', null]) {
      await act(async () => root.render(render(src)));
      expect(mount.querySelector('.avatar-artwork:not(.avatar-artwork-variant)')).toBe(base);
      expect(onBoxChange).toHaveBeenCalledTimes(1);
      expect(document.documentElement.style.getPropertyValue('--avatar-w')).toBe(`${initial.width.toFixed(2)}px`);
    }
    for (const size of ['medium', 'large'] as const) {
      await act(async () => root.render(render('focus.png', size)));
      expect(onBoxChange).toHaveBeenCalledTimes(size === 'medium' ? 2 : 3);
    }
    await act(async () => root.unmount());
  });

  it('never puts a transform on the button and owns the status pulse in the avatar window', () => {
    const css = readFileSync(path.join(process.cwd(), 'src', 'renderer', 'avatar.css'), 'utf8');
    const hitRule = css.match(/\.avatar-hit-target\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(hitRule).not.toMatch(/\btransform\s*:/);
    expect(css).not.toMatch(/\.avatar-hit-target:active\s*\{[^}]*transform/);
    expect(css).not.toContain('var(--panel-pulse-p');
    expect(css).toMatch(/\.avatar-status-dot\.is-pulsing\s*\{\s*animation:\s*avatar-task-pulse/);
    for (const state of ['planning', 'executing', 'verifying', 'compacting', 'waiting']) {
      expect(css).toMatch(new RegExp(`\\.avatar-stage\\[data-task='${state}'\\] \\.avatar-state-loop \\{[^}]*animation:`));
    }
    for (const state of ['listening', 'speaking']) {
      expect(css).toMatch(new RegExp(`\\.avatar-stage\\[data-voice='${state}'\\] \\.avatar-look \\{[^}]*animation:`));
    }
    expect(css).toContain('.avatar-breath { transform-origin: 50% 100%; animation: whale-breath');
    expect(css).toContain(".avatar-stage[data-interaction='dragging'] .avatar-state-loop");
    expect(css).toContain(".avatar-stage[data-task='completed'] .avatar-success-sparkles");
  });
});
