FROM python:3.11-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY backend/requirements.txt backend/requirements.txt
RUN pip install --upgrade pip && \
    pip install -r backend/requirements.txt

COPY backend backend
COPY frontend frontend

RUN groupadd --system app && useradd --system --gid app --no-create-home app && \
    mkdir -p /tmp/watermarkpdf-uploads && chown -R app:app /app /tmp/watermarkpdf-uploads

USER app

EXPOSE 8000

CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
