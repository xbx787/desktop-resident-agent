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

  return definitions
}
