import test from "node:test";
import assert from "node:assert/strict";
import {
  parseCoordinate,
  parseTimelineJson,
  normalizePoints,
} from "../lib/timeline-parser.js";
import {
  createJourney,
  filterByMonth,
  greatCircleInterpolate,
  haversineKm,
  positionAt,
  unwrapProjectedPath,
} from "../lib/journey.js";

const iso = (value) => Date.parse(value);

test("parses current direct-array Timeline export", () => {
  const points = parseTimelineJson([
    {
      startTime: "2025-01-01T00:00:00Z",
      endTime: "2025-01-01T02:00:00Z",
      timelinePath: [
        { point: "geo:35.6812,139.7671", time: "2025-01-01T00:00:00Z" },
        { point: { latLng: "35.7100,139.8100" }, time: "2025-01-01T01:00:00Z" },
      ],
      activity: { end: "35.7300°, 139.8500°" },
    },
  ]);
  assert.equal(points.length, 3);
  assert.deepEqual(points[0], {
    timestamp: iso("2025-01-01T00:00:00Z"),
    latitude: 35.6812,
    longitude: 139.7671,
  });
});

test("parses semanticSegments visits and activities", () => {
  const points = parseTimelineJson({
    semanticSegments: [
      {
        startTime: "2025-02-10T00:00:00Z",
        endTime: "2025-02-10T03:00:00Z",
        visit: { topCandidate: { placeLocation: "geo:34.6937,135.5023" } },
      },
      {
        startTime: "2025-02-10T04:00:00Z",
        endTime: "2025-02-10T05:00:00Z",
        activity: {
          start: { latLng: "34.70,135.51" },
          end: { latLng: "34.75,135.55" },
        },
      },
    ],
  });
  assert.equal(points.length, 3);
  assert.equal(points[0].longitude, 135.5023);
});

test("parses legacy locations with E7 coordinates", () => {
  const points = parseTimelineJson({
    locations: [
      {
        timestampMs: String(iso("2024-06-01T12:00:00Z")),
        latitudeE7: 356812000,
        longitudeE7: 1397671000,
      },
    ],
  });
  assert.equal(points.length, 1);
  assert.equal(points[0].latitude, 35.6812);
  assert.equal(points[0].longitude, 139.7671);
});

test("accepts common coordinate encodings and rejects invalid latitude", () => {
  assert.deepEqual(parseCoordinate("geo:35.5,139.5?z=14"), {
    latitude: 35.5,
    longitude: 139.5,
  });
  assert.deepEqual(parseCoordinate({ latE7: 355000000, lngE7: 1395000000 }), {
    latitude: 35.5,
    longitude: 139.5,
  });
  assert.equal(parseCoordinate("89,139"), null);
});

test("normalizes order and removes exact duplicates", () => {
  const points = normalizePoints([
    { timestamp: iso("2025-01-02T12:00:00Z"), latitude: 35, longitude: 139 },
    { timestamp: iso("2025-01-01T12:00:00Z"), latitude: 34, longitude: 135 },
    { timestamp: iso("2025-01-01T12:00:00Z"), latitude: 34, longitude: 135 },
    { timestamp: "not-a-date", latitude: 0, longitude: 0 },
  ]);
  assert.equal(points.length, 2);
  assert.equal(points[0].latitude, 34);
});

test("filters a range that crosses a year boundary", () => {
  const points = [
    { timestamp: iso("2024-11-15T12:00:00Z"), latitude: 35, longitude: 139 },
    { timestamp: iso("2024-12-15T12:00:00Z"), latitude: 35.1, longitude: 139.1 },
    { timestamp: iso("2025-01-15T12:00:00Z"), latitude: 35.2, longitude: 139.2 },
    { timestamp: iso("2025-02-15T12:00:00Z"), latitude: 35.3, longitude: 139.3 },
  ];
  const selected = filterByMonth(points, "2024-12", "2025-01");
  assert.equal(selected.length, 2);
  const journey = createJourney(points, "2024-12", "2025-01");
  assert.ok(journey.totalDistanceKm > 0);
});

test("calculates a plausible Tokyo to Osaka distance", () => {
  const distance = haversineKm(
    { latitude: 35.6812, longitude: 139.7671 },
    { latitude: 34.6937, longitude: 135.5023 },
  );
  assert.ok(distance > 390 && distance < 420, `distance was ${distance}`);
});

test("great-circle interpolation follows the short path across the date line", () => {
  const middle = greatCircleInterpolate(
    { timestamp: 0, latitude: 10, longitude: 179 },
    { timestamp: 1000, latitude: 10, longitude: -179 },
    0.5,
  );
  assert.ok(Math.abs(middle.longitude) > 179);
  const unwrapped = unwrapProjectedPath([
    { latitude: 10, longitude: 179 },
    { latitude: 10, longitude: -179 },
  ]);
  assert.ok(Math.abs(unwrapped[1].x - unwrapped[0].x) < 0.02);
});

test("finds a distance-based position inside a journey", () => {
  const journey = createJourney(
    [
      { timestamp: 0, latitude: 0, longitude: 0 },
      { timestamp: 1000, latitude: 0, longitude: 1 },
      { timestamp: 2000, latitude: 0, longitude: 2 },
    ],
    "1970-01",
    "1970-01",
  );
  const halfway = positionAt(journey, 0.5);
  assert.ok(Math.abs(halfway.point.longitude - 1) < 0.02);
  assert.ok(Math.abs(halfway.distanceKm - journey.totalDistanceKm / 2) < 0.01);
});
