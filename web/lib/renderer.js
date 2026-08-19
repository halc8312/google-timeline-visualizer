import {
  formatPeriod,
  positionAt,
  projectWebMercator,
  unwrapProjectedPath,
  unwrapXNear,
} from "./journey.js";
import { cartoTileUrl } from "./tile-cache.js";

const PREPARED = new WeakMap();
const MIN_SPAN = 0.00045;
const MAX_SPAN = 0.92;
const MIN_ZOOM = 2;
const MAX_ZOOM = 15;

export class TimelineRenderer {
  constructor(tileCache) {
    this.tileCache = tileCache;
    this.smoothedViewport = null;
    this.onInvalidate = null;
    this.pendingInvalidation = false;
  }

  resetCamera() {
    this.smoothedViewport = null;
  }

  draw(canvas, journey, options = {}) {
    const {
      progress = 0,
      outro = 0,
      title = "My Journey",
      withMap = false,
      overview = false,
      smooth = !overview,
    } = options;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Canvas 2D context is unavailable");
    const width = canvas.width;
    const height = canvas.height;
    const prepared = prepareJourney(journey);
    const viewport = this.viewportFor(journey, prepared, {
      progress,
      outro: overview ? 1 : outro,
      width,
      height,
      overview,
      smooth,
    });

    this.#drawBackground(context, width, height);
    if (withMap) this.#drawMap(context, viewport, width, height);
    else this.#drawGrid(context, width, height);

    const current = positionAt(journey, overview ? 1 : progress);
    this.#drawRoute(context, prepared, journey, viewport, width, height, current.distanceKm, overview);
    this.#drawMarker(context, prepared, current, viewport, width, height, overview);
    this.#drawOverlay(context, journey, current, title, width, height, withMap, overview);
    return { viewport, current };
  }

  viewportFor(journey, prepared, options) {
    const { progress, outro, width, height, overview, smooth } = options;
    const global = overviewViewport(prepared, width, height);
    if (overview) return global;
    const local = cameraViewport(journey, prepared, progress, width, height);
    const mixed = outro > 0 ? blendViewport(local, global, easeOutCubic(outro)) : local;
    if (!smooth) return mixed;
    if (!this.smoothedViewport) {
      this.smoothedViewport = mixed;
      return mixed;
    }
    const zoomingOut = mixed.spanY > this.smoothedViewport.spanY;
    const alpha = zoomingOut ? 0.16 : 0.09;
    this.smoothedViewport = interpolateViewport(this.smoothedViewport, mixed, alpha);
    return this.smoothedViewport;
  }

  tileUrlsFor(journey, { samples = 28, includeOverview = true, width = 480, height = 480 } = {}) {
    const prepared = prepareJourney(journey);
    const urls = new Set();
    for (let index = 0; index <= samples; index += 1) {
      const viewport = cameraViewport(journey, prepared, index / samples, width, height);
      for (const url of tileUrlsForViewport(viewport)) urls.add(url);
    }
    if (includeOverview) {
      for (const url of tileUrlsForViewport(overviewViewport(prepared, width, height))) urls.add(url);
    }
    return [...urls].slice(0, 1400);
  }

  async prefetch(journey, options = {}) {
    const { onProgress, signal } = options;
    const urls = this.tileUrlsFor(journey, options);
    await this.tileCache.loadMany(urls, { onProgress, signal });
    return urls.length;
  }

  createOverviewCanvas(journey, title, withMap, size = 1080) {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    this.draw(canvas, journey, {
      progress: 1,
      outro: 1,
      title,
      withMap,
      overview: true,
      smooth: false,
    });
    return canvas;
  }

  #drawBackground(context, width, height) {
    const gradient = context.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, "#fff9fb");
    gradient.addColorStop(1, "#f0eef7");
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
  }

  #drawGrid(context, width, height) {
    const step = Math.max(32, Math.round(width / 12));
    context.save();
    context.strokeStyle = "rgba(88, 69, 83, 0.08)";
    context.lineWidth = Math.max(1, width / 720);
    for (let x = 0; x <= width; x += step) {
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, height);
      context.stroke();
    }
    for (let y = 0; y <= height; y += step) {
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(width, y);
      context.stroke();
    }
    context.restore();
  }

  #drawMap(context, viewport, width, height) {
    const tiles = visibleTiles(viewport);
    for (const tile of tiles) {
      const url = cartoTileUrl(viewport.zoom, tile.wrappedX, tile.y);
      if (!url) continue;
      const destination = worldRectToCanvas(
        tile.x / 2 ** viewport.zoom,
        tile.y / 2 ** viewport.zoom,
        (tile.x + 1) / 2 ** viewport.zoom,
        (tile.y + 1) / 2 ** viewport.zoom,
        viewport,
        width,
        height,
      );
      const image = this.tileCache.get(url);
      if (image) {
        context.drawImage(image, destination.x, destination.y, destination.width, destination.height);
      } else {
        this.tileCache.load(url).then((loaded) => {
          if (loaded && this.onInvalidate && !this.pendingInvalidation) {
            this.pendingInvalidation = true;
            requestAnimationFrame(() => {
              this.pendingInvalidation = false;
              this.onInvalidate?.();
            });
          }
        });
      }
    }
  }

  #drawRoute(context, prepared, journey, viewport, width, height, currentDistance, overview) {
    const scale = width / 480;
    drawDistanceRange(context, prepared, 0, journey.totalDistanceKm, viewport, width, height, {
      color: overview ? "rgba(123, 104, 116, 0.20)" : "rgba(123, 104, 116, 0.13)",
      width: (overview ? 3.2 : 2.3) * scale,
      dash: overview ? [] : [4 * scale, 7 * scale],
    });

    if (overview) {
      drawDistanceRange(context, prepared, 0, journey.totalDistanceKm, viewport, width, height, {
        color: "rgba(233, 0, 100, 0.96)",
        width: 4.4 * scale,
      });
      return;
    }

    const oldEnd = currentDistance * 0.66;
    const middleEnd = currentDistance * 0.9;
    drawDistanceRange(context, prepared, 0, oldEnd, viewport, width, height, {
      color: "rgba(233, 0, 100, 0.22)",
      width: 3.2 * scale,
    });
    drawDistanceRange(context, prepared, oldEnd, middleEnd, viewport, width, height, {
      color: "rgba(233, 0, 100, 0.56)",
      width: 5 * scale,
    });
    drawDistanceRange(context, prepared, middleEnd, currentDistance, viewport, width, height, {
      color: "rgba(233, 0, 100, 0.98)",
      width: 7 * scale,
    });
  }

  #drawMarker(context, prepared, current, viewport, width, height, overview) {
    const projected = projectWebMercator(current.point);
    const reference = xAtDistance(prepared, current.distanceKm);
    const point = worldToCanvas(
      unwrapXNear(projected.x, reference),
      projected.y,
      viewport,
      width,
      height,
    );
    const scale = width / 480;
    const radius = (overview ? 7 : 9) * scale;
    context.save();
    context.shadowColor = "rgba(36, 25, 29, 0.28)";
    context.shadowBlur = 9 * scale;
    context.shadowOffsetY = 2 * scale;
    context.fillStyle = "#24191d";
    context.beginPath();
    context.arc(point.x, point.y, radius, 0, Math.PI * 2);
    context.fill();
    context.shadowColor = "transparent";
    context.strokeStyle = "#e90064";
    context.lineWidth = 4 * scale;
    context.stroke();
    context.restore();
  }

  #drawOverlay(context, journey, current, title, width, height, withMap, overview) {
    const scale = width / 480;
    const horizontal = 18 * scale;
    const top = 16 * scale;
    const cardHeight = (overview ? 94 : 84) * scale;
    context.save();
    context.fillStyle = "rgba(255, 248, 250, 0.92)";
    roundedRect(context, horizontal, top, width - horizontal * 2, cardHeight, 18 * scale);
    context.fill();

    context.fillStyle = "#24191d";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.font = `700 ${Math.round((overview ? 24 : 22) * scale)}px system-ui, -apple-system, sans-serif`;
    context.fillText(clipText(context, title, width - 70 * scale), width / 2, top + 31 * scale);

    context.fillStyle = "#67555d";
    context.font = `500 ${Math.round(13 * scale)}px system-ui, -apple-system, sans-serif`;
    const period = formatPeriod(journey.startMonth, journey.endMonth);
    const distance = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(
      overview ? journey.totalDistanceKm : current.distanceKm,
    );
    const date = new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(new Date(current.point.timestamp));
    const subtitle = overview ? `${period} · ${distance} km` : `${date} · ${distance} km`;
    context.fillText(subtitle, width / 2, top + 62 * scale);

    if (withMap) {
      context.fillStyle = "rgba(36, 25, 29, 0.74)";
      context.textAlign = "right";
      context.textBaseline = "bottom";
      context.font = `${Math.max(9, Math.round(9 * scale))}px system-ui, -apple-system, sans-serif`;
      context.fillText("© OpenStreetMap contributors · © CARTO", width - 8 * scale, height - 7 * scale);
    }
    context.restore();
  }
}

function prepareJourney(journey) {
  const cached = PREPARED.get(journey);
  if (cached) return cached;
  const projected = unwrapProjectedPath(journey.renderPath).map((point, index) => ({
    ...point,
    distanceKm: journey.renderPath[index].distanceKm,
  }));
  const prepared = { projected };
  PREPARED.set(journey, prepared);
  return prepared;
}

function cameraViewport(journey, prepared, progress, width, height) {
  const current = positionAt(journey, progress);
  const contextKm = Math.min(650, Math.max(8, journey.totalDistanceKm * 0.065));
  const start = Math.max(0, current.distanceKm - contextKm);
  const end = Math.min(journey.totalDistanceKm, current.distanceKm + contextKm);
  const points = sliceDistance(prepared.projected, start, end);
  const markerProjected = projectWebMercator(current.point);
  const markerX = unwrapXNear(markerProjected.x, xAtDistance(prepared, current.distanceKm));
  points.push({ x: markerX, y: markerProjected.y });
  return fitPoints(points, width / height, 2.55);
}

function overviewViewport(prepared, width, height) {
  return fitPoints(prepared.projected, width / height, 1.24);
}

function fitPoints(points, aspect, paddingMultiplier) {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  let spanX = Math.max(MIN_SPAN, (maxX - minX) * paddingMultiplier);
  let spanY = Math.max(MIN_SPAN, (maxY - minY) * paddingMultiplier);
  if (spanX / spanY < aspect) spanX = spanY * aspect;
  else spanY = spanX / aspect;
  spanY = Math.min(MAX_SPAN, spanY);
  spanX = spanY * aspect;
  const halfY = spanY / 2;
  const boundedCenterY = halfY >= 0.5 ? 0.5 : Math.min(1 - halfY, Math.max(halfY, centerY));
  const viewport = {
    centerX,
    centerY: boundedCenterY,
    spanX,
    spanY,
    zoom: zoomForSpan(spanX),
  };
  return withBounds(viewport);
}

function withBounds(viewport) {
  return {
    ...viewport,
    minX: viewport.centerX - viewport.spanX / 2,
    maxX: viewport.centerX + viewport.spanX / 2,
    minY: viewport.centerY - viewport.spanY / 2,
    maxY: viewport.centerY + viewport.spanY / 2,
  };
}

function interpolateViewport(from, to, alpha) {
  const centerX = from.centerX + (to.centerX - from.centerX) * alpha;
  const centerY = from.centerY + (to.centerY - from.centerY) * alpha;
  const spanY = Math.exp(Math.log(from.spanY) + (Math.log(to.spanY) - Math.log(from.spanY)) * alpha);
  const spanX = Math.exp(Math.log(from.spanX) + (Math.log(to.spanX) - Math.log(from.spanX)) * alpha);
  return withBounds({ centerX, centerY, spanX, spanY, zoom: zoomForSpan(spanX) });
}

function blendViewport(from, to, alpha) {
  return interpolateViewport(from, to, alpha);
}

function zoomForSpan(spanX) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.floor(Math.log2(1 / spanX)) + 1));
}

function visibleTiles(viewport) {
  const dimension = 2 ** viewport.zoom;
  const startX = Math.floor(viewport.minX * dimension);
  const endX = Math.floor(viewport.maxX * dimension);
  const startY = Math.max(0, Math.floor(viewport.minY * dimension));
  const endY = Math.min(dimension - 1, Math.floor(viewport.maxY * dimension));
  const tiles = [];
  for (let y = startY; y <= endY; y += 1) {
    for (let x = startX; x <= endX; x += 1) {
      tiles.push({ x, y, wrappedX: ((x % dimension) + dimension) % dimension });
    }
  }
  return tiles;
}

function tileUrlsForViewport(viewport) {
  return visibleTiles(viewport)
    .map((tile) => cartoTileUrl(viewport.zoom, tile.wrappedX, tile.y))
    .filter(Boolean);
}

function drawDistanceRange(context, prepared, startDistance, endDistance, viewport, width, height, style) {
  if (endDistance <= startDistance) return;
  const points = sliceDistance(prepared.projected, startDistance, endDistance);
  if (points.length < 2) return;
  context.save();
  context.beginPath();
  points.forEach((point, index) => {
    const canvasPoint = worldToCanvas(point.x, point.y, viewport, width, height);
    if (index === 0) context.moveTo(canvasPoint.x, canvasPoint.y);
    else context.lineTo(canvasPoint.x, canvasPoint.y);
  });
  context.strokeStyle = style.color;
  context.lineWidth = style.width;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.setLineDash(style.dash ?? []);
  context.stroke();
  context.restore();
}

function sliceDistance(points, startDistance, endDistance) {
  const output = [];
  const startIndex = lowerBound(points, startDistance);
  const from = Math.max(0, startIndex - 1);
  for (let index = from; index < points.length; index += 1) {
    const point = points[index];
    if (point.distanceKm < startDistance) continue;
    if (point.distanceKm > endDistance) break;
    output.push(point);
  }
  const startPoint = interpolatePrepared(points, startDistance);
  const endPoint = interpolatePrepared(points, endDistance);
  if (startPoint) output.unshift(startPoint);
  if (endPoint) output.push(endPoint);
  return dedupeCanvasPoints(output);
}

function interpolatePrepared(points, distance) {
  if (points.length === 0) return null;
  const index = lowerBound(points, distance);
  if (index <= 0) return points[0];
  if (index >= points.length) return points[points.length - 1];
  const left = points[index - 1];
  const right = points[index];
  const span = right.distanceKm - left.distanceKm;
  const fraction = span <= 0 ? 0 : (distance - left.distanceKm) / span;
  return {
    x: left.x + (right.x - left.x) * fraction,
    y: left.y + (right.y - left.y) * fraction,
    distanceKm: distance,
  };
}

function xAtDistance(prepared, distance) {
  return interpolatePrepared(prepared.projected, distance)?.x ?? 0.5;
}

function lowerBound(points, distance) {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (points[middle].distanceKm < distance) low = middle + 1;
    else high = middle;
  }
  return low;
}

function dedupeCanvasPoints(points) {
  return points.filter((point, index) => {
    if (index === 0) return true;
    const previous = points[index - 1];
    return Math.abs(point.x - previous.x) > 1e-12 || Math.abs(point.y - previous.y) > 1e-12;
  });
}

function worldToCanvas(x, y, viewport, width, height) {
  return {
    x: ((x - viewport.minX) / (viewport.maxX - viewport.minX)) * width,
    y: ((y - viewport.minY) / (viewport.maxY - viewport.minY)) * height,
  };
}

function worldRectToCanvas(minX, minY, maxX, maxY, viewport, width, height) {
  const start = worldToCanvas(minX, minY, viewport, width, height);
  const end = worldToCanvas(maxX, maxY, viewport, width, height);
  return { x: start.x, y: start.y, width: end.x - start.x, height: end.y - start.y };
}

function roundedRect(context, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

function clipText(context, text, maxWidth) {
  if (context.measureText(text).width <= maxWidth) return text;
  let value = text;
  while (value.length > 1 && context.measureText(`${value}…`).width > maxWidth) {
    value = value.slice(0, -1);
  }
  return `${value}…`;
}

function easeOutCubic(value) {
  return 1 - (1 - Math.min(1, Math.max(0, value))) ** 3;
}
