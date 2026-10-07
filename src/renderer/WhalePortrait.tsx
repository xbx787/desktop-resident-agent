import { avatarArtworkUrl } from './avatar-art';

export function WhalePortrait() {
  return (
    <div className="avatar-portrait">
      {avatarArtworkUrl && (
        <img className="avatar-artwork" src={avatarArtworkUrl} alt="" draggable={false} />
      )}
    </div>
  );
}
