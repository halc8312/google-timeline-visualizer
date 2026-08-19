const EARTH_RADIUS_KM = 6371.0088;
const MAX_RENDER_STEP_KM = 75;
const MAX_STEPS_PER_SEGMENT = 320;
const MAX_MERCATOR_LATITUDE = 85.05112878;

export function monthKey(timestamp) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

export function listAvailableMonths(points) {
  return [...new Set(points.map((point) => monthKey(point.timestamp)))].sort();
}

export function filterByMonth(points, startMonth, endMonth) {
  if (!/^\d{4}-\d{2}$/.test(startMonth) || !/^\d{4}-\d{2}$/.test(endMonth)) {
    throw new Error("期間はYYYY-MM形式で指定してください");
  }
  if (endMonth < startMonth) {
    throw new Error("終了月は開始月以降にしてください");
  }
  return points.filter((point) => {
    const key = monthKey(point.timestamp);
    return key >= startMonth && key <= endMonth;
  });
}

export function createJourney(points, startMonth, endMonth) {
  const selected = filterByMonth(points, startMonth, endMonth).sort(
    (left, right) => left.timestamp - right.timestamp,
  );
  if (selected.length < 2) {
    throw new Error("選択期間には2地点以上の位置情報が必要です");
  }

  const cumulativeDistanceKm = new Float64Array(selected.length);
  for (let index = 1; index < selected.length; index += 1) {
    cumulativeDistanceKm[index] =
      cumulativeDistanceKm[index - 1] + haversineKm(selected[index - 1], selected[index]);
  }

  const journey = {
    points: selected,
    cumulativeDistanceKm,
    totalDistanceKm: cumulativeDistanceKm[cumulativeDistanceKm.length - 1] ?? 0,
    startMonth,
    endMonth,
  };
  journey.renderPath = buildRenderPath(journey);
  return journey;
}

function buildRenderPath(journey) {
  const output = [{ ...journey.points[0], distanceKm: 0 }];
  for (let index = 1; index < journey.points.length; index += 1) {
    const start = journey.points[index - 1];
    const end = journey.points[index];
    const startDistance = journey.cumulativeDistanceKm[index - 1];
    const segmentDistance = journey.cumulativeDistanceKm[index] - startDistance;
    const steps = Math.min(
      MAX_STEPS_PER_SEGMENT,
      Math.max(1, Math.ceil(segmentDistance / MAX_RENDER_STEP_KM)),
    );
    for (let step = 1; step <= steps; step += 1) {
      const fraction = step / steps;
      output.push({
        ...greatCircleInterpolate(start, end, fraction),
        distanceKm: startDistance + segmentDistance * fraction,
      });
    }
  }
  return output;
}

export function haversineKm(left, right) {
  const latitude1 = toRadians(left.latitude);
  const latitude2 = toRadians(right.latitude);
  const deltaLatitude = latitude2 - latitude1;
  const deltaLongitude = toRadians(right.longitude - left.longitude);
  const value =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(deltaLongitude / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.asin(Math.min(1, Math.sqrt(value)));
}

export function greatCircleInterpolate(left, right, fractionRaw) {
  const fraction = Math.min(1, Math.max(0, Number(fractionRaw)));
  if (fraction === 0) return { ...left };
  if (fraction === 1) return { ...right };

  const latitude1 = toRadians(left.latitude);
  const longitude1 = toRadians(left.longitude);
  const latitude2 = toRadians(right.latitude);
  const longitude2 = toRadians(right.longitude);

  const a = vector(latitude1, longitude1);
  const b = vector(latitude2, longitude2);
  const dot = Math.min(1, Math.max(-1, a.x * b.x + a.y * b.y + a.z * b.z));
  const omega = Math.acos(dot);
  const sine = Math.sin(omega);
  let leftWeight;
  let rightWeight;
  if (Math.abs(sine) < 1e-8) {
    leftWeight = 1 - fraction;
    rightWeight = fraction;
  } else {
    leftWeight = Math.sin((1 - fraction) * omega) / sine;
    rightWeight = Math.sin(fraction * omega) / sine;
  }

  const x = leftWeight * a.x + rightWeight * b.x;
  const y = leftWeight * a.y + rightWeight * b.y;
  const z = leftWeight * a.z + rightWeight * b.z;
  const latitude = toDegrees(Math.atan2(z, Math.sqrt(x * x + y * y)));
  const longitude = normalizeLongitude(toDegrees(Math.atan2(y, x)));
  const timestamp = Math.round(
    left.timestamp + (right.timestamp - left.timestamp) * fraction,
  );
  return { timestamp, latitude, longitude };
}

export function positionAt(journey, progress) {
  return positionAtDistance(
    journey,
    journey.totalDistanceKm * Math.min(1, Math.max(0, Number(progress))),
  );
}

export function positionAtDistance(journey, distanceRaw) {
  const target = Math.min(journey.totalDistanceKm, Math.max(0, Number(distanceRaw)));
  const distances = journey.cumulativeDistanceKm;
  let low = 0;
  let high = distances.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (distances[middle] < target) low = middle + 1;
    else high = middle - 1;
  }
  const toIndex = Math.min(distances.length - 1, Math.max(1, low));
  const fromIndex = toIndex - 1;
  const segmentDistance = distances[toIndex] - distances[fromIndex];
  const fraction =
    segmentDistance <= 0 ? 0 : (target - distances[fromIndex]) / segmentDistance;
  return {
    point: greatCircleInterpolate(
      journey.points[fromIndex],
      journey.points[toIndex],
      fraction,
    ),
    distanceKm: target,
    fromIndex,
    toIndex,
    segmentFraction: fraction,
  };
}

export function projectWebMercator(point) {
  const latitude = Math.min(MAX_MERCATOR_LATITUDE, Math.max(-MAX_MERCATOR_LATITUDE, point.latitude));
  const x = (normalizeLongitude(point.longitude) + 180) / 360;
  const sine = Math.sin(toRadians(latitude));
  const y = 0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI);
  return { x, y: Math.min(1, Math.max(0, y)) };
}

export function unwrapXNear(value, reference) {
  let result = value;
  while (result - reference > 0.5) result -= 1;
  while (result - reference < -0.5) result += 1;
  return result;
}

export function unwrapProjectedPath(points) {
  if (points.length === 0) return [];
  const projected = points.map(projectWebMercator);
  const output = [{ ...projected[0] }];
  for (let index = 1; index < projected.length; index += 1) {
    output.push({
      x: unwrapXNear(projected[index].x, output[index - 1].x),
      y: projected[index].y,
    });
  }
  return output;
}

export function formatPeriod(startMonth, endMonth) {
  if (startMonth === endMonth) return startMonth.replace("-", ".");
  return `${startMonth.replace("-", ".")} – ${endMonth.replace("-", ".")}`;
}

function vector(latitude, longitude) {
  return {
    x: Math.cos(latitude) * Math.cos(longitude),
    y: Math.cos(latitude) * Math.sin(longitude),
    z: Math.sin(latitude),
  };
}

function normalizeLongitude(longitude) {
  return ((((longitude + 180) % 360) + 360) % 360) - 180;
}

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function toDegrees(value) {
  return (value * 180) / Math.PI;
}
