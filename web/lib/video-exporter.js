const VIDEO_MIME_CANDIDATES = [
  "video/mp4;codecs=avc1.42E01E",
  "video/mp4",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
];

export function pickVideoMimeType() {
  if (typeof MediaRecorder === "undefined") return null;
  return VIDEO_MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

export async function recordTimelineVideo({
  canvas,
  renderer,
  journey,
  title,
  durationSeconds,
  withMap,
  fps = 24,
  signal,
  onProgress = () => {},
}) {
  if (typeof MediaRecorder === "undefined" || typeof canvas.captureStream !== "function") {
    throw new Error("このブラウザはCanvas動画の作成に対応していません。全経路画像は保存できます。");
  }
  const mimeType = pickVideoMimeType();
  if (mimeType === null) throw new Error("MediaRecorderを利用できません");

  renderer.resetCamera();
  renderer.draw(canvas, journey, { progress: 0, title, withMap });
  const stream = canvas.captureStream(fps);
  const chunks = [];
  const options = mimeType ? { mimeType, videoBitsPerSecond: 2_500_000 } : { videoBitsPerSecond: 2_500_000 };
  let recorder;
  try {
    recorder = new MediaRecorder(stream, options);
  } catch {
    recorder = new MediaRecorder(stream);
  }

  const stopped = new Promise((resolve, reject) => {
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data?.size) chunks.push(event.data);
    });
    recorder.addEventListener("stop", resolve, { once: true });
    recorder.addEventListener("error", () => reject(recorder.error ?? new Error("動画作成に失敗しました")), {
      once: true,
    });
  });

  const journeyDuration = Math.max(1, Number(durationSeconds)) * 1000;
  const outroDuration = 1500;
  const totalDuration = journeyDuration + outroDuration;
  let animationFrame = 0;
  let aborted = false;
  const abort = () => {
    aborted = true;
    cancelAnimationFrame(animationFrame);
    if (recorder.state !== "inactive") recorder.stop();
  };
  signal?.addEventListener("abort", abort, { once: true });

  try {
    recorder.start(500);
    const startedAt = performance.now();
    await new Promise((resolve, reject) => {
      const frame = (now) => {
        if (aborted || signal?.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        const elapsed = now - startedAt;
        const journeyProgress = Math.min(1, elapsed / journeyDuration);
        const outroProgress = Math.min(1, Math.max(0, (elapsed - journeyDuration) / outroDuration));
        renderer.draw(canvas, journey, {
          progress: journeyProgress,
          outro: outroProgress,
          title,
          withMap,
          smooth: true,
        });
        onProgress(Math.min(1, elapsed / totalDuration));
        if (elapsed >= totalDuration) {
          resolve();
          return;
        }
        animationFrame = requestAnimationFrame(frame);
      };
      animationFrame = requestAnimationFrame(frame);
    });

    await new Promise((resolve) => setTimeout(resolve, 120));
    if (recorder.state !== "inactive") recorder.stop();
    await stopped;
    if (aborted || signal?.aborted) throw new DOMException("Aborted", "AbortError");

    const resultingType = recorder.mimeType || mimeType || chunks[0]?.type || "video/webm";
    const blob = new Blob(chunks, { type: resultingType });
    if (blob.size === 0) throw new Error("動画データが空でした");
    return {
      blob,
      mimeType: resultingType,
      extension: resultingType.includes("mp4") ? "mp4" : "webm",
    };
  } finally {
    cancelAnimationFrame(animationFrame);
    signal?.removeEventListener("abort", abort);
    for (const track of stream.getTracks()) track.stop();
  }
}

export function canvasToPngBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("PNG画像を作成できませんでした"));
    }, "image/png");
  });
}

export async function deliverFile(blob, filename, title = filename) {
  const file = new File([blob], filename, { type: blob.type, lastModified: Date.now() });
  if (navigator.share && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return "shared";
    } catch (error) {
      if (error?.name !== "AbortError") throw error;
      return "cancelled";
    }
  }

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return "downloaded";
}
