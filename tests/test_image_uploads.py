from __future__ import annotations

import asyncio
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import UploadFile
from PIL import Image
from reportlab.pdfgen import canvas

from backend import main
from backend.images import UnsupportedImageError, image_to_pdf
from backend.watermark import WatermarkSettings, get_pdf_info, render_preview_png, watermark_pdf


class ImageUploadTests(unittest.TestCase):
    def test_pdf_upload_still_uses_original_document(self) -> None:
        payload = io.BytesIO()
        document = canvas.Canvas(payload, pagesize=(300, 200))
        document.drawString(30, 100, "Existing PDF")
        document.showPage()
        document.save()

        with tempfile.TemporaryDirectory() as directory:
            with patch.object(main, "UPLOAD_ROOT", Path(directory)):
                upload_file = tempfile.SpooledTemporaryFile()
                upload_file.write(payload.getvalue())
                upload_file.seek(0)
                upload = UploadFile(filename="document.pdf", file=upload_file)

                upload_data = asyncio.run(main.upload_document(upload))

                self.assertEqual(upload_data["source_type"], "pdf")
                self.assertEqual(upload_data["source_format"], "PDF")
                self.assertEqual(upload_data["page_count"], 1)
                self.assertEqual(upload_data["pages"][0], {"width": 300.0, "height": 200.0})

    def test_image_upload_preview_and_generate_endpoints(self) -> None:
        payload = io.BytesIO()
        image = Image.new("RGB", (160, 120), "#dbeafe")
        image.save(payload, format="PNG")
        image.close()

        with tempfile.TemporaryDirectory() as directory:
            with patch.object(main, "UPLOAD_ROOT", Path(directory)):
                upload_file = tempfile.SpooledTemporaryFile()
                upload_file.write(payload.getvalue())
                upload_file.seek(0)
                upload = UploadFile(filename="photo.png", file=upload_file)
                upload_data = asyncio.run(main.upload_document(upload))
                self.assertEqual(upload_data["source_type"], "image")
                self.assertEqual(upload_data["source_format"], "PNG")

                normalized_pdf = Path(directory) / f"{upload_data['file_id']}.pdf"
                self.assertTrue(normalized_pdf.read_bytes().startswith(b"%PDF-"))

                request = main.WatermarkRequest(
                    file_id=upload_data["file_id"],
                    text="PHOTO",
                    font="Kanit",
                )
                preview = main.preview(request)
                self.assertEqual(preview.media_type, "image/png")
                self.assertTrue(bytes(preview.body).startswith(b"\x89PNG"))

                generated = main.generate(request)
                self.assertEqual(generated.media_type, "application/pdf")
                self.assertIn("photo_watermarked.pdf", generated.headers["content-disposition"])

    def test_transparent_png_becomes_single_pdf_page(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "transparent.png"
            destination = Path(directory) / "transparent.pdf"
            image = Image.new("RGBA", (320, 160), (255, 0, 0, 128))
            image.save(source, dpi=(96, 96))
            image.close()

            image_format, frame_count = image_to_pdf(source, destination)

            self.assertEqual(image_format, "PNG")
            self.assertEqual(frame_count, 1)
            page_count, pages = get_pdf_info(destination)
            self.assertEqual(page_count, 1)
            self.assertAlmostEqual(pages[0]["width"], 240, delta=0.1)
            self.assertAlmostEqual(pages[0]["height"], 120, delta=0.1)

    def test_exif_orientation_controls_pdf_page_shape(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "rotated.jpg"
            destination = Path(directory) / "rotated.pdf"
            image = Image.new("RGB", (40, 80), "blue")
            exif = image.getexif()
            exif[274] = 6
            image.save(source, exif=exif, dpi=(96, 96))
            image.close()

            image_to_pdf(source, destination)

            _, pages = get_pdf_info(destination)
            self.assertGreater(pages[0]["width"], pages[0]["height"])

    def test_animated_gif_frames_become_pdf_pages(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "animated.gif"
            destination = Path(directory) / "animated.pdf"
            first = Image.new("RGB", (80, 60), "red")
            second = Image.new("RGB", (80, 60), "blue")
            first.save(source, save_all=True, append_images=[second], duration=100, loop=0)
            first.close()
            second.close()

            image_format, frame_count = image_to_pdf(source, destination)

            self.assertEqual(image_format, "GIF")
            self.assertEqual(frame_count, 2)
            page_count, _ = get_pdf_info(destination)
            self.assertEqual(page_count, 2)

    def test_normalized_image_uses_existing_watermark_pipeline(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.webp"
            destination = Path(directory) / "source.pdf"
            image = Image.new("RGB", (240, 180), "#dbeafe")
            image.save(source, format="WEBP")
            image.close()
            image_to_pdf(source, destination)
            settings = WatermarkSettings.normalized(text="IMAGE", font="Kanit")

            pdf = watermark_pdf(destination, settings)
            preview = render_preview_png(destination, settings)

            self.assertTrue(pdf.startswith(b"%PDF-1.4"))
            self.assertTrue(preview.startswith(b"\x89PNG\r\n\x1a\n"))

    def test_rejects_non_image(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "not-an-image.txt"
            destination = Path(directory) / "not-an-image.pdf"
            source.write_text("hello", encoding="utf-8")

            with self.assertRaisesRegex(UnsupportedImageError, "valid PDF"):
                image_to_pdf(source, destination)


if __name__ == "__main__":
    unittest.main()
