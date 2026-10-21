import { useEffect, useRef, type Ref } from 'react';
import type { AvatarBox, AvatarSize } from '../shared/contracts';
import { avatarArtFor } from './avatar-art';
import { avatarDisplaySize } from './avatar-geometry';

export function WhalePortrait({ gestureRef, entryRef, idleRef, swapRef, ahogeRef, artworkUrl, size, personaId, onBoxChange }: {
  gestureRef?: Ref<HTMLDivElement>;
  entryRef?: Ref<HTMLDivElement>;
  idleRef?: Ref<HTMLDivElement>;
  swapRef?: Ref<HTMLDivElement>;
  ahogeRef?: Ref<HTMLImageElement>;
  artworkUrl?: string | null;
  size?: AvatarSize;
  personaId?: string | null;
  onBoxChange?: (box: AvatarBox) => void;
}) {
  const art = avatarArtFor(personaId);
  const baseRef = useRef<HTMLImageElement | null>(null);
  const lastBox = useRef<AvatarBox | null>(null);
  const changeRef = useRef(onBoxChange);
  changeRef.current = onBoxChange;

  /** The base asset alone defines the hit box. Swapping an expression must
   * never move the button, resize the BrowserWindow shape or shift a drag. */
  const sync = (): void => {
    const image = baseRef.current;
    if (!image?.naturalWidth || !image.naturalHeight) return;
    const box = avatarDisplaySize(image.naturalWidth, image.naturalHeight, size);
    document.documentElement.style.setProperty('--avatar-w', `${box.width.toFixed(2)}px`);
    document.documentElement.style.setProperty('--avatar-h', `${box.height.toFixed(2)}px`);
    const hit = image.closest('.avatar-hit-target');
    if (!hit) return;
    const rect = hit.getBoundingClientRect();
    const next = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    const previous = lastBox.current;
    if (previous && Math.abs(previous.x - next.x) < .5 && Math.abs(previous.y - next.y) < .5 &&
        Math.abs(previous.width - next.width) < .5 && Math.abs(previous.height - next.height) < .5) return;
    lastBox.current = next;
    changeRef.current?.(next);
  };
  const schedule = (): void => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(sync);
    else sync();
  };

  useEffect(() => {
    window.addEventListener('resize', schedule);
    return () => window.removeEventListener('resize', schedule);
  }, [art.body, size]);
  // A cached base image may have loaded before mount. Size and persona
  // changes still need a fresh measurement; expression changes do not.
  useEffect(() => { if (baseRef.current?.complete) schedule(); }, [art.body, size]);

  return (
    <div className="avatar-gesture" ref={gestureRef}>
      <div className="avatar-entry-motion" ref={entryRef}>
        <div className="avatar-idle-motion" ref={idleRef}>
          <div className="avatar-state-loop">
            <div className="avatar-look">
              <div className="avatar-breath">
                <div className="avatar-swap" ref={swapRef}>
                  <div className="avatar-portrait">
                    {art.body && <img ref={baseRef} className="avatar-artwork" src={art.body} alt=""
                      draggable={false} onLoad={schedule} style={{ opacity: artworkUrl ? 0 : 1 }} />}
                    {artworkUrl && <img className="avatar-artwork avatar-artwork-variant" src={artworkUrl} alt="" draggable={false} />}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
