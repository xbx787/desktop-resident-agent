import type { Ref } from 'react';
import { avatarArtworkUrl } from './avatar-art';

export function WhalePortrait({ containerRef, artworkUrl }: { containerRef?: Ref<HTMLDivElement>; artworkUrl?: string | null }) {
  const src = artworkUrl ?? avatarArtworkUrl;
  return (
    <div className="avatar-portrait" ref={containerRef}>
      {src && (
        <img className="avatar-artwork" src={src} alt="" draggable={false} />
      )}
    </div>
  );
}
