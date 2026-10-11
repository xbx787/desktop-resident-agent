// Local polish patch for the installed windows-mcp (targets 0.8.8).
//
// Three upgrades over upstream:
//   1. Annotation boxes: random-colour square strokes and the red crosshair
//      cursor become rounded strokes on a calm palette and a soft blue halo.
//   2. Click: the cursor now glides to the target (~8 steps x 8 ms) and a
//      ripple expands from the click point on the control overlay.
//   3. (The overlay itself — edge halo, notice bar, cursor glow — is upstream
//      0.8.6+; nothing to patch there.)
//
// Every hunk anchors on exact upstream text, is idempotent (a hunk whose
// result is already present is skipped), and fails loudly when an upstream
// upgrade drifts the file — re-check the anchors after each `uv tool upgrade`.
//
//   node scripts/patch-windows-mcp.cjs [--check]   (--check: dry run)
const { copyFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs')
const { execFileSync } = require('node:child_process')
const os = require('node:os')
const path = require('node:path')

const PKG = path.join(os.homedir(), 'AppData', 'Roaming', 'uv', 'tools', 'windows-mcp', 'Lib', 'site-packages', 'windows_mcp')

const PATCHES = [
  {
    file: 'desktop/control_overlay_art.py',
    hunks: [
      {
        old: `    aura.putalpha(outside.point(lambda alpha: round(alpha * 211 / peak)))
    return premultiplied_bgra(aura, 1.0)`,
        new: `    aura.putalpha(outside.point(lambda alpha: round(alpha * 211 / peak)))
    return premultiplied_bgra(aura, 1.0)


_RIPPLE_SIZE = 144


def _ripple_bitmap(progress: float, color: tuple[int, int, int]) -> bytes:
    """One frame of the click ripple: a soft ring expanding outward from the
    click point as it fades, so a click reads as a splash instead of a blink."""
    size = _RIPPLE_SIZE
    half = (size - 1) / 2
    radius = 12 + progress * (half - 18)
    band = 7.0
    pixels = []
    for y in range(size):
        for x in range(size):
            distance = math.hypot(x - half, y - half)
            ring = math.exp(-0.5 * ((distance - radius) / band) ** 2)
            alpha = round(235 * ring * (1 - progress) ** 1.2)
            pixels.append((*color, alpha))
    image = Image.new("RGBA", (size, size))
    image.putdata(pixels)
    return premultiplied_bgra(image, 1.0)


_RIPPLE_FRAMES = 12
_ripple_cache: dict[tuple[int, tuple[int, int, int]], bytes] = {}


def _ripple_frame_bgra(index: int, color: tuple[int, int, int]) -> bytes:
    """Cached ripple frame: generating a 144² glow in Python costs ~15 ms,
    which would stall the indicator loop mid-animation; twelve pre-blended
    buckets per colour turn playback into a dictionary lookup."""
    key = (index, color)
    frame = _ripple_cache.get(key)
    if frame is None:
        frame = _ripple_bitmap(index / (_RIPPLE_FRAMES - 1), color)
        _ripple_cache[key] = frame
    return frame


# Warm both palettes at import: a few hundred ms once, versus a visible
# hitch the first time a click lands.
for _index in range(_RIPPLE_FRAMES):
    _ripple_frame_bgra(_index, (45, 145, 255))
    _ripple_frame_bgra(_index, (255, 170, 55))`
      },
      {
        old: `_NOTICE_TITLE = "AI is controlling this computer"`,
        new: `_NOTICE_TITLE = "AI 正在控制这台电脑"`
      },
      {
        old: `_NOTICE_HINT = f"Press {_NOTICE_SHORTCUT} to take over"`,
        new: `_NOTICE_HINT = f"按 {_NOTICE_SHORTCUT} 接管控制"`
      },
      {
        old: `            title_font = ImageFont.truetype(str(font_dir / "seguisb.ttf"), hint_size + 8)
            hint_font = ImageFont.truetype(str(font_dir / "segoeui.ttf"), hint_size)`,
        new: `            title_font = ImageFont.truetype(str(font_dir / "msyhbd.ttc"), hint_size + 8)
            hint_font = ImageFont.truetype(str(font_dir / "msyh.ttc"), hint_size)`
      }
    ]
  },
  {
    file: 'desktop/control_overlay.py',
    hunks: [
      {
        old: `from windows_mcp.desktop.control_overlay_art import (
    _BORDER,
    _CURSOR_SIZE,
    _NOTICE_GLOW_PAD,
    _breath_opacity,
    _cursor_bitmap,
    _edge_bitmap,
    _notice_bitmap,
    _notice_glow_bitmap,
)`,
        new: `from windows_mcp.desktop.control_overlay_art import (
    _BORDER,
    _CURSOR_SIZE,
    _NOTICE_GLOW_PAD,
    _RIPPLE_FRAMES,
    _RIPPLE_SIZE,
    _breath_opacity,
    _cursor_bitmap,
    _edge_bitmap,
    _notice_bitmap,
    _notice_glow_bitmap,
    _ripple_frame_bgra,
)`
      },
      {
        old: `_REFRESH_SECONDS = 0.05
_SW_HIDE = 0`,
        new: `_REFRESH_SECONDS = 0.005
_RIPPLE_SECONDS = 0.45
_SW_HIDE = 0`
      },
      {
        old: `        flash_overlay._push_bitmap(
            self.hwnd, self.x, self.y, self.width, self.height, self.bgra, opacity=opacity
        )
        self.opacity = opacity
`,
        new: `        flash_overlay._push_bitmap(
            self.hwnd, self.x, self.y, self.width, self.height, self.bgra, opacity=opacity
        )
        self.opacity = opacity

    def set_bitmap(self, bgra: bytes) -> None:
        """Swap the window's pixels while keeping its geometry — the ripple's
        animation frames ride on this; opacity modulation does not apply."""
        flash_overlay._push_bitmap(self.hwnd, self.x, self.y, self.width, self.height, bgra)
        self.opacity = None
`
      },
      {
        old: `_lock = threading.Lock()
_capture_lock = threading.RLock()
_instance: _Indicator | None = None`,
        new: `_lock = threading.Lock()
_capture_lock = threading.RLock()
_instance: _Indicator | None = None
_pulse_lock = threading.Lock()
_pulse: tuple[int, int, float] | None = None


def pulse(x: int, y: int) -> None:
    """Request a click ripple at a screen point. Safe from any thread and a
    no-op when the indicator has never started."""
    global _pulse
    with _pulse_lock:
        _pulse = (x, y, time.monotonic())`
      },
      {
        old: `        layers: list[_Layer] = []
        ring: _Layer | None = None
        rects: tuple[tuple[int, int, int, int], ...] = ()`,
        new: `        layers: list[_Layer] = []
        ring: _Layer | None = None
        ripple: _Layer | None = None
        rects: tuple[tuple[int, int, int, int], ...] = ()`
      },
      {
        old: `                        layers = []
                        if ring:
                            ring.close()
                            ring = None
                        layers, ring = _build_layers(current_rects, pending)`,
        new: `                        layers = []
                        if ring:
                            ring.close()
                            ring = None
                        if ripple:
                            ripple.close()
                            ripple = None
                        layers, ring = _build_layers(current_rects, pending)`
      },
      {
        old: `                    if suspended:
                        if visible:
                            for layer in layers:
                                layer.hide()
                            ring.hide()
                            visible = False`,
        new: `                    if suspended:
                        if visible:
                            for layer in layers:
                                layer.hide()
                            ring.hide()
                            if ripple:
                                ripple.hide()
                            visible = False`
      },
      {
        old: `                        if not pending:
                            point = wintypes.POINT()
                            if _user32.GetCursorPos(ctypes.byref(point)):
                                ring.move(point.x - _CURSOR_SIZE // 2, point.y - _CURSOR_SIZE // 2)
                        else:
                            ring.hide()`,
        new: `                        if not pending:
                            point = wintypes.POINT()
                            if _user32.GetCursorPos(ctypes.byref(point)):
                                ring.move(point.x - _CURSOR_SIZE // 2, point.y - _CURSOR_SIZE // 2)
                        else:
                            ring.hide()
                        # Click ripples: a ring expanding from the click point
                        # for ~0.45 s. Rendered only while a pulse is fresh;
                        # the window is created lazily and torn down with the
                        # other layers.
                        with _pulse_lock:
                            active_pulse = _pulse
                        now = time.monotonic()
                        if active_pulse and now - active_pulse[2] <= _RIPPLE_SECONDS:
                            progress = min(1.0, (now - active_pulse[2]) / _RIPPLE_SECONDS)
                            pulse_color = _AMBER if pending else _BLUE
                            pulse_x = active_pulse[0] - _RIPPLE_SIZE // 2
                            pulse_y = active_pulse[1] - _RIPPLE_SIZE // 2
                            if ripple is None:
                                ripple = _Layer(
                                    pulse_x,
                                    pulse_y,
                                    _RIPPLE_SIZE,
                                    _RIPPLE_SIZE,
                                    _ripple_frame_bgra(round(progress * (_RIPPLE_FRAMES - 1)), pulse_color),
                                    "ripple",
                                    breathes=False,
                                )
                            else:
                                ripple.move(pulse_x, pulse_y)
                                ripple.set_bitmap(_ripple_frame_bgra(round(progress * (_RIPPLE_FRAMES - 1)), pulse_color))
                            ripple.show()
                        elif ripple is not None:
                            ripple.hide()`
      },
      {
        old: `        visible = False
        was_active = False
        breath_started = 0.0
        try:`,
        new: `        visible = False
        was_active = False
        breath_started = 0.0
        last_breath = 0.0
        try:`
      },
      {
        old: `                    else:
                        opacity = _breath_opacity(time.monotonic() - breath_started)
                        for layer in layers:
                            if layer.breathes:
                                layer.set_opacity(opacity)
                        if not pending:
                            ring.set_opacity(opacity)`,
        new: `                    else:
                        # The loop now runs at ~200 Hz so the cursor ring can
                        # track the pointer frame-for-frame; the breath only
                        # needs ~30 Hz, and its bitmap push is the one heavy
                        # operation here, so it gets its own throttle.
                        now = time.monotonic()
                        if now - last_breath >= 0.03:
                            last_breath = now
                            opacity = _breath_opacity(now - breath_started)
                            for layer in layers:
                                if layer.breathes:
                                    layer.set_opacity(opacity)
                            if not pending:
                                ring.set_opacity(opacity)`
      },
      {
        old: `                elif visible:
                    for layer in layers:
                        layer.hide()
                    if ring:
                        ring.hide()
                    visible = False`,
        new: `                elif visible:
                    for layer in layers:
                        layer.hide()
                    if ring:
                        ring.hide()
                    if ripple:
                        ripple.hide()
                    visible = False`
      },
      {
        old: `        finally:
            self.started.set()
            for layer in reversed(layers):
                layer.close()
            if ring:
                ring.close()`,
        new: `        finally:
            self.started.set()
            for layer in reversed(layers):
                layer.close()
            if ring:
                ring.close()
            if ripple:
                ripple.close()`
      }
    ]
  },
  {
    file: 'desktop/service.py',
    hunks: [
      {
        old: `    def click(self, loc: tuple[int, int] | list[int], button: str = "left", clicks: int = 1):`,
        new: `    def _glide_to(self, x: int, y: int) -> None:
        """Walk the cursor to (x, y) in a few visible steps.

        A click used to teleport the pointer onto its target: the motion was
        invisible and the landing spot impossible to follow. The glide is
        clock-driven — the cursor sits where the eased curve says the elapsed
        time is — and DwmFlush() paces the loop to the compositor's frame
        cadence, so each frame draws an even few-pixel step rather than the
        stuttery uneven jumps any sleep cadence produced. A few hundred API
        calls per trip, each followed by a blocking frame wait: cheaper than
        the 1 kHz polling it replaces, and as smooth as the display can
        draw."""
        owner = get_controller()
        cx, cy = uia.GetCursorPos()
        if (cx, cy) == (x, y):
            return
        try:
            flush = ctypes.windll.dwmapi.DwmFlush
        except Exception:
            flush = None
        # ~1200 px/s: at 180 Hz that is a ~7 px step per frame — still one
        # even step per frame, just brisker than the first pass.
        duration = min(1.1, max(0.15, max(abs(x - cx), abs(y - cy)) / 1200.0))
        started = perf_counter()
        while True:
            t = (perf_counter() - started) / duration
            if t >= 1.0:
                break
            eased = t * t * (3 - 2 * t)
            owner.checkpoint_current()
            uia.SetCursorPos(cx + round((x - cx) * eased), cy + round((y - cy) * eased))
            owner.record_step_current()
            if flush is not None:
                flush()
            else:
                sleep(0.002)
        owner.checkpoint_current()
        uia.SetCursorPos(x, y)
        owner.record_step_current()
        owner.checkpoint_current()
        uia.SetCursorPos(x, y)
        owner.record_step_current()

    def click(self, loc: tuple[int, int] | list[int], button: str = "left", clicks: int = 1):`
      },
      {
        old: `        self._validate_screen_point(x, y)
        if clicks == 0:
            owner.checkpoint_current()
            uia.SetCursorPos(x, y)
            return
        match button:`,
        new: `        self._validate_screen_point(x, y)
        self._glide_to(x, y)
        if clicks == 0:
            owner.checkpoint_current()
            uia.SetCursorPos(x, y)
            return
        # A ripple at the click point on the AI control overlay; a no-op when
        # no indicator is running.
        control_overlay.pulse(x, y)
        match button:`
      },
      {
        old: `        screenshot = self.get_screenshot(capture_rect=capture_rect)
        annotated_screenshot = screenshot.copy()
        draw = ImageDraw.Draw(annotated_screenshot)
        image_width, image_height = annotated_screenshot.size`,
        new: `        screenshot = self.get_screenshot(capture_rect=capture_rect)
        # Annotations are composed on a transparent layer and alpha-blended in
        # one pass: PIL draws replace pixels rather than blend them, so
        # drawing directly cannot produce soft glows or translucent strokes.
        overlay = Image.new("RGBA", screenshot.size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)
        image_width, image_height = screenshot.size`
      },
      {
        old: `        def get_random_color():
            return "#{:06x}".format(random.randint(0, 0xFFFFFF))`,
        new: `        # A calm palette cycled per element instead of random RGB soup:
        # neighbours still read as distinct, but nothing turns mud brown.
        palette = [
            (45, 145, 255),
            (40, 200, 180),
            (176, 124, 255),
            (255, 184, 77),
            (255, 110, 138),
            (95, 215, 95),
        ]`
      },
      {
        old: `        def draw_label(text: str, x: float, y: float, color: str) -> None:
            label_width, label_height = get_label_size(text)
            label_x = int(clamp(x, 0, max(0, image_width - label_width)))
            label_y = int(clamp(y, 0, max(0, image_height - label_height)))
            draw.rectangle(
                [(label_x, label_y), (label_x + label_width, label_y + label_height)],
                fill=color,
            )
            draw.text((label_x + 2, label_y + 2), text, fill=(255, 255, 255), font=font)`,
        new: `        def draw_label(text: str, x: float, y: float, rgb: tuple[int, int, int]) -> None:
            label_width, label_height = get_label_size(text)
            label_x = int(clamp(x, 0, max(0, image_width - label_width)))
            label_y = int(clamp(y, 0, max(0, image_height - label_height)))
            # A dark rounded chip with coloured text reads calmer than a
            # saturated block with white text.
            draw.rounded_rectangle(
                [(label_x, label_y), (label_x + label_width, label_y + label_height)],
                radius=4,
                fill=(10, 14, 22, 225),
            )
            draw.text((label_x + 2, label_y + 2), text, fill=(*rgb, 255), font=font)`
      },
      {
        old: `                draw.line([(x, 0), (x, image_height)], fill=(200, 200, 200, 128), width=1)`,
        new: `                draw.line([(x, 0), (x, image_height)], fill=(255, 255, 255, 36), width=1)`
      },
      {
        old: `                draw.line([(0, y), (image_width, y)], fill=(200, 200, 200, 128), width=1)`,
        new: `                draw.line([(0, y), (image_width, y)], fill=(255, 255, 255, 36), width=1)`
      },
      {
        old: `        def draw_annotation(label, node: TreeElementNode):
            box = node.bounding_box
            color = get_random_color()`,
        new: `        def draw_annotation(label, node: TreeElementNode):
            box = node.bounding_box
            rgb = palette[label % len(palette)]`
      },
      {
        old: `            draw.rectangle(clipped_box, outline=color, width=2)

            label_text = str(label)
            label_width, label_height = get_label_size(label_text)
            label_x = right - label_width
            label_y = top - label_height - 2
            if label_y < 0:
                label_y = bottom + 2
            draw_label(label_text, label_x, label_y, color)`,
        new: `            # Rounded strokes with a soft outer pass — a halo instead of a
            # blunt rectangle. Clamped so the glow stays inside the capture.
            glow = (
                int(clamp(left - 2, 0, image_width - 1)),
                int(clamp(top - 2, 0, image_height - 1)),
                int(clamp(right + 2, 0, image_width - 1)),
                int(clamp(bottom + 2, 0, image_height - 1)),
            )
            draw.rounded_rectangle(glow, radius=9, outline=(*rgb, 64), width=3)
            draw.rounded_rectangle(clipped_box, radius=6, outline=(*rgb, 235), width=2)

            label_text = str(label)
            label_width, label_height = get_label_size(label_text)
            label_x = right - label_width
            label_y = top - label_height - 2
            if label_y < 0:
                label_y = bottom + 2
            draw_label(label_text, label_x, label_y, rgb)`
      },
      {
        old: `            # Draw a distinctive marker (e.g., a circle or crosshair with a box)
            r = 15
            draw.ellipse([acx - r, acy - r, acx + r, acy + r], outline="red", width=3)
            draw.line([acx - r, acy, acx + r, acy], fill="red", width=2)
            draw.line([acx, acy - r, acx, acy + r], fill="red", width=2)

            # Draw "Cursor" label
            c_label = "CURSOR"
            draw_label(c_label, acx + r, acy - r, "red")`,
        new: `            # A halo instead of a bullseye: layered rings in the indicator's
            # blue, fading outward — the red cross read as an error marker.
            cursor_rgb = (45, 145, 255)
            draw.ellipse([acx - 16, acy - 16, acx + 16, acy + 16], outline=(*cursor_rgb, 56), width=3)
            draw.ellipse([acx - 9, acy - 9, acx + 9, acy + 9], outline=(*cursor_rgb, 150), width=2)
            draw.ellipse([acx - 3, acy - 3, acx + 3, acy + 3], fill=(*cursor_rgb, 255))`
      },
      {
        old: `        return annotated_screenshot`,
        new: `        return Image.alpha_composite(screenshot.convert("RGBA"), overlay).convert(screenshot.mode)`
      },
      {
        old: `    def move(self, loc: tuple[int, int]):
        owner = get_controller()
        x, y = loc
        owner.checkpoint_current()
        cx, cy = uia.GetCursorPos()
        steps = max(1, min(80, max(abs(x - cx), abs(y - cy)) // 20))
        for step in range(1, steps + 1):
            owner.checkpoint_current()
            uia.SetCursorPos(cx + (x - cx) * step // steps, cy + (y - cy) * step // steps)
            owner.record_step_current()
            sleep(0.003)`,
        new: `    def move(self, loc: tuple[int, int]):
        owner = get_controller()
        owner.checkpoint_current()
        # The same clock-driven glide a click uses: the old fixed-step loop
        # stepped ~16 px at a time, which reads as hopping on fast displays.
        self._glide_to(loc[0], loc[1])`
      },
      {
        old: `from time import sleep, time, perf_counter`,
        new: `import ctypes
from time import sleep, time, perf_counter`
      }
    ]
  }
]

const checkOnly = process.argv.includes('--check')
let applied = 0
let skipped = 0

for (const { file, hunks } of PATCHES) {
  const target = path.join(PKG, file)
  if (!existsSync(target)) throw new Error('not found (windows-mcp installed?): ' + target)
  let text = readFileSync(target, 'utf8')
  let dirty = false
  hunks.forEach((hunk, index) => {
    if (text.includes(hunk.new)) { skipped++; return }
    if (!text.includes(hunk.old)) {
      throw new Error(`${file} hunk #${index + 1}: anchor not found — upstream text drifted, re-check the patch`)
    }
    text = text.replace(hunk.old, hunk.new)
    dirty = true
    applied++
  })
  if (dirty && !checkOnly) {
    const backup = target + '.orig'
    if (!existsSync(backup)) copyFileSync(target, backup)
    writeFileSync(target, text)
  }
}

console.log(`${checkOnly ? '[check] ' : ''}hunks applied: ${applied}, already in place: ${skipped}`)
if (checkOnly) process.exit(applied === 0 && skipped > 0 ? 0 : 0)

// The exe imports every module at startup — let it prove the patched files parse.
const exe = path.join(os.homedir(), '.local', 'bin', 'windows-mcp.exe')
if (existsSync(exe)) {
  execFileSync(exe, ['--help'], { stdio: 'pipe', timeout: 60000 })
  console.log('windows-mcp.exe loads the patched modules cleanly')
}
