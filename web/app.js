import { createJourney, formatPeriod, listAvailableMonths, monthKey } from "./lib/journey.js";
import { TimelineRenderer } from "./lib/renderer.js";
import { TileCache } from "./lib/tile-cache.js";
import { parseTimelineJson } from "./lib/timeline-parser.js";
import {
  canvasToPngBlob,
  deliverFile,
  pickVideoMimeType,
  recordTimelineVideo,
} from "./lib/video-exporter.js";

const elements = Object.fromEntries(
  [
    "fileInput",
    "dropZone",
    "fileName",
    "loadSummary",
    "workspace",
    "startMonth",
    "endMonth",
    "travelerName",
    "titleTemplate",
    "duration",
    "withMap",
    "previewButton",
    "imageButton",
    "videoButton",
    "cancelButton",
    "canvas",
    "status",
    "progress",
    "progressLabel",
    "journeySummary",
    "resultPanel",
    "resultSummary",
    "resultButton",
    "resultMedia",
    "videoSupport",
  ].map((id) => [id, document.getElementById(id)]),
);

const state = {
  points: [],
  months: [],
  journey: null,
  sourceName: "Timeline.json",
  busy: false,
  controller: null,
  activeWorker: null,
  animationFrame: 0,
  lastDraw: { progress: 0, outro: 0, overview: false },
  result: null,
  resultUrl: null,
};

const tileCache = new TileCache();
const renderer = new TimelineRenderer(tileCache);
renderer.onInvalidate = () => {
  if (!state.busy && state.journey) drawCurrentFrame();
};

elements.canvas.width = 720;
elements.canvas.height = 720;
drawPlaceholder();
restorePreferences();
updateVideoSupport();
registerServiceWorker();

for (const input of [elements.startMonth, elements.endMonth]) {
  input.addEventListener("change", refreshJourney);
}
for (const input of [elements.travelerName, elements.titleTemplate]) {
  input.addEventListener("input", () => {
    savePreferences();
    if (state.journey && !state.busy) drawCurrentFrame();
  });
}
elements.duration.addEventListener("change", savePreferences);
elements.withMap.addEventListener("change", handleMapToggle);
elements.fileInput.addEventListener("change", () => {
  const file = elements.fileInput.files?.[0];
  if (file) loadTimelineFile(file);
});
elements.previewButton.addEventListener("click", previewJourney);
elements.imageButton.addEventListener("click", createOverviewImage);
elements.videoButton.addEventListener("click", createVideo);
elements.cancelButton.addEventListener("click", cancelActiveTask);
elements.resultButton.addEventListener("click", saveResult);

for (const eventName of ["dragenter", "dragover"]) {
  elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.add("is-dragging");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.remove("is-dragging");
  });
}
elements.dropZone.addEventListener("drop", (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (file) loadTimelineFile(file);
});

async function loadTimelineFile(file) {
  cancelActiveTask();
  clearResult();
  setBusy(true, "Timeline JSONを端末内で解析しています…", false);
  elements.fileName.textContent = file.name;
  elements.loadSummary.textContent = formatBytes(file.size);
  try {
    const points = await parseFileInWorker(file);
    state.points = points;
    state.months = listAvailableMonths(points);
    state.sourceName = file.name;
    configurePeriodInputs();
    refreshJourney();
    elements.workspace.hidden = false;
    setStatus(`${points.length.toLocaleString()}地点を読み込みました。JSONはアップロードされていません。`, "success");
  } catch (error) {
    state.points = [];
    state.journey = null;
    elements.workspace.hidden = true;
    setStatus(error instanceof Error ? error.message : String(error), "error");
  } finally {
    setBusy(false);
  }
}

async function parseFileInWorker(file) {
  if (typeof Worker === "undefined") {
    return parseTimelineJson(await file.text());
  }
  const id = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  const worker = new Worker(new URL("./parser-worker.js", import.meta.url), { type: "module" });
  state.activeWorker = worker;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      worker.terminate();
      reject(new Error("解析に時間がかかりすぎました。ファイルサイズを確認してください。"));
    }, 180_000);
    worker.addEventListener("message", (event) => {
      if (event.data?.id !== id) return;
      clearTimeout(timeout);
      worker.terminate();
      state.activeWorker = null;
      if (event.data.ok) resolve(event.data.points);
      else reject(new Error(event.data.error || "Timeline JSONを解析できませんでした"));
    });
    worker.addEventListener("error", (event) => {
      clearTimeout(timeout);
      worker.terminate();
      state.activeWorker = null;
      reject(new Error(event.message || "解析ワーカーでエラーが発生しました"));
    });
    worker.postMessage({ id, file });
  });
}

function configurePeriodInputs() {
  const first = state.months[0];
  const last = state.months[state.months.length - 1];
  elements.startMonth.min = first;
  elements.startMonth.max = last;
  elements.endMonth.min = first;
  elements.endMonth.max = last;

  const latestYear = Number(last.slice(0, 4));
  const currentYear = new Date().getFullYear();
  const years = [...new Set(state.months.map((value) => Number(value.slice(0, 4))))];
  const defaultYear =
    latestYear === currentYear && years.some((year) => year === latestYear - 1)
      ? latestYear - 1
      : latestYear;
  const inDefaultYear = state.months.filter((value) => value.startsWith(`${defaultYear}-`));
  elements.startMonth.value = inDefaultYear[0] ?? first;
  elements.endMonth.value = inDefaultYear[inDefaultYear.length - 1] ?? last;
}

function refreshJourney() {
  if (state.points.length === 0) return;
  try {
    state.journey = createJourney(
      state.points,
      elements.startMonth.value,
      elements.endMonth.value,
    );
    const journey = state.journey;
    elements.journeySummary.textContent =
      `${journey.points.length.toLocaleString()}地点 · ` +
      `${Math.round(journey.totalDistanceKm).toLocaleString()} km · ` +
      formatPeriod(journey.startMonth, journey.endMonth);
    renderer.resetCamera();
    state.lastDraw = { progress: 0.18, outro: 0, overview: false };
    drawCurrentFrame();
    updateActionButtons();
  } catch (error) {
    state.journey = null;
    elements.journeySummary.textContent = error instanceof Error ? error.message : String(error);
    updateActionButtons();
  }
}

async function handleMapToggle() {
  if (elements.withMap.checked && localStorage.getItem("timeline-map-consent") !== "yes") {
    const accepted = window.confirm(
      "背景地図を有効にすると、表示する地域の地図タイルをCARTOから取得します。Timeline JSONや経路一覧は送信しません。続けますか？",
    );
    if (!accepted) {
      elements.withMap.checked = false;
      return;
    }
    localStorage.setItem("timeline-map-consent", "yes");
  }
  savePreferences();
  tileCache.clear();
  if (state.journey && !state.busy) {
    await prepareMap(state.journey, new AbortController().signal, 10).catch(() => {});
    drawCurrentFrame();
  }
}

async function previewJourney() {
  if (!state.journey) return;
  await runTask("プレビューを準備しています…", async (signal) => {
    await prepareMap(state.journey, signal, 24);
    renderer.resetCamera();
    const durationMs = Number(elements.duration.value) * 1000;
    const outroMs = 1500;
    const startedAt = performance.now();
    await new Promise((resolve, reject) => {
      const frame = (now) => {
        if (signal.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        const elapsed = now - startedAt;
        const progress = Math.min(1, elapsed / durationMs);
        const outro = Math.min(1, Math.max(0, (elapsed - durationMs) / outroMs));
        state.lastDraw = { progress, outro, overview: false };
        drawCurrentFrame();
        setProgress(Math.min(1, elapsed / (durationMs + outroMs)), "プレビュー中");
        if (elapsed >= durationMs + outroMs) {
          resolve();
          return;
        }
        state.animationFrame = requestAnimationFrame(frame);
      };
      state.animationFrame = requestAnimationFrame(frame);
    });
    state.lastDraw = { progress: 1, outro: 1, overview: true };
    drawCurrentFrame();
    setStatus("プレビューが完了しました。もう一度押すと先頭から再生します。", "success");
  });
}

async function createOverviewImage() {
  if (!state.journey) return;
  await runTask("全経路画像を準備しています…", async (signal) => {
    await prepareMap(state.journey, signal, 1);
    setProgress(0.8, "1080 × 1080の画像を描画中");
    const canvas = renderer.createOverviewCanvas(
      state.journey,
      resolvedTitle(),
      elements.withMap.checked,
      1080,
    );
    const blob = await canvasToPngBlob(canvas);
    const filename = `${baseFilename()}-overview.png`;
    presentResult(blob, filename, "1080 × 1080 全経路画像", "image");
    setProgress(1, "画像を作成しました");
    setStatus("全経路画像を作成しました。「保存・共有」を押してください。", "success");
  });
}

async function createVideo() {
  if (!state.journey) return;
  const mimeType = pickVideoMimeType();
  if (mimeType === null) {
    setStatus("このブラウザでは動画を作成できません。全経路画像をご利用ください。", "error");
    return;
  }
  await runTask("動画用の地図を準備しています…", async (signal) => {
    await prepareMap(state.journey, signal, 36);
    const wakeLock = await requestWakeLock();
    const previousWidth = elements.canvas.width;
    const previousHeight = elements.canvas.height;
    elements.canvas.width = 480;
    elements.canvas.height = 480;
    try {
      const result = await recordTimelineVideo({
        canvas: elements.canvas,
        renderer,
        journey: state.journey,
        title: resolvedTitle(),
        durationSeconds: Number(elements.duration.value),
        withMap: elements.withMap.checked,
        signal,
        onProgress: (fraction) => setProgress(fraction, "動画を作成中（画面を開いたままにしてください）"),
      });
      const filename = `${baseFilename()}.${result.extension}`;
      presentResult(blobWithType(result.blob, result.mimeType), filename, `${result.extension.toUpperCase()}動画`, "video");
      setStatus("動画を作成しました。「保存・共有」を押してください。", "success");
    } finally {
      await wakeLock?.release?.().catch(() => {});
      elements.canvas.width = previousWidth;
      elements.canvas.height = previousHeight;
      state.lastDraw = { progress: 1, outro: 1, overview: true };
      drawCurrentFrame();
    }
  });
}

async function prepareMap(journey, signal, samples) {
  if (!elements.withMap.checked) return;
  setProgress(0.02, "背景地図を端末へ一時保存しています");
  await renderer.prefetch(journey, {
    samples,
    includeOverview: true,
    width: 480,
    height: 480,
    signal,
    onProgress: (completed, total) => {
      const fraction = total === 0 ? 1 : completed / total;
      setProgress(fraction * 0.72, `地図 ${completed.toLocaleString()} / ${total.toLocaleString()}`);
    },
  });
}

async function runTask(initialMessage, task) {
  cancelActiveTask();
  clearResult();
  const controller = new AbortController();
  state.controller = controller;
  setBusy(true, initialMessage, true);
  try {
    await task(controller.signal);
  } catch (error) {
    if (error?.name === "AbortError") setStatus("処理をキャンセルしました。", "neutral");
    else setStatus(error instanceof Error ? error.message : String(error), "error");
  } finally {
    state.controller = null;
    setBusy(false);
  }
}

function cancelActiveTask() {
  cancelAnimationFrame(state.animationFrame);
  state.animationFrame = 0;
  state.controller?.abort();
  state.activeWorker?.terminate();
  state.activeWorker = null;
}

function drawCurrentFrame() {
  if (!state.journey) return;
  renderer.draw(elements.canvas, state.journey, {
    ...state.lastDraw,
    title: resolvedTitle(),
    withMap: elements.withMap.checked,
    smooth: !state.lastDraw.overview,
  });
}

function drawPlaceholder() {
  const context = elements.canvas.getContext("2d");
  const gradient = context.createLinearGradient(0, 0, elements.canvas.width, elements.canvas.height);
  gradient.addColorStop(0, "#fff9fb");
  gradient.addColorStop(1, "#eeeaf5");
  context.fillStyle = gradient;
  context.fillRect(0, 0, elements.canvas.width, elements.canvas.height);
  context.fillStyle = "#24191d";
  context.textAlign = "center";
  context.font = "700 34px system-ui, -apple-system, sans-serif";
  context.fillText("Timeline Visualizer", elements.canvas.width / 2, elements.canvas.height / 2 - 12);
  context.fillStyle = "#67555d";
  context.font = "500 20px system-ui, -apple-system, sans-serif";
  context.fillText("Timeline JSONを選んでください", elements.canvas.width / 2, elements.canvas.height / 2 + 32);
}

function resolvedTitle() {
  const name = elements.travelerName.value.trim() || "My";
  const template = elements.titleTemplate.value.trim() || "{name} Journey · {year}";
  const year =
    state.journey?.startMonth.slice(0, 4) === state.journey?.endMonth.slice(0, 4)
      ? state.journey.startMonth.slice(0, 4)
      : `${state.journey?.startMonth.slice(0, 4)}–${state.journey?.endMonth.slice(0, 4)}`;
  return template.replaceAll("{name}", name).replaceAll("{year}", year);
}

function baseFilename() {
  const period = `${elements.startMonth.value}_${elements.endMonth.value}`;
  const title = resolvedTitle()
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60);
  return `${title || "timeline"}-${period}`;
}

function presentResult(blob, filename, label, kind) {
  clearResult();
  state.result = { blob, filename, label };
  state.resultUrl = URL.createObjectURL(blob);
  elements.resultPanel.hidden = false;
  elements.resultSummary.textContent = `${label} · ${formatBytes(blob.size)} · ${filename}`;
  elements.resultMedia.replaceChildren();
  const media = document.createElement(kind === "video" ? "video" : "img");
  media.src = state.resultUrl;
  media.className = "result-preview";
  if (kind === "video") {
    media.controls = true;
    media.playsInline = true;
  } else {
    media.alt = label;
  }
  elements.resultMedia.append(media);
}

async function saveResult() {
  if (!state.result) return;
  try {
    const outcome = await deliverFile(state.result.blob, state.result.filename, state.result.label);
    if (outcome === "shared") setStatus("共有シートを開きました。", "success");
    else if (outcome === "downloaded") setStatus("ファイルを保存しました。", "success");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), "error");
  }
}

function clearResult() {
  if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
  state.resultUrl = null;
  state.result = null;
  elements.resultPanel.hidden = true;
  elements.resultMedia.replaceChildren();
}

function setBusy(busy, message, cancellable = false) {
  state.busy = busy;
  elements.cancelButton.hidden = !(busy && cancellable);
  if (message) {
    setStatus(message, "neutral");
    setProgress(0, message);
  }
  if (!busy) {
    elements.progress.hidden = true;
    elements.progressLabel.hidden = true;
  }
  updateActionButtons();
}

function updateActionButtons() {
  const disabled = state.busy || !state.journey;
  elements.previewButton.disabled = disabled;
  elements.imageButton.disabled = disabled;
  elements.videoButton.disabled = disabled || pickVideoMimeType() === null;
  elements.startMonth.disabled = state.busy;
  elements.endMonth.disabled = state.busy;
  elements.duration.disabled = state.busy;
  elements.withMap.disabled = state.busy;
}

function setProgress(fraction, label) {
  elements.progress.hidden = false;
  elements.progressLabel.hidden = false;
  elements.progress.value = Math.min(1, Math.max(0, fraction));
  elements.progressLabel.textContent = label;
}

function setStatus(message, type = "neutral") {
  elements.status.textContent = message;
  elements.status.dataset.type = type;
}

function updateVideoSupport() {
  const mimeType = pickVideoMimeType();
  elements.videoSupport.textContent =
    mimeType === null
      ? "このブラウザは動画生成に未対応です（PNGは利用できます）"
      : mimeType.includes("mp4")
        ? "この端末ではMP4で作成予定です"
        : "この端末ではWebMで作成予定です";
}

function savePreferences() {
  localStorage.setItem("timeline-name", elements.travelerName.value);
  localStorage.setItem("timeline-title-template", elements.titleTemplate.value);
  localStorage.setItem("timeline-duration", elements.duration.value);
}

function restorePreferences() {
  elements.travelerName.value = localStorage.getItem("timeline-name") || "My";
  elements.titleTemplate.value =
    localStorage.getItem("timeline-title-template") || "{name} Journey · {year}";
  elements.duration.value = localStorage.getItem("timeline-duration") || "15";
  elements.withMap.checked = false;
}

async function requestWakeLock() {
  try {
    return await navigator.wakeLock?.request("screen");
  } catch {
    return null;
  }
}

function blobWithType(blob, type) {
  return blob.type === type ? blob : new Blob([blob], { type });
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}

window.addEventListener("beforeunload", () => {
  cancelActiveTask();
  clearResult();
  tileCache.clear();
});

window.timelineVisualizerDebug = {
  monthKey,
  get state() {
    return state;
  },
};
