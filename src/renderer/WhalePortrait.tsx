import type { Ref } from 'react';
import { avatarAhogeUrl, avatarBodyUrl } from './avatar-art';

export function WhalePortrait({ containerRef, ahogeRef, artworkUrl }: {
  containerRef?: Ref<HTMLDivElement>;
  ahogeRef?: Ref<HTMLImageElement>;
  artworkUrl?: string | null;
}) {
  const src = artworkUrl ?? avatarBodyUrl;
  return (
    <div className="avatar-portrait" ref={containerRef}>
      {src && (
        <img className="avatar-artwork" src={src} alt="" draggable={false} />
      )}
      {/* The swingable ahoge rides only over the base artwork; pose sprites
          bring their own ahoge and hide this layer. */}
      {!artworkUrl && avatarAhogeUrl && (
        <img className="avatar-ahoge" ref={ahogeRef} src={avatarAhogeUrl} alt="" draggable={false} />
      )}
    </div>
  );
}
