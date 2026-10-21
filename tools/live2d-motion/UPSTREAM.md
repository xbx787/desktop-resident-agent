# Live2D motion tooling provenance

The curve generator in `motion-core.mjs` is a project adaptation of the motion
generation primitives from:

- Repository: <https://github.com/shinshin86/live2d-add-motion-sample-web-ui>
- Pinned commit: `e6e2df001553d59874a1cca1eabf247af2e6ea92`
- Upstream file: `tools/gen_motions.py`
- License: MIT, reproduced in `LICENSE`

Only the curve construction and metadata counting logic is adapted here. The
upstream WebUI, model copier, local server, camera recorder, and browser shell
script are intentionally not vendored. XiaoJing already has its own Electron
renderer and keeps model resources in a controlled project directory.

Project changes relative to the pinned source:

- port the dependency-free curve and validation logic to Node so the project
  never needs a separately installed Python runtime;
- expose small importable modules instead of an all-in-one CLI;
- preserve the per-state Cubism groups already used by XiaoJing;
- write the existing `motions/` output paths without editing `model3.json`;
- keep fade metadata inside each generated motion file;
- emit an empty `UserData` array for deterministic output;
- validate generated files with the separately implemented `validate.mjs`.

The bundled Arch-chan model and Live2D Cubism Core retain their own licenses;
the upstream MIT license does not cover either asset.
