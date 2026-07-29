/* global pdfjsLib */

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const SUPPORTED_FILE_EXTENSIONS = /\.(pdf|jpe?g|png|webp|tiff?|gif|bmp)$/i;
const SUPPORTED_IMAGE_EXTENSIONS = /\.(jpe?g|png|webp|tiff?|gif|bmp)$/i;
const SUPPORTED_FILE_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/tiff",
  "image/gif",
  "image/bmp",
]);

const elements = {
  hero: document.querySelector("#editor-hero"),
  heroUpload: document.querySelector("#hero-upload-button"),
  visitCounter: document.querySelector("#visit-counter"),
  visitCount: document.querySelector("#visit-count"),
  compactFileName: document.querySelector("#compact-file-name"),
  compactFileMeta: document.querySelector("#compact-file-meta"),
  compactChange: document.querySelector("#compact-change-button"),
  stepButtons: [...document.querySelectorAll(".step-button")],
  sectionPanels: [...document.querySelectorAll("[data-section-panel]")],
  fileInput: document.querySelector("#file-input"),
  dropzone: document.querySelector("#dropzone"),
  fileSummary: document.querySelector("#file-summary"),
  uploadCard: document.querySelector(".upload-card"),
  workflowPreview: document.querySelector("#workflow-preview"),
  fileError: document.querySelector("#file-error"),
  previewLink: document.querySelector("#preview-link"),
  fileName: document.querySelector("#file-name"),
  fileMeta: document.querySelector("#file-meta"),
  fileBadge: document.querySelector("#file-badge"),
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
  imageCard: document.querySelector("#image-card"),
  imageInput: document.querySelector("#page-image-input"),
  imageDropzone: document.querySelector("#image-dropzone"),
  imageSummary: document.querySelector("#image-summary"),
  insertedPageCount: document.querySelector("#inserted-page-count"),
  removeInsertedPages: document.querySelector("#remove-inserted-pages"),
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
  zoomOut: document.querySelector("#zoom-out"),
  zoomIn: document.querySelector("#zoom-in"),
  zoomValue: document.querySelector("#zoom-value"),
  fitPreview: document.querySelector("#fit-preview"),
  actualSize: document.querySelector("#actual-size"),
  exportReady: document.querySelector("#export-ready"),
  exportReadyText: document.querySelector("#export-ready-text"),
  exportStatus: document.querySelector("#export-status"),
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
  pageOrder: [],
  insertedDocuments: new Map(),
  newlyInsertedKeys: new Set(),
  draggedPageKey: null,
  activeSection: "upload",
  zoomMode: "fit",
  zoomLevel: 1,
  lastFitScale: 1,
};

if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

function showStatus(message = "", kind = "") {
  const isUploadError = kind === "error" && !state.fileId;
  elements.status.textContent = isUploadError ? "" : message;
  elements.status.className = `status-message ${kind}`.trim();
  elements.status.setAttribute("role", kind === "error" && !isUploadError ? "alert" : "status");
  elements.fileError.textContent = isUploadError ? message : "";
  elements.fileError.hidden = !isUploadError;
}

function setRendererStatus(message, kind = "ready") {
  elements.rendererStatusText.textContent = message;
  elements.rendererStatus.className = `renderer-status ${kind}`.trim();
  elements.rendererStatus.setAttribute("aria-busy", String(kind === "pending"));
}

function selectEditorSection(section) {
  const hasDocument = Boolean(state.fileId);
  const target = !hasDocument && section !== "upload" ? "upload" : section;
  state.activeSection = target;
  elements.stepButtons.forEach((button) => {
    const isActive = button.dataset.editorSection === target;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-expanded", String(isActive));
    if (isActive) button.setAttribute("aria-current", "step");
    else button.removeAttribute("aria-current");
  });
  elements.sectionPanels.forEach((panel) => {
    const isActive = panel.dataset.sectionPanel === target;
    panel.classList.toggle("active", isActive);
    panel.hidden = !isActive;
  });
  updateStepStates();
}

function updateStepStates() {
  const hasDocument = Boolean(state.fileId);
  const insertedCount = state.pageOrder.filter((page) => page.kind === "image").length;
  const completed = {
    upload: hasDocument,
    watermark: hasDocument && Boolean(normalizedWatermarkText().trim()),
    pages: insertedCount > 0,
    export: false,
  };
  elements.stepButtons.forEach((button) => {
    const section = button.dataset.editorSection;
    button.disabled = section !== "upload" && !hasDocument;
    button.classList.toggle("complete", completed[section] && section !== state.activeSection);
  });
}

function updateExportState() {
  const ready = canProcessPdf();
  elements.exportReady.classList.toggle("waiting", !ready);
  elements.exportReadyText.textContent = ready ? "Ready" : "Waiting";
  if (!state.fileId) elements.exportStatus.textContent = "Upload a document to continue";
  else if (!normalizedWatermarkText().trim()) elements.exportStatus.textContent = "Enter watermark text to continue";
  else elements.exportStatus.textContent = `${state.pageOrder.length} ${state.pageOrder.length === 1 ? "page" : "pages"} ready to export`;
}

function setDocumentUI(hasDocument) {
  document.body.classList.toggle("has-document", hasDocument);
  [elements.zoomOut, elements.zoomIn, elements.fitPreview, elements.actualSize].forEach((control) => {
    control.disabled = !hasDocument;
  });
  if (hasDocument) {
    elements.compactFileName.textContent = state.file?.name || "Document ready";
    elements.compactFileMeta.textContent = elements.fileMeta.textContent || "Live preview active";
  } else {
    state.zoomMode = "fit";
    state.zoomLevel = 1;
    elements.zoomValue.textContent = "—";
  }
  updateStepStates();
  updateExportState();
}

function canProcessPdf() {
  return Boolean(state.fileId && normalizedWatermarkText().trim());
}

function updateActionButtons() {
  const enabled = canProcessPdf();
  elements.refreshPreview.disabled = !enabled;
  elements.generate.disabled = !enabled;
  updateStepStates();
  updateExportState();
}

function setControlsEnabled(enabled) {
  elements.settingsCard.setAttribute("aria-disabled", String(!enabled));
  elements.imageCard.setAttribute("aria-disabled", String(!enabled));
  elements.workflowPreview.hidden = enabled;
  elements.previewLink.hidden = !enabled;
  [elements.text, elements.opacity, elements.rotation, elements.font, elements.fontSize, elements.colorPicker, ...elements.swatches].forEach((control) => {
    control.disabled = !enabled;
  });
  elements.imageInput.disabled = !enabled;
  elements.imageDropzone.tabIndex = enabled ? 0 : -1;
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
  const hasCustomPageOrder = state.pageOrder.some((page, index) => (
    page.kind !== "source" || page.pageNumber !== index + 1
  ));
  return {
    file_id: state.fileId,
    text: elements.text.value,
    opacity: Number(elements.opacity.value),
    rotation: Number(elements.rotation.value),
    font: elements.font.value,
    font_size: Number(elements.fontSize.value),
    color: elements.colorPicker.value.toUpperCase(),
    page_order: hasCustomPageOrder
      ? state.pageOrder.map((page) => (
        page.kind === "source"
          ? { source_page: page.pageNumber }
          : { image_id: page.imageId, image_page: page.pageNumber }
      ))
      : null,
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
  setRendererStatus("Checking preview…", "pending");
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

async function recordVisit() {
  try {
    const response = await fetch("/api/visit", { method: "POST" });
    if (!response.ok) return;
    const data = await response.json();
    elements.visitCount.textContent = Number(data.count).toLocaleString();
    elements.visitCounter.hidden = false;
  } catch (_) {
    // Visit counter is a non-essential nicety; fail silently offline.
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

async function loadClientPdf(fileId) {
  if (!window.pdfjsLib) throw new Error("PDF.js could not be loaded from the CDN.");
  const response = await fetch(`/api/document/${encodeURIComponent(fileId)}`, { cache: "no-store" });
  if (!response.ok) throw new Error(await readError(response));
  const buffer = await response.arrayBuffer();
  state.pdfDocument = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
  state.pageOrder = Array.from({ length: state.pdfDocument.numPages }, (_, index) => ({
    key: `source:${index + 1}`,
    kind: "source",
    pageNumber: index + 1,
    document: state.pdfDocument,
  }));
}

async function loadInsertedPdf(imageId) {
  const response = await fetch(`/api/page-image/${encodeURIComponent(imageId)}`, { cache: "no-store" });
  if (!response.ok) throw new Error(await readError(response));
  const buffer = await response.arrayBuffer();
  return pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
}

function updateInsertedPagesSummary() {
  const insertedCount = state.pageOrder.filter((page) => page.kind === "image").length;
  elements.imageSummary.hidden = insertedCount === 0;
  elements.insertedPageCount.textContent = `${insertedCount} image ${insertedCount === 1 ? "page" : "pages"} inserted`;
  elements.previewPageCount.textContent = `${state.pageOrder.length} ${state.pageOrder.length === 1 ? "page" : "pages"}`;
  if (state.fileId && state.pages.length) {
    const insertedNote = insertedCount ? ` · ${insertedCount} inserted` : "";
    elements.pageInfo.textContent = `${state.pageOrder.length} ${state.pageOrder.length === 1 ? "page" : "pages"}${insertedNote} · first source page ${formatPageSize(state.pages[0])}`;
  }
  updateStepStates();
  updateExportState();
}

async function renderAllPages() {
  if (!state.pdfDocument) return;
  const renderVersion = ++state.renderVersion;
  const pageCount = state.pageOrder.length;
  const availableWidth = Math.max(280, elements.pdfStage.clientWidth - 56);
  elements.pages.replaceChildren();
  updateInsertedPagesSummary();
  setRendererStatus(`Rendering ${pageCount} ${pageCount === 1 ? "page" : "pages"}…`, "pending");

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    if (renderVersion !== state.renderVersion) return;
    const pageRecord = state.pageOrder[pageIndex];
    const page = await pageRecord.document.getPage(pageRecord.pageNumber);
    const baseViewport = page.getViewport({ scale: 1 });
    const fitScale = Math.min(1.45, availableWidth / baseViewport.width);
    if (pageIndex === 0) {
      state.lastFitScale = fitScale;
      const displayedScale = state.zoomMode === "fit" ? fitScale : state.zoomLevel;
      elements.zoomValue.textContent = `${Math.round(displayedScale * 100)}%`;
      elements.fitPreview.classList.toggle("active", state.zoomMode === "fit");
      elements.actualSize.classList.toggle("active", state.zoomMode === "custom" && state.zoomLevel === 1);
      elements.fitPreview.setAttribute("aria-pressed", String(state.zoomMode === "fit"));
      elements.actualSize.setAttribute("aria-pressed", String(state.zoomMode === "custom" && state.zoomLevel === 1));
    }
    const scale = state.zoomMode === "fit" ? fitScale : state.zoomLevel;
    const viewport = page.getViewport({ scale });

    const frame = document.createElement("div");
    frame.className = "pdf-page-frame";
    frame.dataset.pageKey = pageRecord.key;
    const shouldAnimate = state.newlyInsertedKeys.has(pageRecord.key);
    const shell = document.createElement("div");
    shell.className = "pdf-page-shell";
    shell.style.width = `${Math.ceil(viewport.width)}px`;
    shell.style.height = `${Math.ceil(viewport.height)}px`;

    const canvas = document.createElement("canvas");
    canvas.className = "pdf-page-canvas";
    canvas.setAttribute("aria-label", `Page ${pageIndex + 1} of arranged document`);
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    canvas.style.width = `${Math.ceil(viewport.width)}px`;
    canvas.style.height = `${Math.ceil(viewport.height)}px`;

    const watermark = document.createElement("div");
    watermark.className = "live-watermark";
    watermark.setAttribute("aria-hidden", "true");
    shell.append(canvas, watermark);

    const pageFooter = document.createElement("div");
    pageFooter.className = "pdf-page-footer";
    const pageLabel = document.createElement("span");
    pageLabel.className = "pdf-page-label";
    pageLabel.textContent = `Page ${pageIndex + 1} of ${pageCount}${pageRecord.kind === "image" ? " · image" : ""}`;
    const dragHandle = document.createElement("button");
    dragHandle.type = "button";
    dragHandle.className = "page-drag-handle";
    dragHandle.draggable = true;
    dragHandle.dataset.pageKey = pageRecord.key;
    dragHandle.setAttribute("aria-label", `Move page ${pageIndex + 1}. Drag, or use Shift and arrow keys.`);
    dragHandle.textContent = "Move page";
    pageFooter.append(pageLabel, dragHandle);
    if (pageRecord.kind === "image") {
      const removePage = document.createElement("button");
      removePage.type = "button";
      removePage.className = "remove-page-button";
      removePage.dataset.pageKey = pageRecord.key;
      removePage.setAttribute("aria-label", `Remove inserted image page ${pageIndex + 1}`);
      removePage.textContent = "Remove";
      pageFooter.append(removePage);
    }
    frame.append(shell, pageFooter);
    elements.pages.append(frame);

    await page.render({ canvasContext: canvas.getContext("2d", { alpha: false }), viewport }).promise;
    page.cleanup();
    updateWatermarkElement(watermark);
    if (shouldAnimate) {
      void frame.offsetWidth;
      frame.classList.add("is-inserting");
    }
    state.newlyInsertedKeys.delete(pageRecord.key);
  }

  if (renderVersion === state.renderVersion) setRendererStatus("Live preview", "ready");
}

async function uploadFile(file) {
  if (!file) return;
  if (file.size > MAX_UPLOAD_BYTES) {
    showStatus("That file is larger than 50 MB.", "error");
    return;
  }
  const isImageType = file.type.startsWith("image/");
  if (!SUPPORTED_FILE_TYPES.has(file.type) && !isImageType && !SUPPORTED_FILE_EXTENSIONS.test(file.name)) {
    showStatus("Please choose a PDF, JPEG, PNG, WebP, TIFF, GIF, or BMP file.", "error");
    return;
  }

  showStatus("Uploading and preparing your file…");
  elements.uploadCard.setAttribute("aria-busy", "true");
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
    elements.fileBadge.textContent = data.source_type === "image" ? "IMG" : "PDF";
    elements.fileBadge.classList.toggle("image-badge", data.source_type === "image");
    elements.fileSummary.hidden = false;
    elements.dropzone.hidden = true;
    elements.pdfInfo.hidden = false;
    elements.pageInfo.textContent = `${data.page_count} ${data.page_count === 1 ? "page" : "pages"} · first page ${formatPageSize(data.pages[0])}`;
    elements.previewEmpty.hidden = true;
    elements.pdfStage.hidden = false;
    elements.previewCaption.hidden = false;
    setControlsEnabled(true);
    setDocumentUI(true);
    selectEditorSection("watermark");
    await loadClientPdf(data.file_id);
    await renderAllPages();
    showStatus(`${data.source_type === "image" ? data.source_format : "PDF"} ready. Adjust the mark to your liking.`, "success");
    setRendererStatus("Checking preview…", "pending");
    requestServerPreview();
  } catch (error) {
    resetFile(false);
    showStatus(error.message || "Could not upload that file.", "error");
  } finally {
    elements.uploadCard.setAttribute("aria-busy", "false");
  }
}

async function uploadPageImages(files, insertIndex = state.pageOrder.length) {
  const images = [...files].filter(Boolean);
  if (!images.length || !state.fileId) return;
  for (const file of images) {
    const isSupportedImage = file.type.startsWith("image/") || SUPPORTED_IMAGE_EXTENSIONS.test(file.name);
    if (!isSupportedImage) {
      showStatus(`${file.name} is not a supported image.`, "error");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      showStatus(`${file.name} is larger than 50 MB.`, "error");
      return;
    }
  }

  elements.imageDropzone.classList.add("uploading");
  showStatus(`Preparing ${images.length} image ${images.length === 1 ? "page" : "pages"}…`);
  let nextIndex = Math.min(Math.max(insertIndex, 0), state.pageOrder.length);
  let insertedCount = 0;
  try {
    for (const file of images) {
      const formData = new FormData();
      formData.append("file", file, file.name);
      const response = await fetch("/api/page-image", { method: "POST", body: formData });
      if (!response.ok) throw new Error(await readError(response));
      const data = await response.json();
      const document = await loadInsertedPdf(data.image_id);
      state.insertedDocuments.set(data.image_id, document);
      const records = Array.from({ length: data.page_count }, (_, index) => ({
        key: `image:${data.image_id}:${index + 1}`,
        kind: "image",
        imageId: data.image_id,
        pageNumber: index + 1,
        document,
        filename: file.name,
      }));
      records.forEach((record) => state.newlyInsertedKeys.add(record.key));
      state.pageOrder.splice(nextIndex, 0, ...records);
      nextIndex += records.length;
      insertedCount += records.length;
    }
    await renderAllPages();
    elements.captionNote.textContent = "Drag any page to change its position";
    setRendererStatus("Checking preview…", "pending");
    scheduleServerPreview();
    showStatus(`${insertedCount} image ${insertedCount === 1 ? "page" : "pages"} inserted. Drag to reorder.`, "success");
  } catch (error) {
    await renderAllPages();
    showStatus(error.message || "Could not insert those image pages.", "error");
  } finally {
    elements.imageDropzone.classList.remove("uploading");
    elements.imageInput.value = "";
  }
}

function cleanupUnusedInsertedDocuments() {
  for (const [imageId, document] of state.insertedDocuments.entries()) {
    const stillUsed = state.pageOrder.some((page) => page.imageId === imageId);
    if (!stillUsed) {
      document.destroy().catch(() => {});
      state.insertedDocuments.delete(imageId);
    }
  }
}

async function removeInsertedPage(pageKey, showMessage = true) {
  const index = state.pageOrder.findIndex((page) => page.key === pageKey && page.kind === "image");
  if (index < 0) return;
  state.pageOrder.splice(index, 1);
  cleanupUnusedInsertedDocuments();
  await renderAllPages();
  setRendererStatus("Checking preview…", "pending");
  scheduleServerPreview();
  if (showMessage) showStatus("Inserted image page removed.");
}

async function resetInsertedPages(showMessage = true) {
  state.pageOrder = state.pageOrder.filter((page) => page.kind === "source");
  cleanupUnusedInsertedDocuments();
  state.newlyInsertedKeys.clear();
  elements.imageInput.value = "";
  elements.captionNote.textContent = "Drop images between pages · drag pages to reorder";
  if (state.pdfDocument) await renderAllPages();
  if (state.fileId) {
    setRendererStatus("Checking preview…", "pending");
    scheduleServerPreview();
  }
  if (showMessage) showStatus("All inserted image pages removed.");
}

function resetFile(showMessage = true) {
  state.pageOrder = [];
  state.newlyInsertedKeys.clear();
  for (const document of state.insertedDocuments.values()) document.destroy().catch(() => {});
  state.insertedDocuments.clear();
  state.draggedPageKey = null;
  elements.imageInput.value = "";
  elements.imageSummary.hidden = true;
  state.file = null;
  state.fileId = null;
  state.pages = [];
  state.renderVersion += 1;
  if (state.serverRequest) state.serverRequest.abort();
  if (state.pdfDocument) state.pdfDocument.destroy().catch(() => {});
  state.pdfDocument = null;
  elements.fileInput.value = "";
  elements.fileSummary.hidden = true;
  elements.fileBadge.textContent = "PDF";
  elements.fileBadge.classList.remove("image-badge");
  elements.dropzone.hidden = false;
  elements.pdfInfo.hidden = true;
  elements.previewEmpty.hidden = false;
  elements.pdfStage.hidden = true;
  elements.previewCaption.hidden = true;
  elements.pages.replaceChildren();
  setControlsEnabled(false);
  setDocumentUI(false);
  selectEditorSection("upload");
  setRendererStatus("Waiting for document", "ready");
  if (showMessage) showStatus("File removed. Choose another when you are ready.");
}

async function requestServerPreview() {
  if (!canProcessPdf()) {
    setRendererStatus("Enter watermark text", "ready");
    return;
  }
  const version = ++state.serverRequestVersion;
  if (state.serverRequest) state.serverRequest.abort();
  state.serverRequest = new AbortController();
  setRendererStatus("Checking preview…", "pending");
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
    setRendererStatus("Preview ready", "checked");
    elements.captionNote.textContent = state.pageOrder.some((page) => page.kind === "image")
      ? "Page order ready · drag any page to adjust"
      : "Drop images between pages · drag pages to reorder";
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
  if (!canProcessPdf()) {
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
  elements.generateLabel.textContent = "Preparing your PDF…";
  showStatus("Arranging pages and applying the watermark…");
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
    elements.generateLabel.textContent = "Generate watermarked PDF";
    updateActionButtons();
  }
}

async function setPreviewZoom(mode, level = state.zoomLevel) {
  if (!state.pdfDocument) return;
  state.zoomMode = mode;
  state.zoomLevel = Math.min(2, Math.max(.5, Math.round(level * 10) / 10));
  await renderAllPages();
}

elements.heroUpload.addEventListener("click", () => elements.fileInput.click());
elements.compactChange.addEventListener("click", () => selectEditorSection("upload"));
elements.stepButtons.forEach((button) => {
  button.addEventListener("click", () => selectEditorSection(button.dataset.editorSection));
});
elements.zoomOut.addEventListener("click", () => {
  const currentScale = state.zoomMode === "fit" ? state.lastFitScale : state.zoomLevel;
  setPreviewZoom("custom", currentScale - .1);
});
elements.zoomIn.addEventListener("click", () => {
  const currentScale = state.zoomMode === "fit" ? state.lastFitScale : state.zoomLevel;
  setPreviewZoom("custom", currentScale + .1);
});
elements.fitPreview.addEventListener("click", () => setPreviewZoom("fit"));
elements.actualSize.addEventListener("click", () => setPreviewZoom("custom", 1));

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

["dragenter", "dragover"].forEach((eventName) => elements.hero.addEventListener(eventName, (event) => {
  if (state.fileId || !event.dataTransfer.types.includes("Files")) return;
  event.preventDefault();
  elements.hero.classList.add("dragging");
}));
["dragleave", "drop"].forEach((eventName) => elements.hero.addEventListener(eventName, (event) => {
  if (eventName === "dragleave" && elements.hero.contains(event.relatedTarget)) return;
  elements.hero.classList.remove("dragging");
}));
elements.hero.addEventListener("drop", (event) => {
  if (state.fileId) return;
  event.preventDefault();
  uploadFile(event.dataTransfer.files[0]);
});

elements.imageInput.addEventListener("change", (event) => uploadPageImages(event.target.files));
elements.removeInsertedPages.addEventListener("click", () => resetInsertedPages());
elements.imageDropzone.addEventListener("keydown", (event) => {
  if ((event.key === "Enter" || event.key === " ") && !elements.imageInput.disabled) {
    event.preventDefault();
    elements.imageInput.click();
  }
});
["dragenter", "dragover"].forEach((eventName) => elements.imageDropzone.addEventListener(eventName, (event) => {
  if (elements.imageInput.disabled) return;
  event.preventDefault();
  elements.imageDropzone.classList.add("dragging");
}));
["dragleave", "drop"].forEach((eventName) => elements.imageDropzone.addEventListener(eventName, (event) => {
  event.preventDefault();
  elements.imageDropzone.classList.remove("dragging");
}));
elements.imageDropzone.addEventListener("drop", (event) => {
  if (!elements.imageInput.disabled) uploadPageImages(event.dataTransfer.files);
});

function clearPageDropTargets() {
  elements.pages.querySelectorAll(".insert-before, .insert-after").forEach((frame) => {
    frame.classList.remove("insert-before", "insert-after");
  });
  elements.pages.classList.remove("insert-at-end");
}

function pageDropBoundary(event) {
  const frames = [...elements.pages.querySelectorAll(".pdf-page-frame")];
  const nextIndex = frames.findIndex((frame) => {
    const rect = frame.getBoundingClientRect();
    return event.clientY < rect.top + rect.height / 2;
  });
  return nextIndex < 0 ? frames.length : nextIndex;
}

function showPageDropTarget(boundary) {
  clearPageDropTargets();
  const frames = [...elements.pages.querySelectorAll(".pdf-page-frame")];
  if (!frames.length || boundary >= frames.length) {
    elements.pages.classList.add("insert-at-end");
    return;
  }
  frames[boundary].classList.add("insert-before");
}

async function movePageToIndex(pageKey, targetIndex) {
  const oldIndex = state.pageOrder.findIndex((page) => page.key === pageKey);
  if (oldIndex < 0) return;
  const finalIndex = Math.min(Math.max(targetIndex, 0), state.pageOrder.length - 1);
  if (oldIndex === finalIndex) return;
  const [page] = state.pageOrder.splice(oldIndex, 1);
  state.pageOrder.splice(finalIndex, 0, page);
  state.newlyInsertedKeys.add(page.key);
  await renderAllPages();
  setRendererStatus("Checking preview…", "pending");
  scheduleServerPreview();
  showStatus(`Page moved to position ${finalIndex + 1}.`, "success");
}

elements.pages.addEventListener("dragstart", (event) => {
  const handle = event.target.closest(".page-drag-handle");
  if (!handle) return;
  state.draggedPageKey = handle.dataset.pageKey;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("application/x-watermarkpdf-page", state.draggedPageKey);
  window.requestAnimationFrame(() => {
    handle.closest(".pdf-page-frame")?.classList.add("is-page-dragging");
  });
});
elements.pages.addEventListener("dragend", () => {
  state.draggedPageKey = null;
  elements.pages.querySelectorAll(".is-page-dragging").forEach((frame) => frame.classList.remove("is-page-dragging"));
  clearPageDropTargets();
});
elements.pages.addEventListener("dragover", (event) => {
  if (!state.fileId) return;
  const isPageMove = Boolean(state.draggedPageKey);
  const isFileDrop = event.dataTransfer.types.includes("Files");
  if (!isPageMove && !isFileDrop) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = isPageMove ? "move" : "copy";
  const boundary = pageDropBoundary(event);
  showPageDropTarget(boundary);
});
elements.pages.addEventListener("dragleave", (event) => {
  if (!elements.pages.contains(event.relatedTarget)) clearPageDropTargets();
});
elements.pages.addEventListener("drop", (event) => {
  if (!state.fileId) return;
  const boundary = pageDropBoundary(event);
  event.preventDefault();
  clearPageDropTargets();
  if (state.draggedPageKey) {
    const oldIndex = state.pageOrder.findIndex((page) => page.key === state.draggedPageKey);
    const finalIndex = boundary > oldIndex ? boundary - 1 : boundary;
    const pageKey = state.draggedPageKey;
    state.draggedPageKey = null;
    movePageToIndex(pageKey, finalIndex);
  } else if (event.dataTransfer.files.length) {
    uploadPageImages(event.dataTransfer.files, boundary);
  }
});

elements.pages.addEventListener("click", (event) => {
  const removeButton = event.target.closest(".remove-page-button");
  if (removeButton) removeInsertedPage(removeButton.dataset.pageKey);
});
elements.pages.addEventListener("keydown", (event) => {
  const handle = event.target.closest(".page-drag-handle");
  if (!handle || !event.shiftKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
  event.preventDefault();
  const oldIndex = state.pageOrder.findIndex((page) => page.key === handle.dataset.pageKey);
  const targetIndex = oldIndex + (event.key === "ArrowUp" ? -1 : 1);
  movePageToIndex(handle.dataset.pageKey, targetIndex);
});

elements.font.addEventListener("change", () => { updateLiveWatermark(); setRendererStatus("Checking preview…", "pending"); scheduleServerPreview(); });
elements.text.addEventListener("input", () => {
  updateLiveWatermark();
  updateActionButtons();
  if (canProcessPdf()) setRendererStatus("Checking preview…", "pending");
  scheduleServerPreview();
});
elements.opacity.addEventListener("input", () => { updateLiveWatermark(); setRendererStatus("Checking preview…", "pending"); scheduleServerPreview(); });
elements.rotation.addEventListener("input", () => { updateLiveWatermark(); setRendererStatus("Checking preview…", "pending"); scheduleServerPreview(); });
elements.fontSize.addEventListener("input", () => { updateLiveWatermark(); setRendererStatus("Checking preview…", "pending"); scheduleServerPreview(); });
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
setDocumentUI(false);
selectEditorSection("upload");
updateLiveWatermark();
loadFonts();
recordVisit();
