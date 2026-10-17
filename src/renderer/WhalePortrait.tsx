import { useEffect, useRef, type Ref } from 'react';
import type { AvatarBox, AvatarSize } from '../shared/contracts';
import { avatarArtFor } from './avatar-art';
import { avatarDisplaySize } from './avatar-geometry';

export function WhalePortrait({ containerRef, ahogeRef, artworkUrl, size, personaId, onBoxChange }: {
  containerRef?: Ref<HTMLDivElement>;
  ahogeRef?: Ref<HTMLImageElement>;
  artworkUrl?: string | null;
  size?: AvatarSize;
  personaId?: string | null;
  onBoxChange?: (box: AvatarBox) => void;
}) {
  const art = avatarArtFor(personaId);
  const src = artworkUrl ?? art.body;
  const imageRef = useRef<HTMLImageElement | null>(null);
  const lastBox = useRef<AvatarBox | null>(null);
  const changeRef = useRef(onBoxChange);
  changeRef.current = onBoxChange;

  /** 量出裁剪后图片的可见尺寸，写进 CSS 变量，并把命中矩形报给主进程。
   *  长边不超过原可见尺寸：横躺的 doze 也不会被拉大。 */
  const sync = (): void => {
    const image = imageRef.current;
    if (!image || !image.naturalWidth || !image.naturalHeight) return;
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
  }, []);

  // 缓存命中时 onLoad 可能在挂载前就结束了；图片或大小档变化后再补量一次。
  useEffect(() => {
    if (imageRef.current?.complete) schedule();
  }, [src, size]);

  return (
    <div className="avatar-portrait" ref={containerRef}>
      {src && (
        <img ref={imageRef} className="avatar-artwork" src={src} alt="" draggable={false} onLoad={schedule} />
      )}
      {/* The swingable ahoge rides only over the base artwork; pose sprites
          bring their own ahoge and hide this layer. */}
      {!artworkUrl && art.ahoge && (
        <img className="avatar-ahoge" ref={ahogeRef} src={art.ahoge} alt="" draggable={false} />
      )}
    </div>
  );
}
