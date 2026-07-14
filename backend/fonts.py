"""Local font registry used by the ReportLab watermark renderer.

The browser is free to load a nicer webfont from Google Fonts, but the PDF
renderer must only use files that are present in this directory.  Missing
font files are logged and omitted from the API response so a partial font
bundle cannot prevent the application from starting.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

logger = logging.getLogger(__name__)

FONT_DIR = Path(__file__).resolve().parent / "assets" / "fonts"


@dataclass(frozen=True)
class FontDefinition:
    """Metadata for one user-facing font choice."""

    name: str
    regular_file: str
    thai_capable: bool
    bold_file: str | None = None


FONT_DEFINITIONS: tuple[FontDefinition, ...] = (
    FontDefinition("Kanit", "Kanit-Regular.ttf", thai_capable=True, bold_file="Kanit-Bold.ttf"),
    FontDefinition("Sarabun", "Sarabun-Regular.ttf", thai_capable=True),
    FontDefinition("Noto Sans Thai", "NotoSansThai-Regular.ttf", thai_capable=True),
    FontDefinition("Prompt", "Prompt-Regular.ttf", thai_capable=True),
    FontDefinition("Roboto", "Roboto-Regular.ttf", thai_capable=False),
)

# The dictionary contains only fonts that loaded successfully.  Keeping the
# reportlab name equal to the UI name also makes the API payload uncomplicated.
REGISTERED_FONTS: dict[str, FontDefinition] = {}


def _register_font(definition: FontDefinition) -> None:
    regular_path = FONT_DIR / definition.regular_file
    if not regular_path.is_file():
        logger.warning("Bundled font %s is missing: %s", definition.name, regular_path)
        return

    try:
        pdfmetrics.registerFont(TTFont(definition.name, str(regular_path)))
        if definition.bold_file:
            bold_path = FONT_DIR / definition.bold_file
            if bold_path.is_file():
                pdfmetrics.registerFont(TTFont(f"{definition.name} Bold", str(bold_path)))
            else:
                logger.warning("Bundled bold font for %s is missing: %s", definition.name, bold_path)
        REGISTERED_FONTS[definition.name] = definition
    except Exception:  # ReportLab may reject a corrupt/incompatible TTF.
        logger.exception("Could not register bundled font %s", definition.name)


def register_fonts() -> None:
    """Register every valid bundled font exactly once."""

    if REGISTERED_FONTS:
        return
    for definition in FONT_DEFINITIONS:
        _register_font(definition)

    if not REGISTERED_FONTS:
        # A system-independent ReportLab base font is a last-resort startup
        # fallback.  It is not advertised as Thai-capable, but the app still
        # starts and can render Latin watermarks if the bundle is incomplete.
        fallback = FontDefinition("Helvetica", "", thai_capable=False)
        REGISTERED_FONTS[fallback.name] = fallback
        logger.warning("No bundled TTF fonts loaded; using ReportLab Helvetica fallback")


def available_fonts() -> list[dict[str, object]]:
    """Return the public font list for the frontend."""

    register_fonts()
    return [
        {"name": definition.name, "thai_capable": definition.thai_capable}
        for definition in REGISTERED_FONTS.values()
    ]


def is_registered(font_name: str) -> bool:
    register_fonts()
    return font_name in REGISTERED_FONTS


register_fonts()
