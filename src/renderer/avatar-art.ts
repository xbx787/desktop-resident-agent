// Project-owned transparent cutout, split in two by scripts/ahoge-cut.cjs.
// The body is the artwork with the ahoge removed; the layer holds just the
// ahoge, on the same 1254² canvas so the two stack pixel-perfectly. The
// portrait renders the body as its artwork and the layer as a sibling that
// WhalePortrait (via avatar.tsx) can swing on a poke.
export const avatarBodyUrl: string | null = new URL('./assets/whale-girl-ahoge-body.png', import.meta.url).href;
export const avatarAhogeUrl: string | null = new URL('./assets/whale-girl-ahoge-layer.png', import.meta.url).href;
