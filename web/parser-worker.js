import { parseTimelineJson } from "./lib/timeline-parser.js";

self.addEventListener("message", async (event) => {
  const { id, file } = event.data ?? {};
  if (!id || !file) return;
  try {
    const text = await file.text();
    const points = parseTimelineJson(text);
    self.postMessage({ id, ok: true, points });
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
