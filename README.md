# WatermarkPDF

WatermarkPDF is a self-hosted FastAPI utility that adds a crisp, centered text watermark to every page of a PDF or raster image. JPEG, PNG, WebP, TIFF, GIF, and BMP uploads are normalized to PDF first; animated GIF frames and multi-page TIFFs become separate pages. It has no frontend build step: FastAPI serves the plain HTML/CSS/JavaScript editor, PDF.js renders every page in a scrollable instant preview, and an exact server check runs automatically in the background using the same ReportLab + pypdfium2 pipeline as the final download.

## Run it

Requirements: Python 3.11+ and network access for the first dependency install.

```bash
./run.sh
```

Open <http://127.0.0.1:8000>. `run.sh` creates `.venv`, installs the pinned dependencies, and starts Uvicorn with reload enabled. The bundled TTF files are loaded locally by ReportLab; the Google Fonts link is only for the browser-side preview.

## What the renderer guarantees

For each page, the renderer reads that page's own media-box width and height, translates the ReportLab canvas to `(W / 2, H / 2)`, and rotates the coordinate system once. It then splits the text into lines, uses a `1.2 × font size` line height to center the whole block, and calls `drawCentredString(0, y, line)` for every line. Because every line is drawn at the same local `x=0`, different line widths cannot move their horizontal centers apart; the entire multiline block rotates as one rigid unit around the page center. Rotation values use the PDF counter-clockwise convention, so `315°` gives the reference bottom-left to top-right diagonal.

## API

- `POST /api/upload` — multipart PDF or image upload; returns a UUID, source format, page count, and dimensions for every page.
- `GET /api/document/{file_id}` — returns the short-lived normalized PDF used by the browser preview.
- `POST /api/preview` — JSON watermark settings; returns a PNG of the watermarked first page.
- `POST /api/generate` — JSON watermark settings; returns the complete watermarked PDF download.
- `GET /api/fonts` — returns the locally registered server fonts and Thai capability.

Uploads are written only to `/tmp/watermarkpdf-uploads`, removed on server startup, and swept after one hour. The 50 MB upload limit, empty-text check, color validation, and control clamping are enforced at the API boundary.

## Verification checklist

The renderer can be exercised without a browser by creating a sample PDF with `reportlab` or a sample image with Pillow, uploading it, and calling `/api/preview` and `/api/generate`. Check the single-line default, a two-line string, Thai text with both Kanit and Sarabun, mixed page sizes, transparent and EXIF-rotated images, and rotations `0` and `90`. The watermark remains vector text in the PDF overlay; pypdfium2 is used only to rasterize the server preview PNG.
