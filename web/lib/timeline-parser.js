const MAX_MERCATOR_LATITUDE = 85.05112878;

export class TimelineParseError extends Error {
  constructor(message) {
    super(message);
    this.name = "TimelineParseError";
  }
}

export function parseTimelineJson(input) {
  let root;
  try {
    root = typeof input === "string" ? JSON.parse(input) : input;
  } catch (error) {
    throw new TimelineParseError(`JSONを読み取れませんでした: ${error.message}`);
  }

  const points = [];
  if (Array.isArray(root)) {
    readSegments(root, points);
  } else if (root && typeof root === "object") {
    if (Array.isArray(root.semanticSegments)) {
      readSegments(root.semanticSegments, points);
    }
    if (Array.isArray(root.timelineObjects)) {
      readTimelineObjects(root.timelineObjects, points);
    }
    if (Array.isArray(root.locations)) {
      readLegacyLocations(root.locations, points);
    }
    if (points.length === 0 && looksLikeSegment(root)) {
      readSegments([root], points);
    }
  }

  const normalized = normalizePoints(points);
  if (normalized.length === 0) {
    throw new TimelineParseError(
      "対応する位置情報が見つかりませんでした。Google マップのタイムラインから書き出したJSONを選んでください。",
    );
  }
  return normalized;
}

function looksLikeSegment(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value.timelinePath || value.visit || value.activity || value.startTime || value.endTime),
  );
}

function readSegments(segments, output) {
  for (const segment of segments) {
    if (!segment || typeof segment !== "object") continue;
    const startTime =
      segment.startTime ?? segment.startTimestamp ?? segment.startTimestampMs ?? segment.duration?.startTimestamp;
    const endTime =
      segment.endTime ?? segment.endTimestamp ?? segment.endTimestampMs ?? segment.duration?.endTimestamp;

    const path = segment.timelinePath ?? segment.timelinePaths ?? segment.path ?? [];
    if (Array.isArray(path)) {
      for (const item of path) {
        if (!item || typeof item !== "object") continue;
        const time =
          item.time ??
          item.timestamp ??
          item.timestampMs ??
          offsetTime(startTime, item.durationMinutesOffsetFromStartTime);
        const coordinate =
          item.point ?? item.latLng ?? item.placeLocation ?? item.location ?? item.coordinate ?? item;
        pushPoint(output, time, coordinate);
      }
    }

    const visit = segment.visit;
    if (visit && typeof visit === "object") {
      const candidate = visit.topCandidate ?? visit.location ?? visit;
      pushPoint(
        output,
        startTime ?? visit.startTime ?? visit.duration?.startTimestamp,
        candidate.placeLocation ?? candidate.location ?? candidate,
      );
    }

    const activity = segment.activity;
    if (activity && typeof activity === "object") {
      pushPoint(output, startTime ?? activity.startTime, activity.start ?? activity.startLocation);
      pushPoint(output, endTime ?? activity.endTime, activity.end ?? activity.endLocation);
      const activityPath = activity.timelinePath ?? activity.simplifiedRawPath?.points;
      if (Array.isArray(activityPath)) {
        for (const item of activityPath) {
          pushPoint(
            output,
            item.time ?? item.timestamp ?? item.timestampMs ?? startTime,
            item.point ?? item.location ?? item,
          );
        }
      }
    }
  }
}

function readTimelineObjects(objects, output) {
  for (const object of objects) {
    if (!object || typeof object !== "object") continue;
    const placeVisit = object.placeVisit;
    if (placeVisit) {
      const duration = placeVisit.duration ?? {};
      pushPoint(
        output,
        duration.startTimestamp ?? duration.startTimestampMs,
        placeVisit.location,
      );
    }

    const activity = object.activitySegment;
    if (activity) {
      const duration = activity.duration ?? {};
      const start = duration.startTimestamp ?? duration.startTimestampMs;
      const end = duration.endTimestamp ?? duration.endTimestampMs;
      pushPoint(output, start, activity.startLocation);
      const rawPath = activity.simplifiedRawPath?.points ?? activity.waypointPath?.waypoints;
      if (Array.isArray(rawPath)) {
        for (const item of rawPath) {
          pushPoint(output, item.timestamp ?? item.timestampMs ?? start, item);
        }
      }
      pushPoint(output, end, activity.endLocation);
    }
  }
}

function readLegacyLocations(locations, output) {
  for (const location of locations) {
    if (!location || typeof location !== "object") continue;
    pushPoint(
      output,
      location.timestamp ?? location.timestampMs ?? location.time,
      location,
    );
  }
}

function offsetTime(startRaw, minutesRaw) {
  const start = parseInstant(startRaw);
  const minutes = Number(minutesRaw);
  if (start === null || !Number.isFinite(minutes)) return null;
  return start + Math.round(minutes * 60_000);
}

function pushPoint(output, timeRaw, coordinateRaw) {
  const timestamp = parseInstant(timeRaw);
  const coordinate = parseCoordinate(coordinateRaw);
  if (timestamp === null || coordinate === null) return;
  output.push({ timestamp, latitude: coordinate.latitude, longitude: coordinate.longitude });
}

export function parseInstant(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "object") {
    return parseInstant(
      raw.timestamp ?? raw.timestampMs ?? raw.startTimestamp ?? raw.startTimestampMs ?? raw.time,
    );
  }
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return null;
    return Math.abs(raw) < 100_000_000_000 ? Math.round(raw * 1000) : Math.round(raw);
  }
  const value = String(raw).trim();
  if (!value) return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    return parseInstant(Number(value));
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function parseCoordinate(raw) {
  if (raw === null || raw === undefined) return null;

  if (Array.isArray(raw) && raw.length >= 2) {
    return validateCoordinate(Number(raw[0]), Number(raw[1]));
  }

  if (typeof raw === "object") {
    const nested =
      raw.latLng ?? raw.point ?? raw.placeLocation ?? raw.location ?? raw.coordinate ?? raw.center;
    if (nested !== undefined && nested !== raw) {
      const parsed = parseCoordinate(nested);
      if (parsed) return parsed;
    }

    const latitudeRaw =
      raw.latitude ?? raw.lat ?? raw.latitudeE7 ?? raw.latE7 ?? raw.latitude_e7;
    const longitudeRaw =
      raw.longitude ?? raw.lng ?? raw.lon ?? raw.longitudeE7 ?? raw.lngE7 ?? raw.longitude_e7;
    if (latitudeRaw !== undefined && longitudeRaw !== undefined) {
      let latitude = Number(latitudeRaw);
      let longitude = Number(longitudeRaw);
      if (Math.abs(latitude) > 1_000_000 || Math.abs(longitude) > 1_000_000) {
        latitude /= 10_000_000;
        longitude /= 10_000_000;
      }
      return validateCoordinate(latitude, longitude);
    }
    return null;
  }

  const cleaned = String(raw)
    .trim()
    .replace(/^geo:/i, "")
    .split("?")[0]
    .replace(/°/g, "")
    .replace(/[()]/g, " ");
  const numbers = cleaned.match(/[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g);
  if (!numbers || numbers.length < 2) return null;
  let latitude = Number(numbers[0]);
  let longitude = Number(numbers[1]);
  if (Math.abs(latitude) > 1_000_000 || Math.abs(longitude) > 1_000_000) {
    latitude /= 10_000_000;
    longitude /= 10_000_000;
  }
  return validateCoordinate(latitude, longitude);
}

function validateCoordinate(latitude, longitude) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -MAX_MERCATOR_LATITUDE || latitude > MAX_MERCATOR_LATITUDE) return null;
  if (longitude < -180 || longitude > 180) return null;
  return { latitude, longitude };
}

export function normalizePoints(points) {
  const seen = new Set();
  const normalized = [];
  for (const point of points) {
    const timestamp = parseInstant(point.timestamp ?? point.time);
    const coordinate = parseCoordinate(point);
    if (timestamp === null || coordinate === null) continue;
    const key = `${timestamp}:${coordinate.latitude.toFixed(7)}:${coordinate.longitude.toFixed(7)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ timestamp, ...coordinate });
  }
  normalized.sort((left, right) => left.timestamp - right.timestamp);
  return normalized;
}
