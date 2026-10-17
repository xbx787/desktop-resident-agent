// The current artwork is a single bust portrait: background removed by a
// border flood fill, then trimmed to the visible box. There is no separate
// ahoge layer any more (the portrait carries its own hair), so the swing
// layer is disabled; the file keeps its historical name to avoid touching
// scripts that still point at it.
export const avatarBodyUrl: string | null = new URL('./assets/whale-girl-ahoge-body.png', import.meta.url).href;
export const avatarAhogeUrl: string | null = null;
