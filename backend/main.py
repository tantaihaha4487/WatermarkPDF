"""FastAPI application for WatermarkPDF."""

from __future__ import annotations

import asyncio
import io
import json
import logging
import re
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated
from uuid import UUID, uuid4

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pypdf import PdfReader, PdfWriter
from pydantic import BaseModel, Field

from .fonts import available_fonts
from .images import UnsupportedImageError, image_to_pdf
from .watermark import WatermarkSettings, get_pdf_info, render_preview_png, watermark_pdf

logger = logging.getLogger("watermarkpdf")

PROJECT_ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIR = PROJECT_ROOT / "frontend"
UPLOAD_ROOT = Path("/tmp") / "watermarkpdf-uploads"
DATA_ROOT = PROJECT_ROOT / "data"
VISITS_FILE = DATA_ROOT / "visits.json"
MAX_UPLOAD_BYTES = 50 * 1024 * 1024
UPLOAD_TTL_SECONDS = 60 * 60
FILE_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
_visit_lock = asyncio.Lock()


def _read_visit_count() -> int:
    try:
        return int(json.loads(VISITS_FILE.read_text(encoding="utf-8"))["count"])
    except (OSError, ValueError, KeyError, TypeError):
        return 0


def _write_visit_count(count: int) -> None:
    DATA_ROOT.mkdir(parents=True, exist_ok=True)
    VISITS_FILE.write_text(json.dumps({"count": count}), encoding="utf-8")


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


app = FastAPI(title="WatermarkPDF", description="Centered document watermark utility", lifespan=lifespan)


class PageOrderItem(BaseModel):
    source_page: int | None = Field(None, ge=1)
    image_id: UUID | None = None
    image_page: int | None = Field(None, ge=1)


class WatermarkRequest(BaseModel):
    file_id: UUID
    text: str = Field(..., max_length=5000)
    opacity: float = 30.0
    rotation: float = 315.0
    font: str = "Kanit"
    font_size: float = 40.0
    color: str = "#808080"
    page_order: list[PageOrderItem] | None = Field(None, max_length=500)

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
        raise HTTPException(status_code=404, detail="Uploaded file not found.")
    path = UPLOAD_ROOT / f"{value}.pdf"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Uploaded file not found or has expired.")
    return path


def _path_for_inserted_image(image_id: UUID) -> Path:
    value = str(image_id)
    if not FILE_ID_RE.fullmatch(value):
        raise HTTPException(status_code=404, detail="Inserted image pages not found.")
    path = UPLOAD_ROOT / f"{value}.inserted.pdf"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Inserted image pages not found or have expired.")
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


def _document_for_request(request: WatermarkRequest) -> Path | bytes:
    """Build the requested source/inserted-page order before watermarking."""

    source_path = _path_for_file(request.file_id)
    if request.page_order is None:
        return source_path
    if not request.page_order:
        raise HTTPException(status_code=422, detail="The document must contain at least one page.")

    source_reader = PdfReader(io.BytesIO(source_path.read_bytes()), strict=False)
    inserted_readers: dict[UUID, PdfReader] = {}
    seen_source_pages: list[int] = []
    seen_inserted_pages: set[tuple[UUID, int]] = set()
    writer = PdfWriter()
    for item in request.page_order:
        is_source = item.source_page is not None
        is_inserted = item.image_id is not None or item.image_page is not None
        if is_source == is_inserted:
            raise HTTPException(
                status_code=422,
                detail="Each page-order item must identify one source page or one inserted image page.",
            )
        if is_source:
            page_index = item.source_page - 1
            if page_index >= len(source_reader.pages):
                raise HTTPException(status_code=422, detail="Page order references a source page that does not exist.")
            seen_source_pages.append(item.source_page)
            writer.add_page(source_reader.pages[page_index])
            continue

        if item.image_id is None or item.image_page is None:
            raise HTTPException(status_code=422, detail="Inserted page references are incomplete.")
        reader = inserted_readers.get(item.image_id)
        if reader is None:
            inserted_path = _path_for_inserted_image(item.image_id)
            reader = PdfReader(io.BytesIO(inserted_path.read_bytes()), strict=False)
            inserted_readers[item.image_id] = reader
        page_index = item.image_page - 1
        if page_index >= len(reader.pages):
            raise HTTPException(status_code=422, detail="Page order references an inserted image page that does not exist.")
        inserted_page_key = (item.image_id, item.image_page)
        if inserted_page_key in seen_inserted_pages:
            raise HTTPException(status_code=422, detail="Page order cannot repeat an inserted image page.")
        seen_inserted_pages.add(inserted_page_key)
        writer.add_page(reader.pages[page_index])

    expected_source_pages = list(range(1, len(source_reader.pages) + 1))
    if sorted(seen_source_pages) != expected_source_pages:
        raise HTTPException(status_code=422, detail="Page order must include every source page exactly once.")

    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


@app.get("/api/fonts")
def fonts_endpoint() -> list[dict[str, object]]:
    return available_fonts()


@app.post("/api/visit")
async def record_visit() -> dict[str, int]:
    """Increment and return the site's all-time visit count."""

    async with _visit_lock:
        count = _read_visit_count() + 1
        _write_visit_count(count)
    return {"count": count}


@app.post("/api/upload")
async def upload_document(file: Annotated[UploadFile, File(...)]) -> dict[str, object]:
    filename = file.filename or "document.pdf"
    file_id = uuid4()
    target = UPLOAD_ROOT / f"{file_id}.pdf"
    incoming = UPLOAD_ROOT / f"{file_id}.upload"
    bytes_written = 0
    first_chunk = b""
    source_type = "pdf"
    source_format = "PDF"

    UPLOAD_ROOT.mkdir(parents=True, exist_ok=True)
    try:
        with incoming.open("wb") as output:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                if not first_chunk:
                    first_chunk = chunk[:16]
                bytes_written += len(chunk)
                if bytes_written > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail="Files must be 50 MB or smaller.")
                output.write(chunk)

        if first_chunk.startswith(b"%PDF-"):
            incoming.replace(target)
        else:
            source_format, _ = image_to_pdf(incoming, target)
            source_type = "image"

        page_count, pages = get_pdf_info(target)
    except HTTPException:
        target.unlink(missing_ok=True)
        raise
    except UnsupportedImageError as exc:
        target.unlink(missing_ok=True)
        logger.info("Rejected uploaded file %s: %s", filename, exc)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        target.unlink(missing_ok=True)
        logger.info("Rejected uploaded file %s: %s", filename, exc)
        raise HTTPException(status_code=400, detail=f"Could not read this file: {exc}") from exc
    finally:
        incoming.unlink(missing_ok=True)
        await file.close()

    # Keep the original name beside the short-lived PDF so downloads can use
    # a helpful filename without storing user data outside the temp directory.
    metadata_path = UPLOAD_ROOT / f"{file_id}.json"
    metadata_path.write_text(
        json.dumps(
            {
                "filename": filename,
                "source_type": source_type,
                "source_format": source_format,
            }
        ),
        encoding="utf-8",
    )
    return {
        "file_id": str(file_id),
        "page_count": page_count,
        "pages": pages,
        "source_type": source_type,
        "source_format": source_format,
    }


@app.post("/api/page-image")
async def upload_page_image(file: Annotated[UploadFile, File(...)]) -> dict[str, object]:
    """Normalize a raster image into one or more insertable PDF pages."""

    filename = file.filename or "inserted-image"
    image_id = uuid4()
    target = UPLOAD_ROOT / f"{image_id}.inserted.pdf"
    incoming = UPLOAD_ROOT / f"{image_id}.inserted.upload"
    bytes_written = 0
    UPLOAD_ROOT.mkdir(parents=True, exist_ok=True)
    try:
        with incoming.open("wb") as output:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                bytes_written += len(chunk)
                if bytes_written > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail="Inserted images must be 50 MB or smaller.")
                output.write(chunk)
        if bytes_written == 0:
            raise HTTPException(status_code=400, detail="The inserted image is empty.")
        source_format, _ = image_to_pdf(incoming, target)
        page_count, pages = get_pdf_info(target)
    except HTTPException:
        target.unlink(missing_ok=True)
        raise
    except UnsupportedImageError as exc:
        target.unlink(missing_ok=True)
        logger.info("Rejected inserted page image %s: %s", filename, exc)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        target.unlink(missing_ok=True)
        logger.info("Rejected inserted page image %s: %s", filename, exc)
        raise HTTPException(status_code=400, detail=f"Could not read this image: {exc}") from exc
    finally:
        incoming.unlink(missing_ok=True)
        await file.close()

    return {
        "image_id": str(image_id),
        "source_format": source_format,
        "page_count": page_count,
        "pages": pages,
        "filename": filename,
    }


@app.get("/api/document/{file_id}")
def uploaded_document(file_id: UUID) -> FileResponse:
    """Serve the normalized PDF used by the browser's PDF.js preview."""

    return FileResponse(
        _path_for_file(file_id),
        media_type="application/pdf",
        headers={"Cache-Control": "no-store"},
    )


@app.get("/api/page-image/{image_id}")
def inserted_image_document(image_id: UUID) -> FileResponse:
    """Serve normalized image pages to the browser preview."""

    return FileResponse(
        _path_for_inserted_image(image_id),
        media_type="application/pdf",
        headers={"Cache-Control": "no-store"},
    )


@app.post("/api/preview")
def preview(request: WatermarkRequest) -> Response:
    document = _document_for_request(request)
    settings = _settings_or_422(request)
    try:
        png = render_preview_png(document, settings)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Preview rendering failed")
        raise HTTPException(status_code=500, detail=f"Could not render the preview: {exc}") from exc
    return Response(content=png, media_type="image/png", headers={"Cache-Control": "no-store"})


@app.post("/api/generate")
def generate(request: WatermarkRequest) -> Response:
    document = _document_for_request(request)
    settings = _settings_or_422(request)
    try:
        pdf = watermark_pdf(document, settings)
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
