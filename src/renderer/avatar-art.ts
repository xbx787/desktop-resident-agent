// 小鲸默认：项目自有透明立绘，拆成身体与呆毛两层（scripts/ahoge-cut.cjs）。
// 人设预设：每个代表角色一张透明立绘；没有姿势库和呆毛层，只做静态形象。
import { personaById } from '../shared/personas'

export const avatarBodyUrl: string | null = new URL('./assets/whale-girl-ahoge-body.png', import.meta.url).href;
export const avatarAhogeUrl: string | null = new URL('./assets/whale-girl-ahoge-layer.png', import.meta.url).href;

const personaBodyUrls: Record<string, string> = {
  rin: new URL('./assets/personas/whale-persona-rin-body.png', import.meta.url).href,
  rem: new URL('./assets/personas/whale-persona-rem-body.png', import.meta.url).href,
  yui: new URL('./assets/personas/whale-persona-yui-body.png', import.meta.url).href,
  yukino: new URL('./assets/personas/whale-persona-yukino-body.png', import.meta.url).href
}

const personaAvatarUrls: Record<string, string> = {
  rin: new URL('./assets/personas/whale-persona-rin-avatar.png', import.meta.url).href,
  rem: new URL('./assets/personas/whale-persona-rem-avatar.png', import.meta.url).href,
  yui: new URL('./assets/personas/whale-persona-yui-avatar.png', import.meta.url).href,
  yukino: new URL('./assets/personas/whale-persona-yukino-avatar.png', import.meta.url).href
}

/** What to render on the desktop for a persona: the body image, whether the
 *  swingable ahoge exists, and whether the nine pose sprites apply. */
export function avatarArtFor(personaId?: string | null): { body: string | null; ahoge: string | null; poses: boolean } {
  const preset = personaById(personaId)
  if (preset.id === 'xiaojing') return { body: avatarBodyUrl, ahoge: avatarAhogeUrl, poses: true }
  return { body: personaBodyUrls[preset.id] ?? avatarBodyUrl, ahoge: null, poses: false }
}

/** Built-in conversation avatar for a persona; null for the default. */
export function personaAvatarUrl(personaId?: string | null): string | null {
  const preset = personaById(personaId)
  if (preset.id === 'xiaojing') return null
  return personaAvatarUrls[preset.id] ?? null
}
