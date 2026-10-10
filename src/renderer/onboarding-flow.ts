/** The wizard's step machine, kept pure so the flow is testable without a
 *  DOM: one step at a time, forward/back navigation, and the gate that keeps
 *  the user from leaving the key step empty. */

export const ONBOARDING_STEPS = ['welcome', 'register', 'key', 'test'] as const
export type OnboardingStep = typeof ONBOARDING_STEPS[number]

export function stepIndex(step: OnboardingStep): number {
  return ONBOARDING_STEPS.indexOf(step)
}

export function nextStep(step: OnboardingStep): OnboardingStep | null {
  const index = stepIndex(step)
  return index >= 0 && index < ONBOARDING_STEPS.length - 1 ? ONBOARDING_STEPS[index + 1] : null
}

export function previousStep(step: OnboardingStep): OnboardingStep | null {
  const index = stepIndex(step)
  return index > 0 ? ONBOARDING_STEPS[index - 1] : null
}

/** Which step's primary button may move forward. */
export function canAdvance(step: OnboardingStep, apiKey: string): boolean {
  if (step === 'key') return apiKey.trim().length > 0
  return true
}
