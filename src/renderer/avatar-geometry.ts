import type { AvatarSize } from '../shared/contracts'

/** 人物可见内容的最高边：小 = 当前 128px，中 = 之前的 139.5px，大 = 152px。
 *  图片裁掉透明边之后按这个尺寸显示，人物只会按档位缩放，不会意外放大。 */
export const AVATAR_CONTENT_SIZES: Record<AvatarSize, number> = {
  small: 128,
  medium: 139.5,
  large: 152
}

/** 裁剪后的图片在屏幕上的显示尺寸：长边固定为当前档位。
 *  横躺的姿势（doze）宽而不高，竖立的姿势高而不宽——两者都不会超过档位。 */
export function avatarDisplaySize(
  naturalWidth: number,
  naturalHeight: number,
  size: AvatarSize = 'small'
): { width: number; height: number } {
  if (!(naturalWidth > 0) || !(naturalHeight > 0)) return { width: 0, height: 0 }
  const scale = AVATAR_CONTENT_SIZES[size] / Math.max(naturalWidth, naturalHeight)
  return { width: naturalWidth * scale, height: naturalHeight * scale }
}
