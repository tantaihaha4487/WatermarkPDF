"""Image upload normalization for the PDF watermark pipeline."""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError

SUPPORTED_IMAGE_FORMATS = frozenset({"BMP", "GIF", "JPEG", "PNG", "TIFF", "WEBP"})
MAX_IMAGE_FRAMES = 100
MAX_TOTAL_IMAGE_PIXELS = 50_000_000
DEFAULT_IMAGE_DPI = 96.0


class UnsupportedImageError(ValueError):
    """Raised when an upload is not an image format supported by this app."""


def _safe_resolution(image: Image.Image) -> float:
    """Read a useful source DPI without allowing pathological PDF page sizes."""

    dpi = image.info.get("dpi", (DEFAULT_IMAGE_DPI, DEFAULT_IMAGE_DPI))
    value = dpi[0] if isinstance(dpi, (tuple, list)) and dpi else dpi
    try:
        value = float(value)
    except (TypeError, ValueError):
        return DEFAULT_IMAGE_DPI
    if not math.isfinite(value) or value < 36 or value > 600:
        return DEFAULT_IMAGE_DPI
    return value


def _flatten_to_rgb(image: Image.Image) -> Image.Image:
    """Convert a frame to RGB, compositing transparent pixels over white."""

    if image.mode in {"RGBA", "LA"} or "transparency" in image.info:
        rgba = image.convert("RGBA")
        background = Image.new("RGB", rgba.size, "white")
        background.paste(rgba, mask=rgba.getchannel("A"))
        rgba.close()
        return background
    return image.convert("RGB")


def image_to_pdf(source: str | Path, destination: str | Path) -> tuple[str, int]:
    """Convert a supported raster image into one or more correctly sized PDF pages.

    Animated GIFs and multi-page TIFFs become multi-page PDFs. EXIF orientation
    is applied before page dimensions are calculated, and transparency is
    flattened over white because a PDF page has no transparent canvas.
    """

    frames: list[Image.Image] = []
    try:
        with Image.open(source) as image:
            image_format = (image.format or "").upper()
            if image_format not in SUPPORTED_IMAGE_FORMATS:
                raise UnsupportedImageError(
                    "Supported image formats are JPEG, PNG, WebP, TIFF, GIF, and BMP."
                )

            frame_count = int(getattr(image, "n_frames", 1))
            if frame_count > MAX_IMAGE_FRAMES:
                raise UnsupportedImageError(
                    f"Images may contain at most {MAX_IMAGE_FRAMES} frames or pages."
                )

            resolution = _safe_resolution(image)
            total_pixels = 0
            for frame_index in range(frame_count):
                image.seek(frame_index)
                # Check dimensions before decoding the frame so a highly
                # compressed image cannot force an oversized allocation first.
                total_pixels += image.width * image.height
                if total_pixels > MAX_TOTAL_IMAGE_PIXELS:
                    raise UnsupportedImageError(
                        "Image dimensions are too large (50 million total pixels maximum)."
                    )
                image.load()
                oriented = ImageOps.exif_transpose(image)
                frames.append(_flatten_to_rgb(oriented))
                if oriented is not image:
                    oriented.close()

            first, *remaining = frames
            first.save(
                destination,
                format="PDF",
                save_all=True,
                append_images=remaining,
                resolution=resolution,
                quality=95,
                subsampling=0,
            )
            return image_format, frame_count
    except UnsupportedImageError:
        raise
    except (UnidentifiedImageError, OSError, SyntaxError) as exc:
        raise UnsupportedImageError(
            "Please upload a valid PDF or a supported image file."
        ) from exc
    finally:
        for frame in frames:
            frame.close()
