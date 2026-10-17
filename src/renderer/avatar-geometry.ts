/** 原布局里可见内容的最高边：144px 的图片框 × 96.9% 的内容占比。图片裁掉
 *  透明边之后按这个尺寸显示，人物只会保持或变小，绝不会被放大。 */
export const AVATAR_CONTENT_SIZE = 139.5

/** 裁剪后的图片在屏幕上的显示尺寸：长边固定为 AVATAR_CONTENT_SIZE。
 *  横躺的姿势（doze）宽而不高，竖立的姿势高而不宽——两者都不会超过原尺寸。 */
export function avatarDisplaySize(naturalWidth: number, naturalHeight: number): { width: number; height: number } {
  if (!(naturalWidth > 0) || !(naturalHeight > 0)) return { width: 0, height: 0 }
  const scale = AVATAR_CONTENT_SIZE / Math.max(naturalWidth, naturalHeight)
  return { width: naturalWidth * scale, height: naturalHeight * scale }
}
