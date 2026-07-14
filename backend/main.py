"""FastAPI application for WatermarkPDF."""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated
from uuid import UUID, uuid4

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .fonts import available_fonts
from .watermark import WatermarkSettings, get_pdf_info, render_preview_png, watermark_pdf

logger = logging.getLogger("watermarkpdf")

PROJECT_ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIR = PROJECT_ROOT / "frontend"
UPLOAD_ROOT = Path("/tmp") / "watermarkpdf-uploads"
MAX_UPLOAD_BYTES = 50 * 1024 * 1024
UPLOAD_TTL_SECONDS = 60 * 60
FILE_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")


def _cleanup_uploads(*, remove_all: bool = False) -> None:
    UPLOAD_ROOT.mkdir(parents=True, exist_ok=True)
    now = time.time()
    for path in UPLOAD_ROOT.iterdir():
        if not path.is_file():
            continue
        try:
            if remove_all or now - path.stat().st_mtime > UPLOAD_TTL_SECONDS:
                path.unlink(missing_ok=True)
        except OSError:
            logger.warning("Could not clean up temporary file %s", path, exc_info=True)


async def _cleanup_loop() -> None:
    while True:
        await asyncio.sleep(10 * 60)
        _cleanup_uploads()


@asynccontextmanager
async def lifespan(_: FastAPI):
    UPLOAD_ROOT.mkdir(parents=True, exist_ok=True)
    # Uploads are session-scoped and should not survive a server restart.
    _cleanup_uploads(remove_all=True)
    task = asyncio.create_task(_cleanup_loop())
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


app = FastAPI(title="WatermarkPDF", description="Centered PDF watermark utility", lifespan=lifespan)


class WatermarkRequest(BaseModel):
    file_id: UUID
    text: str = Field(..., max_length=5000)
    opacity: float = 30.0
    rotation: float = 315.0
    font: str = "Kanit"
    font_size: float = 40.0
    color: str = "#808080"

    def settings(self) -> WatermarkSettings:
        return WatermarkSettings.normalized(
            text=self.text,
            opacity=self.opacity,
            rotation=self.rotation,
            font=self.font,
            font_size=self.font_size,
            color=self.color,
        )


def _path_for_file(file_id: UUID) -> Path:
    value = str(file_id)
    if not FILE_ID_RE.fullmatch(value):
        raise HTTPException(status_code=404, detail="Uploaded PDF not found.")
    path = UPLOAD_ROOT / f"{value}.pdf"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Uploaded PDF not found or has expired.")
    return path


def _safe_download_stem(filename: str | None) -> str:
    original = Path(filename or "document.pdf").name
    stem = Path(original).stem or "document"
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", stem).strip("._")
    return safe or "document"


def _settings_or_422(request: WatermarkRequest) -> WatermarkSettings:
    try:
        return request.settings()
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.get("/api/fonts")
def fonts_endpoint() -> list[dict[str, object]]:
    return available_fonts()


@app.post("/api/upload")
async def upload_pdf(file: Annotated[UploadFile, File(...)]) -> dict[str, object]:
    filename = file.filename or "document.pdf"
    file_id = uuid4()
    target = UPLOAD_ROOT / f"{file_id}.pdf"
    bytes_written = 0
    first_chunk = b""

    UPLOAD_ROOT.mkdir(parents=True, exist_ok=True)
    try:
        with target.open("wb") as output:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                if not first_chunk:
                    first_chunk = chunk[:16]
                bytes_written += len(chunk)
                if bytes_written > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail="PDF must be 50 MB or smaller.")
                output.write(chunk)

        if not first_chunk.startswith(b"%PDF-"):
            raise HTTPException(status_code=400, detail="Please upload a valid PDF file.")

        page_count, pages = get_pdf_info(target)
    except HTTPException:
        target.unlink(missing_ok=True)
        raise
    except Exception as exc:
        target.unlink(missing_ok=True)
        logger.info("Rejected uploaded file %s: %s", filename, exc)
        raise HTTPException(status_code=400, detail=f"Could not read this PDF: {exc}") from exc
    finally:
        await file.close()

    # Keep the original name beside the short-lived PDF so downloads can use
    # a helpful filename without storing user data outside the temp directory.
    metadata_path = UPLOAD_ROOT / f"{file_id}.json"
    metadata_path.write_text(json.dumps({"filename": filename}), encoding="utf-8")
    return {"file_id": str(file_id), "page_count": page_count, "pages": pages}


@app.post("/api/preview")
def preview(request: WatermarkRequest) -> Response:
    path = _path_for_file(request.file_id)
    settings = _settings_or_422(request)
    try:
        png = render_preview_png(path, settings)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Preview rendering failed")
        raise HTTPException(status_code=500, detail=f"Could not render the preview: {exc}") from exc
    return Response(content=png, media_type="image/png", headers={"Cache-Control": "no-store"})


@app.post("/api/generate")
def generate(request: WatermarkRequest) -> Response:
    path = _path_for_file(request.file_id)
    settings = _settings_or_422(request)
    try:
        pdf = watermark_pdf(path, settings)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("PDF generation failed")
        raise HTTPException(status_code=500, detail=f"Could not generate the watermarked PDF: {exc}") from exc

    source_stem = "document"
    metadata_path = UPLOAD_ROOT / f"{request.file_id}.json"
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        source_stem = _safe_download_stem(metadata.get("filename"))
    except (OSError, ValueError, TypeError):
        pass
    download_name = f"{source_stem}_watermarked.pdf"
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{download_name}"',
            "Cache-Control": "no-store",
        },
    )


if FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
