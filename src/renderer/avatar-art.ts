// 小鲸默认：项目自有透明立绘。呆毛已画入本体，待有真正分层素材时再启用摆动。
// 人设预设：统一透明 Q 版立绘；头像直接复用同一素材，避免旧头像显示成另一角色。
import { personaById } from '../shared/personas'

export const avatarBodyUrl: string | null = new URL('./assets/whale-girl-ahoge-body.png', import.meta.url).href;
export const avatarAhogeUrl: string | null = null;

const personaBodyUrls: Record<string, string> = {
  rin: new URL('./assets/personas/whale-persona-rin-body.png', import.meta.url).href,
  rem: new URL('./assets/personas/whale-persona-rem-body.png', import.meta.url).href,
  yui: new URL('./assets/personas/whale-persona-yui-body.png', import.meta.url).href,
  yukino: new URL('./assets/personas/whale-persona-yukino-body.png', import.meta.url).href
}

/** 当前人设对应的立绘、可选呆毛层与小鲸专属表情组。 */
export function avatarArtFor(personaId?: string | null): { body: string | null; ahoge: string | null; poses: boolean } {
  const preset = personaById(personaId)
  if (preset.id === 'xiaojing') return { body: avatarBodyUrl, ahoge: avatarAhogeUrl, poses: true }
  return { body: personaBodyUrls[preset.id] ?? avatarBodyUrl, ahoge: null, poses: false }
}

/** Built-in conversation avatar for a persona; null for the default. */
export function personaAvatarUrl(personaId?: string | null): string | null {
  const preset = personaById(personaId)
  if (preset.id === 'xiaojing') return null
  return personaBodyUrls[preset.id] ?? null
}
