"""Build crisp PNG and multi-resolution ICO from the edited whale sprite."""

from __future__ import annotations

from io import BytesIO
from pathlib import Path
import struct

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "src" / "renderer" / "assets"
SOURCE = ASSETS / "whale-tray-icon-pixel-source.png"
PNG_OUTPUT = ASSETS / "whale-tray-icon-pixel.png"
TRAY_PNG_OUTPUT = ASSETS / "whale-tray-icon-pixel-24.png"
ICO_OUTPUT = ASSETS / "whale-tray-icon-pixel.ico"
ICON_SIZES = (16, 24, 32, 48, 64, 128, 256)
# Desktop shortcuts use the full portrait. Fill the canvas so Windows' own
# icon padding does not make this character look smaller than neighboring apps.
PORTRAIT_SIZE = 124
SMALL_CROPS = {
    16: (24, 20, 104, 100),
    24: (16, 12, 112, 108),
}
TRAY_CROP = (8, 8, 120, 120)


def logical_sprite() -> Image.Image:
    source = Image.open(SOURCE).convert("RGBA")
    bounds = source.getchannel("A").getbbox()
    if bounds is None:
        raise ValueError("Source image is completely transparent")

    cropped = source.crop(bounds)
    cropped.thumbnail((PORTRAIT_SIZE, PORTRAIT_SIZE), Image.Resampling.NEAREST)
    canvas = Image.new("RGBA", (128, 128), (0, 0, 0, 0))
    canvas.alpha_composite(cropped, ((128 - cropped.width) // 2, (128 - cropped.height) // 2))

    # Make every visible pixel fully opaque and keep a limited sprite palette.
    alpha = canvas.getchannel("A").point(lambda value: 255 if value >= 128 else 0)
    reduced = canvas.quantize(
        colors=64,
        method=Image.Quantize.FASTOCTREE,
        dither=Image.Dither.NONE,
    ).convert("RGBA")
    reduced.putalpha(alpha)
    # Image generation made the main blue slightly brighter than the old icon.
    # Bring blue hair/eyes back to the original muted blue without moving cyan,
    # white, skin, or dark outlines.
    pixels = []
    for red, green, blue, opacity in reduced.get_flattened_data():
        if (
            opacity
            and 20 <= red < 130
            and 65 <= green < 170
            and 140 <= blue < 250
            and blue >= green + 42
            and blue >= red + 75
        ):
            red, green, blue = min(red + 13, 255), min(green + 4, 255), blue - 14
        pixels.append((red, green, blue, opacity))
    reduced.putdata(pixels)
    return reduced


def save_ico(logical: Image.Image) -> None:
    encoded = []
    for size in ICON_SIZES:
        # The two tiny frames use a closer portrait so the eyes remain legible.
        source = logical.crop(SMALL_CROPS[size]) if size in SMALL_CROPS else logical
        frame = source.resize((size, size), Image.Resampling.NEAREST)
        buffer = BytesIO()
        frame.save(buffer, format="PNG", optimize=True)
        encoded.append((size, buffer.getvalue()))

    offset = 6 + 16 * len(encoded)
    with ICO_OUTPUT.open("wb") as icon:
        icon.write(struct.pack("<HHH", 0, 1, len(encoded)))
        for size, data in encoded:
            dimension = size if size < 256 else 0
            icon.write(
                struct.pack("<BBBBHHII", dimension, dimension, 0, 0, 1, 32, len(data), offset)
            )
            offset += len(data)
        for _, data in encoded:
            icon.write(data)


def main() -> None:
    logical = logical_sprite()
    logical.resize((512, 512), Image.Resampling.NEAREST).save(PNG_OUTPUT, optimize=True)
    # The notification area needs a close portrait at its actual raster size.
    # Resizing the 512 px preview in Electron softens the pixels and shrinks the
    # face visually, even if the nominal tray image is 24 px.
    logical.crop(TRAY_CROP).resize((24, 24), Image.Resampling.NEAREST).save(
        TRAY_PNG_OUTPUT, optimize=True
    )
    save_ico(logical)
    print(PNG_OUTPUT)
    print(TRAY_PNG_OUTPUT)
    print(ICO_OUTPUT)


if __name__ == "__main__":
    main()
