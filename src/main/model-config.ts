export function getEnabledDeepSeekKey(env: NodeJS.ProcessEnv): string | undefined {
  if (env.DESKTOP_PET_ENABLE_DEEPSEEK !== '1') return undefined
  return env.DEEPSEEK_API_KEY?.trim() || undefined
}
