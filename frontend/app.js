/* global pdfjsLib */

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const elements = {
  fileInput: document.querySelector("#file-input"),
  dropzone: document.querySelector("#dropzone"),
  fileSummary: document.querySelector("#file-summary"),
  fileName: document.querySelector("#file-name"),
  fileMeta: document.querySelector("#file-meta"),
  removeFile: document.querySelector("#remove-file"),
  settingsCard: document.querySelector("#settings-card"),
  text: document.querySelector("#watermark-text"),
  opacity: document.querySelector("#opacity-range"),
  opacityValue: document.querySelector("#opacity-value"),
  rotation: document.querySelector("#rotation-range"),
  rotationValue: document.querySelector("#rotation-value"),
  font: document.querySelector("#font-select"),
  fontSize: document.querySelector("#font-size"),
  colorPicker: document.querySelector("#color-picker"),
  colorValue: document.querySelector("#color-value"),
  swatches: [...document.querySelectorAll(".swatch")],
  pdfInfo: document.querySelector("#pdf-info"),
  pageInfo: document.querySelector("#page-info"),
  previewEmpty: document.querySelector("#preview-empty"),
  pdfStage: document.querySelector("#pdf-stage"),
  pages: document.querySelector("#pdf-pages"),
  previewCaption: document.querySelector("#preview-caption"),
  previewPageCount: document.querySelector("#preview-page-count"),
  captionNote: document.querySelector("#preview-caption-note"),
  rendererStatus: document.querySelector("#renderer-status"),
  rendererStatusText: document.querySelector("#renderer-status-text"),
  refreshPreview: document.querySelector("#refresh-preview"),
  generate: document.querySelector("#generate-button"),
  generateLabel: document.querySelector("#generate-label"),
  status: document.querySelector("#status-message"),
};

const state = {
  file: null,
  fileId: null,
  pages: [],
  pdfDocument: null,
  renderVersion: 0,
  serverRequest: null,
  serverRequestVersion: 0,
  resizeTimer: null,
};

if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

function showStatus(message = "", kind = "") {
  elements.status.textContent = message;
  elements.status.className = `status-message ${kind}`.trim();
}

function setRendererStatus(message, kind = "ready") {
  elements.rendererStatusText.textContent = message;
  elements.rendererStatus.className = `renderer-status ${kind}`.trim();
}

function canProcessPdf() {
  return Boolean(state.fileId && normalizedWatermarkText().trim());
}

function updateActionButtons() {
  const enabled = canProcessPdf();
  elements.refreshPreview.disabled = !enabled;
  elements.generate.disabled = !enabled;
}

function setControlsEnabled(enabled) {
  elements.settingsCard.setAttribute("aria-disabled", String(!enabled));
  [elements.text, elements.opacity, elements.rotation, elements.font, elements.fontSize, elements.colorPicker, ...elements.swatches].forEach((control) => {
    control.disabled = !enabled;
  });
  updateActionButtons();
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatPageSize(page) {
  const width = page.width;
  const height = page.height;
  const a4 = Math.abs(width - 595.28) < 2 && Math.abs(height - 841.89) < 2;
  const letter = Math.abs(width - 612) < 2 && Math.abs(height - 792) < 2;
  const label = a4 ? "A4" : letter ? "Letter" : `${Math.round(width)} × ${Math.round(height)} pt`;
  return label;
}

function settingsPayload() {
  return {
    file_id: state.fileId,
    text: elements.text.value,
    opacity: Number(elements.opacity.value),
    rotation: Number(elements.rotation.value),
    font: elements.font.value,
    font_size: Number(elements.fontSize.value),
    color: elements.colorPicker.value.toUpperCase(),
  };
}

function updateControlReadouts() {
  elements.opacityValue.textContent = `${elements.opacity.value}%`;
  elements.rotationValue.textContent = `${Math.round(Number(elements.rotation.value))}°`;
  elements.colorValue.textContent = elements.colorPicker.value.toUpperCase();
}

function normalizedWatermarkText() {
  return elements.text.value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function updateWatermarkElement(watermarkElement) {
  const text = normalizedWatermarkText();
  watermarkElement.replaceChildren();
  if (!text.trim()) return;

  text.split("\n").forEach((line) => {
    const lineElement = document.createElement("div");
    lineElement.className = "watermark-line";
    lineElement.textContent = line || "\u00a0";
    watermarkElement.appendChild(lineElement);
  });

  watermarkElement.style.fontFamily = `'${elements.font.value}', sans-serif`;
  watermarkElement.style.fontSize = `${Math.max(8, Math.min(200, Number(elements.fontSize.value) || 40))}pt`;
  watermarkElement.style.color = elements.colorPicker.value;
  watermarkElement.style.opacity = String(Number(elements.opacity.value) / 100);
  watermarkElement.style.transform = `translate(-50%, -50%) rotate(-${Number(elements.rotation.value) || 0}deg)`;
}

function updateLiveWatermark() {
  elements.pages.querySelectorAll(".live-watermark").forEach(updateWatermarkElement);
  updateControlReadouts();
}

function setColor(value, selectedSwatch = null) {
  const textBeforeColorChange = elements.text.value;
  elements.colorPicker.value = value;
  elements.swatches.forEach((swatch) => {
    const isSelected = selectedSwatch ? swatch === selectedSwatch : swatch.dataset.color.toUpperCase() === value.toUpperCase();
    swatch.classList.toggle("selected", isSelected);
    swatch.setAttribute("aria-pressed", String(isSelected));
  });
  // Color changes must never touch the text field. Keep this guard here so a
  // browser color-picker event cannot reintroduce the default watermark.
  if (elements.text.value !== textBeforeColorChange) elements.text.value = textBeforeColorChange;
  updateLiveWatermark();
  updateActionButtons();
  setRendererStatus("Updating exact check…", "pending");
  scheduleServerPreview();
}

async function readError(response) {
  try {
    const data = await response.json();
    return data.detail || "The request could not be completed.";
  } catch (_) {
    return `Request failed (${response.status}).`;
  }
}

async function loadFonts() {
  try {
    const response = await fetch("/api/fonts");
    if (!response.ok) throw new Error(await readError(response));
    const fonts = await response.json();
    elements.font.replaceChildren();
    fonts.forEach((font) => {
      const option = document.createElement("option");
      option.value = font.name;
      option.textContent = font.thai_capable ? `${font.name} · Thai` : font.name;
      elements.font.appendChild(option);
    });
    if ([...elements.font.options].some((option) => option.value === "Kanit")) elements.font.value = "Kanit";
    updateLiveWatermark();
  } catch (error) {
    showStatus(`Could not load the server font list: ${error.message}`, "error");
  }
}

async function loadClientPdf(file) {
  if (!window.pdfjsLib) throw new Error("PDF.js could not be loaded from the CDN.");
  const buffer = await file.arrayBuffer();
  state.pdfDocument = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
}

async function renderAllPages() {
  if (!state.pdfDocument) return;
  const renderVersion = ++state.renderVersion;
  const pageCount = state.pdfDocument.numPages;
  const availableWidth = Math.max(280, elements.pdfStage.clientWidth - 44);
  elements.pages.replaceChildren();
  elements.previewPageCount.textContent = `${pageCount} ${pageCount === 1 ? "page" : "pages"}`;
  setRendererStatus(`Rendering ${pageCount} ${pageCount === 1 ? "page" : "pages"}…`, "pending");

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    if (renderVersion !== state.renderVersion) return;
    const page = await state.pdfDocument.getPage(pageNumber);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = Math.min(1.45, availableWidth / baseViewport.width);
    const viewport = page.getViewport({ scale });

    const frame = document.createElement("div");
    frame.className = "pdf-page-frame";
    const shell = document.createElement("div");
    shell.className = "pdf-page-shell";
    shell.style.width = `${Math.ceil(viewport.width)}px`;
    shell.style.height = `${Math.ceil(viewport.height)}px`;

    const canvas = document.createElement("canvas");
    canvas.className = "pdf-page-canvas";
    canvas.setAttribute("aria-label", `Page ${pageNumber} of uploaded PDF`);
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    canvas.style.width = `${Math.ceil(viewport.width)}px`;
    canvas.style.height = `${Math.ceil(viewport.height)}px`;

    const watermark = document.createElement("div");
    watermark.className = "live-watermark";
    watermark.setAttribute("aria-hidden", "true");
    shell.append(canvas, watermark);

    const pageLabel = document.createElement("div");
    pageLabel.className = "pdf-page-label";
    pageLabel.textContent = `Page ${pageNumber} of ${pageCount}`;
    frame.append(shell, pageLabel);
    elements.pages.append(frame);

    await page.render({ canvasContext: canvas.getContext("2d", { alpha: false }), viewport }).promise;
    page.cleanup();
    updateWatermarkElement(watermark);
  }

  if (renderVersion === state.renderVersion) setRendererStatus("Instant preview · exact check automatic", "ready");
}

async function uploadFile(file) {
  if (!file) return;
  if (file.size > MAX_UPLOAD_BYTES) {
    showStatus("That PDF is larger than 50 MB.", "error");
    return;
  }
  if (file.type && file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
    showStatus("Please choose a PDF file.", "error");
    return;
  }

  showStatus("Reading your PDF…");
  setControlsEnabled(false);
  try {
    const formData = new FormData();
    formData.append("file", file, file.name);
    const response = await fetch("/api/upload", { method: "POST", body: formData });
    if (!response.ok) throw new Error(await readError(response));
    const data = await response.json();
    state.file = file;
    state.fileId = data.file_id;
    state.pages = data.pages;
    elements.fileName.textContent = file.name;
    elements.fileMeta.textContent = `${formatBytes(file.size)} · ${data.page_count} ${data.page_count === 1 ? "page" : "pages"}`;
    elements.fileSummary.hidden = false;
    elements.dropzone.hidden = true;
    elements.pdfInfo.hidden = false;
    elements.pageInfo.textContent = `${data.page_count} ${data.page_count === 1 ? "page" : "pages"} · first page ${formatPageSize(data.pages[0])}`;
    elements.previewEmpty.hidden = true;
    elements.pdfStage.hidden = false;
    elements.previewCaption.hidden = false;
    setControlsEnabled(true);
    await loadClientPdf(file);
    await renderAllPages();
    showStatus("PDF ready. Adjust the mark to your liking.", "success");
    setRendererStatus("Updating exact check…", "pending");
    requestServerPreview();
  } catch (error) {
    resetFile(false);
    showStatus(error.message || "Could not upload that PDF.", "error");
  }
}

function resetFile(showMessage = true) {
  state.file = null;
  state.fileId = null;
  state.pages = [];
  state.renderVersion += 1;
  if (state.serverRequest) state.serverRequest.abort();
  if (state.pdfDocument) state.pdfDocument.destroy().catch(() => {});
  state.pdfDocument = null;
  elements.fileInput.value = "";
  elements.fileSummary.hidden = true;
  elements.dropzone.hidden = false;
  elements.pdfInfo.hidden = true;
  elements.previewEmpty.hidden = false;
  elements.pdfStage.hidden = true;
  elements.previewCaption.hidden = true;
  elements.pages.replaceChildren();
  setControlsEnabled(false);
  setRendererStatus("Instant preview", "ready");
  if (showMessage) showStatus("PDF removed. Choose another file when you are ready.");
}

async function requestServerPreview() {
  if (!canProcessPdf()) {
    setRendererStatus("Enter watermark text", "ready");
    return;
  }
  const version = ++state.serverRequestVersion;
  if (state.serverRequest) state.serverRequest.abort();
  state.serverRequest = new AbortController();
  setRendererStatus("Updating exact check…", "pending");
  try {
    const response = await fetch("/api/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settingsPayload()),
      signal: state.serverRequest.signal,
    });
    if (!response.ok) throw new Error(await readError(response));
    await response.blob();
    if (version !== state.serverRequestVersion) return;
    setRendererStatus("Exact check complete", "checked");
    elements.captionNote.textContent = "Live on every page · server checked automatically";
  } catch (error) {
    if (error.name !== "AbortError") {
      setRendererStatus("Live preview", "ready");
      showStatus(error.message || "Could not render the server check.", "error");
    }
  } finally {
    if (version === state.serverRequestVersion) {
      state.serverRequest = null;
    }
  }
}

let serverPreviewTimer;
function scheduleServerPreview() {
  if (!state.fileId) return;
  window.clearTimeout(serverPreviewTimer);
  if (!normalizedWatermarkText().trim()) {
    if (state.serverRequest) state.serverRequest.abort();
    setRendererStatus("Enter watermark text", "ready");
    updateActionButtons();
    return;
  }
  serverPreviewTimer = window.setTimeout(requestServerPreview, 400);
}

async function generatePdf() {
  if (!canProcessPdf()) return;
  elements.generate.disabled = true;
  elements.refreshPreview.disabled = true;
  elements.generateLabel.textContent = "Preparing PDF…";
  showStatus("Applying the watermark to every page…");
  try {
    const response = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settingsPayload()),
    });
    if (!response.ok) throw new Error(await readError(response));
    const blob = await response.blob();
    const disposition = response.headers.get("Content-Disposition") || "";
    const match = disposition.match(/filename="?([^";]+)"?/i);
    const filename = match ? match[1] : "watermarked.pdf";
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    showStatus("Done — your watermarked PDF is ready.", "success");
  } catch (error) {
    showStatus(error.message || "Could not generate the PDF.", "error");
  } finally {
    elements.generateLabel.textContent = "Apply & Download";
    updateActionButtons();
  }
}

elements.fileInput.addEventListener("change", (event) => uploadFile(event.target.files[0]));
elements.removeFile.addEventListener("click", () => resetFile(true));
elements.dropzone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    elements.fileInput.click();
  }
});
["dragenter", "dragover"].forEach((eventName) => elements.dropzone.addEventListener(eventName, (event) => {
  event.preventDefault();
  elements.dropzone.classList.add("dragging");
}));
["dragleave", "drop"].forEach((eventName) => elements.dropzone.addEventListener(eventName, (event) => {
  event.preventDefault();
  elements.dropzone.classList.remove("dragging");
}));
elements.dropzone.addEventListener("drop", (event) => uploadFile(event.dataTransfer.files[0]));

elements.font.addEventListener("change", () => { updateLiveWatermark(); setRendererStatus("Updating exact check…", "pending"); scheduleServerPreview(); });
elements.text.addEventListener("input", () => {
  updateLiveWatermark();
  updateActionButtons();
  if (normalizedWatermarkText().trim()) setRendererStatus("Updating exact check…", "pending");
  scheduleServerPreview();
});
elements.opacity.addEventListener("input", () => { updateLiveWatermark(); setRendererStatus("Updating exact check…", "pending"); scheduleServerPreview(); });
elements.rotation.addEventListener("input", () => { updateLiveWatermark(); setRendererStatus("Updating exact check…", "pending"); scheduleServerPreview(); });
elements.fontSize.addEventListener("input", () => { updateLiveWatermark(); setRendererStatus("Updating exact check…", "pending"); scheduleServerPreview(); });
elements.colorPicker.addEventListener("input", () => setColor(elements.colorPicker.value));
elements.swatches.forEach((swatch) => swatch.addEventListener("click", () => setColor(swatch.dataset.color, swatch)));
elements.refreshPreview.addEventListener("click", requestServerPreview);
elements.generate.addEventListener("click", generatePdf);
window.addEventListener("resize", () => {
  if (!state.file) return;
  window.clearTimeout(state.resizeTimer);
  state.resizeTimer = window.setTimeout(() => renderAllPages().catch((error) => showStatus(error.message, "error")), 150);
});

setControlsEnabled(false);
updateLiveWatermark();
loadFonts();
