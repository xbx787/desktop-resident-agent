/**
 * Single source of the project-authored Arch-chan state loops.
 *
 * These motions are regression fixtures for XiaoJing's state engine. They do not
 * turn Arch-chan into a XiaoJing persona and must stay out of the persona picker.
 */

export function define({ curve, motion }) {
  const definitions = {}

  let duration = 4
  definitions.idle = motion(duration, [
    curve('ParamAngleZ', [[0, 0], [1, 1.4], [2, 0], [3, -1.4], [duration, 0]], { loop: true }),
    curve('ParamBodyAngleZ', [[0, 0], [2, 0.8], [duration, 0]], { loop: true }),
    curve('ParamBreath', [[0, 0], [2, 0.75], [duration, 0]], { loop: true }),
    curve('ParamEyeLOpen', [[0, 1], [1.55, 1], [1.63, 0], [1.72, 1], [duration, 1]], { loop: true }),
    curve('ParamEyeROpen', [[0, 1], [1.55, 1], [1.63, 0], [1.72, 1], [duration, 1]], { loop: true })
  ], { loop: true, fadeIn: 0.6, fadeOut: 0.6 })

  duration = 3
  definitions.thinking = motion(duration, [
    curve('ParamAngleZ', [[0, 0], [0.75, -3], [1.5, -2], [2.25, 2], [duration, 0]], { loop: true }),
    curve('ParamEyeBallX', [[0, 0], [0.6, 0.65], [1.8, 0.65], [duration, 0]], { loop: true }),
    curve('ParamEyeBallY', [[0, 0], [0.6, 0.4], [1.8, 0.4], [duration, 0]], { loop: true }),
    curve('ParamBrowLY', [[0, 0], [0.6, 0.35], [1.8, 0.35], [duration, 0]], { loop: true }),
    curve('ParamBrowRY', [[0, 0], [0.6, 0.35], [1.8, 0.35], [duration, 0]], { loop: true }),
    curve('ParamBodyAngleZ', [[0, 0], [0.75, -1.2], [1.5, -0.8], [2.25, 0.8], [duration, 0]], { loop: true }),
    curve('ParamEyeLOpen', [[0, 1], [2.15, 1], [2.23, 0], [2.32, 1], [duration, 1]], { loop: true }),
    curve('ParamEyeROpen', [[0, 1], [2.15, 1], [2.23, 0], [2.32, 1], [duration, 1]], { loop: true })
  ], { loop: true, fadeIn: 0.35, fadeOut: 0.35 })

  duration = 2
  definitions.working = motion(duration, [
    curve('ParamAngleX', [[0, 0], [0.5, 3], [1, 0], [1.5, -3], [duration, 0]], { loop: true }),
    curve('ParamBodyAngleX', [[0, 0], [0.5, 1.5], [1, 0], [1.5, -1.5], [duration, 0]], { loop: true }),
    curve('ParamEyeBallX', [[0, 0], [0.4, 0.35], [0.8, -0.35], [1.2, 0.35], [1.6, -0.35], [duration, 0]], { loop: true }),
    curve('ParamBrowLForm', [[0, 0], [1, 0.2], [duration, 0]], { loop: true }),
    curve('ParamBrowRForm', [[0, 0], [1, 0.2], [duration, 0]], { loop: true }),
    curve('ParamMouthForm', [[0, 0], [1, 0.15], [duration, 0]], { loop: true }),
    curve('ParamEyeLOpen', [[0, 1], [0.82, 1], [0.9, 0], [0.98, 1], [duration, 1]], { loop: true }),
    curve('ParamEyeROpen', [[0, 1], [0.82, 1], [0.9, 0], [0.98, 1], [duration, 1]], { loop: true })
  ], { loop: true, fadeIn: 0.25, fadeOut: 0.25 })

  duration = 3.2
  definitions.listening = motion(duration, [
    curve('ParamAngleZ', [[0, 0], [0.8, -1.5], [1.6, -0.8], [2.4, 1.1], [duration, 0]], { loop: true }),
    curve('ParamEyeBallX', [[0, 0], [0.8, 0.2], [1.6, 0.45], [2.4, 0.1], [duration, 0]], { loop: true }),
    curve('ParamEyeBallY', [[0, 0], [0.8, 0.08], [1.6, 0.2], [2.4, 0.05], [duration, 0]], { loop: true }),
    curve('ParamBrowLY', [[0, 0], [0.8, 0.18], [1.6, 0.28], [2.4, 0.1], [duration, 0]], { loop: true }),
    curve('ParamBrowRY', [[0, 0], [0.8, 0.18], [1.6, 0.28], [2.4, 0.1], [duration, 0]], { loop: true }),
    curve('ParamBodyAngleZ', [[0, 0], [0.8, -0.65], [1.6, -0.35], [2.4, 0.45], [duration, 0]], { loop: true }),
    curve('ParamEyeLOpen', [[0, 1], [1.35, 1], [1.43, 0], [1.53, 1], [duration, 1]], { loop: true }),
    curve('ParamEyeROpen', [[0, 1], [1.35, 1], [1.43, 0], [1.53, 1], [duration, 1]], { loop: true })
  ], { loop: true, fadeIn: 0.3, fadeOut: 0.3 })

  duration = 2.4
  definitions.speaking = motion(duration, [
    curve('ParamAngleX', [[0, 0], [0.4, 1.25], [0.8, -0.8], [1.2, 1], [1.6, -0.55], [2, 0.7], [duration, 0]], { loop: true }),
    curve('ParamBodyAngleX', [[0, 0], [0.4, 0.55], [0.8, -0.35], [1.2, 0.45], [1.6, -0.28], [2, 0.35], [duration, 0]], { loop: true }),
    curve('ParamMouthOpenY', [[0, 0.08], [0.25, 0.68], [0.5, 0.18], [0.78, 0.75], [1.05, 0.15], [1.35, 0.62], [1.65, 0.12], [1.95, 0.7], [duration, 0.08]], { loop: true }),
    curve('ParamMouthForm', [[0, 0.12], [0.6, 0.2], [1.2, 0.1], [1.8, 0.18], [duration, 0.12]], { loop: true }),
    curve('ParamBreath', [[0, 0], [0.6, 0.45], [1.2, 0.65], [1.8, 0.32], [duration, 0]], { loop: true }),
    curve('ParamEyeLOpen', [[0, 1], [1.65, 1], [1.73, 0], [1.83, 1], [duration, 1]], { loop: true }),
    curve('ParamEyeROpen', [[0, 1], [1.65, 1], [1.73, 0], [1.83, 1], [duration, 1]], { loop: true })
  ], { loop: true, fadeIn: 0.2, fadeOut: 0.2 })

  duration = 4.4
  definitions.waiting = motion(duration, [
    curve('ParamAngleY', [[0, 0], [1.1, -1.4], [2.2, 1.3], [3.3, -0.65], [duration, 0]], { loop: true }),
    curve('ParamAngleZ', [[0, 0], [1.1, 0.75], [2.2, -0.7], [3.3, 0.35], [duration, 0]], { loop: true }),
    curve('ParamEyeBallX', [[0, 0], [1.1, -0.25], [2.2, 0.25], [3.3, -0.12], [duration, 0]], { loop: true }),
    curve('ParamBodyAngleY', [[0, 0], [1.1, -0.5], [2.2, 0.5], [3.3, -0.25], [duration, 0]], { loop: true }),
    curve('ParamBodyAngleZ', [[0, 0], [1.1, 0.35], [2.2, -0.35], [3.3, 0.15], [duration, 0]], { loop: true }),
    curve('ParamBreath', [[0, 0], [1.1, 0.58], [2.2, 0.76], [3.3, 0.38], [duration, 0]], { loop: true }),
    curve('ParamEyeLOpen', [[0, 1], [2.5, 1], [2.58, 0], [2.68, 1], [duration, 1]], { loop: true }),
    curve('ParamEyeROpen', [[0, 1], [2.5, 1], [2.58, 0], [2.68, 1], [duration, 1]], { loop: true })
  ], { loop: true, fadeIn: 0.45, fadeOut: 0.45 })

  duration = 3.4
  definitions.verifying = motion(duration, [
    curve('ParamAngleY', [[0, 0], [0.85, 1.5], [1.7, 0.6], [2.55, -0.9], [duration, 0]], { loop: true }),
    curve('ParamAngleZ', [[0, 0], [0.85, -1], [1.7, -1.5], [2.55, 0.75], [duration, 0]], { loop: true }),
    curve('ParamEyeBallX', [[0, 0], [0.85, 0.55], [1.7, 0.45], [2.55, -0.3], [duration, 0]], { loop: true }),
    curve('ParamEyeBallY', [[0, 0], [0.85, -0.3], [1.7, -0.45], [2.55, -0.15], [duration, 0]], { loop: true }),
    curve('ParamBrowLY', [[0, 0], [0.85, 0.22], [1.7, 0.38], [2.55, 0.1], [duration, 0]], { loop: true }),
    curve('ParamBrowRY', [[0, 0], [0.85, 0.22], [1.7, 0.38], [2.55, 0.1], [duration, 0]], { loop: true }),
    curve('ParamBodyAngleZ', [[0, 0], [0.85, -0.45], [1.7, -0.7], [2.55, 0.32], [duration, 0]], { loop: true }),
    curve('ParamEyeLOpen', [[0, 1], [2.1, 1], [2.18, 0], [2.28, 1], [duration, 1]], { loop: true }),
    curve('ParamEyeROpen', [[0, 1], [2.1, 1], [2.18, 0], [2.28, 1], [duration, 1]], { loop: true })
  ], { loop: true, fadeIn: 0.3, fadeOut: 0.3 })

  duration = 0.9
  definitions.poke = motion(duration, [
    curve('ParamAngleZ', [[0, 0], [0.13, 2.6], [0.4, -4.2], [0.68, 0.9], [duration, 0]], { loop: false }),
    curve('ParamBodyAngleZ', [[0, 0], [0.13, 0.9], [0.4, -1.5], [0.68, 0.35], [duration, 0]], { loop: false }),
    curve('ParamEyeLSmile', [[0, 0], [0.18, 0.35], [0.5, 0.24], [duration, 0]], { loop: false }),
    curve('ParamEyeRSmile', [[0, 0], [0.18, 0.35], [0.5, 0.24], [duration, 0]], { loop: false }),
    curve('ParamMouthForm', [[0, 0], [0.18, 0.45], [0.5, 0.25], [duration, 0]], { loop: false }),
    curve('ParamCheek', [[0, 0], [0.2, 0.48], [0.56, 0.28], [duration, 0]], { loop: false })
  ], { loop: false, fadeIn: 0.08, fadeOut: 0.18 })

  return definitions
}
