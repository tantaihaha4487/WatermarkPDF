"""PDF watermark rendering and preview helpers.

The important invariant in this module is that the complete text block is
translated to the page centre and rotated once.  Every line is drawn at
``x=0`` with ReportLab's ``drawCentredString`` after that translation, so
different line widths cannot move their centres apart.
"""

from __future__ import annotations

import io
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

import pypdfium2 as pdfium
from pypdf import PdfReader, PdfWriter
from reportlab.lib import colors
from reportlab.pdfgen import canvas

from .fonts import is_registered

HEX_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


@dataclass(frozen=True)
class WatermarkSettings:
    text: str
    opacity: float = 30.0
    rotation: float = 315.0
    font: str = "Kanit"
    font_size: float = 40.0
    color: str = "#808080"

    @classmethod
    def normalized(
        cls,
        *,
        text: str,
        opacity: float = 30.0,
        rotation: float = 315.0,
        font: str = "Kanit",
        font_size: float = 40.0,
        color: str = "#808080",
    ) -> "WatermarkSettings":
        """Validate and normalize API values at the rendering boundary."""

        if not isinstance(text, str) or not text.strip():
            raise ValueError("Watermark text cannot be empty.")
        if not isinstance(font, str) or not is_registered(font):
            raise ValueError(f"Font '{font}' is not available on this server.")

        numeric_values = {
            "opacity": opacity,
            "rotation": rotation,
            "font size": font_size,
        }
        if not all(isinstance(value, (int, float)) and math.isfinite(float(value)) for value in numeric_values.values()):
            raise ValueError("Opacity, rotation, and font size must be finite numbers.")

        normalized_opacity = max(0.0, min(100.0, float(opacity)))
        # A rotation of exactly 360 degrees is visually identical to zero.
        normalized_rotation = float(rotation) % 360.0
        normalized_font_size = max(8.0, min(200.0, float(font_size)))

        normalized_color = color.strip().upper() if isinstance(color, str) else ""
        if not HEX_COLOR_RE.fullmatch(normalized_color):
            raise ValueError("Color must be a six-digit hex value such as #808080.")

        # Normalize CRLF input while preserving intentional empty lines.
        normalized_text = text.replace("\r\n", "\n").replace("\r", "\n")
        return cls(
            text=normalized_text,
            opacity=normalized_opacity,
            rotation=normalized_rotation,
            font=font,
            font_size=normalized_font_size,
            color=normalized_color,
        )


def _pdf_reader(source: bytes | bytearray | memoryview | str | Path | BinaryIO) -> PdfReader:
    """Create a reader for both path/file-like and in-memory PDF sources."""

    if isinstance(source, (bytes, bytearray, memoryview)):
        source = io.BytesIO(bytes(source))
    return PdfReader(source, strict=False)


def _page_dimensions(page) -> tuple[float, float]:
    """Read the page's media-box dimensions in PDF points."""

    width = float(page.mediabox.width)
    height = float(page.mediabox.height)
    if width <= 0 or height <= 0:
        raise ValueError("PDF contains a page with invalid dimensions.")
    return width, height


def get_pdf_info(source: bytes | bytearray | memoryview | str | Path | BinaryIO) -> tuple[int, list[dict[str, float]]]:
    """Return page count and per-page width/height without modifying the PDF."""

    reader = _pdf_reader(source)
    if reader.is_encrypted:
        raise ValueError("Encrypted PDFs are not supported. Please upload an unlocked PDF.")
    if len(reader.pages) == 0:
        raise ValueError("The uploaded PDF does not contain any pages.")
    pages = []
    for page in reader.pages:
        width, height = _page_dimensions(page)
        pages.append({"width": round(width, 2), "height": round(height, 2)})
    return len(pages), pages


def _hex_color(value: str):
    # WatermarkSettings.normalized has already checked this.  Keeping the
    # conversion in one place makes the drawing function easy to audit.
    return colors.HexColor(value)


def render_overlay(page_width: float, page_height: float, settings: WatermarkSettings) -> bytes:
    """Create one same-sized vector overlay PDF for a page."""

    buffer = io.BytesIO()
    overlay = canvas.Canvas(buffer, pagesize=(page_width, page_height), pageCompression=1)
    overlay.saveState()

    # §5 of BUILD_PROMPT.md: translate then rotate so the whole block is rigid.
    cx, cy = page_width / 2.0, page_height / 2.0
    overlay.translate(cx, cy)
    overlay.rotate(settings.rotation)
    overlay.setFont(settings.font, settings.font_size)
    overlay.setFillColor(_hex_color(settings.color))
    overlay.setFillAlpha(settings.opacity / 100.0)

    lines = settings.text.split("\n")
    line_height = settings.font_size * 1.2
    total_height = line_height * len(lines)
    for index, line in enumerate(lines):
        y = (
            (total_height / 2.0)
            - (line_height * (index + 1))
            + ((line_height - settings.font_size) / 2.0)
        )
        # x=0 is deliberate: every line shares the exact translated centre.
        overlay.drawCentredString(0, y, line)

    overlay.restoreState()
    overlay.showPage()
    overlay.save()
    return buffer.getvalue()


def watermark_pdf(
    source: bytes | bytearray | memoryview | str | Path | BinaryIO,
    settings: WatermarkSettings,
    *,
    page_limit: int | None = None,
) -> bytes:
    """Merge the vector watermark onto each selected page and return a PDF."""

    reader = _pdf_reader(source)
    if reader.is_encrypted:
        raise ValueError("Encrypted PDFs are not supported. Please upload an unlocked PDF.")
    total_pages = len(reader.pages)
    if total_pages == 0:
        raise ValueError("The uploaded PDF does not contain any pages.")
    pages_to_process = total_pages if page_limit is None else min(max(page_limit, 0), total_pages)

    writer = PdfWriter()
    # ReportLab's opacity uses a PDF ExtGState, which is a PDF 1.4 feature.
    # pypdf defaults its writer header to 1.3, so advertise the version that
    # matches the transparent overlay we are merging.
    writer.pdf_header = b"%PDF-1.4"
    for index, page in enumerate(reader.pages):
        if index < pages_to_process:
            width, height = _page_dimensions(page)
            overlay_reader = PdfReader(io.BytesIO(render_overlay(width, height, settings)), strict=False)
            page.merge_page(overlay_reader.pages[0])
        writer.add_page(page)

    result = io.BytesIO()
    writer.write(result)
    return result.getvalue()


def render_preview_png(
    source: bytes | bytearray | memoryview | str | Path | BinaryIO,
    settings: WatermarkSettings,
    *,
    scale: float = 1.5,
) -> bytes:
    """Run the real one-page pipeline and rasterize its first page as PNG."""

    watermarked = watermark_pdf(source, settings, page_limit=1)
    document = pdfium.PdfDocument(watermarked)
    page = document[0]
    bitmap = None
    try:
        bitmap = page.render(scale=scale)
        image = bitmap.to_pil()
        image_buffer = io.BytesIO()
        image.save(image_buffer, format="PNG", optimize=True)
        return image_buffer.getvalue()
    finally:
        if bitmap is not None:
            bitmap.close()
        page.close()
        document.close()
