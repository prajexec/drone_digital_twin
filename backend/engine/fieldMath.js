/**
 * fieldMath.js — Field Geometry & Coverage Grid
 *
 * Coordinate system:
 *   X → East  (0 … FIELD_WIDTH)
 *   Z → North (0 … FIELD_DEPTH)
 *   Y → altitude
 *
 * 100-acre field → 600 × 200 grid → 3×2 = 6 zones
 * Each zone has a coverage grid tracking sprayed cells.
 */

// ─── Field dimensions ────────────────────────────────────────────────────────
const FIELD_WIDTH  = 600;
const FIELD_DEPTH  = 200;
const COLS = 3;
const ROWS = 2;
const GAP  = 10;

const ZONE_W = (FIELD_WIDTH - (COLS - 1) * GAP) / COLS;
const ZONE_D = (FIELD_DEPTH - (ROWS - 1) * GAP) / ROWS;

const HOVER_ALTITUDE = 15;
const TREES_PER_ZONE = Math.round((100 * 10000) / 6);
const LANE_SPACING   = 2;
const DRONE_RADIUS   = 2;
const SPRAY_WIDTH    = 3; // spray covers 3 units width centered on drone

// ─── Coverage Grid ───────────────────────────────────────────────────────────
/**
 * Create a boolean coverage grid for a zone.
 * Each cell = LANE_SPACING × LANE_SPACING area.
 */
function createCoverageGrid(zone) {
  const cols = Math.ceil((zone.xMax - zone.xMin) / LANE_SPACING);
  const rows = Math.ceil((zone.zMax - zone.zMin) / LANE_SPACING);
  return {
    cols,
    rows,
    cells: new Uint8Array(cols * rows), // 0 = uncovered, 1 = covered
    coveredCount: 0,
    totalCells: cols * rows,
  };
}

/**
 * Mark cells as covered around a drone position.
 * Returns number of NEW cells covered.
 */
function markCovered(grid, zone, x, z) {
  let newlyCovered = 0;
  const halfW = Math.ceil(SPRAY_WIDTH / LANE_SPACING / 2);

  const centerCol = Math.floor((x - zone.xMin) / LANE_SPACING);
  const centerRow = Math.floor((z - zone.zMin) / LANE_SPACING);

  for (let dc = -halfW; dc <= halfW; dc++) {
    const col = centerCol + dc;
    const row = centerRow;
    if (col >= 0 && col < grid.cols && row >= 0 && row < grid.rows) {
      const idx = row * grid.cols + col;
      if (!grid.cells[idx]) {
        grid.cells[idx] = 1;
        grid.coveredCount++;
        newlyCovered++;
      }
    }
  }
  return newlyCovered;
}

function getCoveragePct(grid) {
  return (grid.coveredCount / grid.totalCells) * 100;
}

// ─── Zone factory ────────────────────────────────────────────────────────────
function buildZones() {
  const zones = [];
  let id = 1;
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const xMin = col * (ZONE_W + GAP);
      const xMax = xMin + ZONE_W;
      const zMin = row * (ZONE_D + GAP);
      const zMax = zMin + ZONE_D;

      const zone = {
        id: `zone_${id}`,
        zoneIndex: id - 1,
        col, row,
        xMin, xMax, zMin, zMax,
        cx: (xMin + xMax) / 2,
        cz: (zMin + zMax) / 2,
        area: (xMax - xMin) * (zMax - zMin), // world units²
        totalTrees: TREES_PER_ZONE,
        completionPct: 0,
        assignedDrone: null,
        status: 'PENDING',        // PENDING | ACTIVE | COMPLETED
        priority: id,             // lower = higher priority (zone_1 first)
      };
      zone._coverageGrid = createCoverageGrid(zone);
      zones.push(zone);
      id++;
    }
  }
  return zones;
}

// ─── Waypoint generation (boustrophedon) ──────────────────────────────────────
function generateWaypoints(zone) {
  const waypoints = [];
  const strips = [40, 40, 20];

  let currentZMin = zone.zMin;
  let sweepRight = true;

  for (const stripLen of strips) {
    let currentZMax = Math.min(currentZMin + stripLen, zone.zMax);
    if (currentZMin >= zone.zMax) break;

    let goForward = true;
    let x = sweepRight ? zone.xMin : zone.xMax;
    let endX = sweepRight ? zone.xMax : zone.xMin;
    let stepX = sweepRight ? LANE_SPACING : -LANE_SPACING;

    while (sweepRight ? x <= endX : x >= endX) {
      const zStart = goForward ? currentZMin : currentZMax;
      const zEnd   = goForward ? currentZMax : currentZMin;
      waypoints.push({ x, z: zStart });
      waypoints.push({ x, z: zEnd });
      goForward = !goForward;
      x += stepX;
    }

    currentZMin = currentZMax;
    sweepRight = !sweepRight;
  }

  return waypoints;
}

// ─── Geometry utilities ──────────────────────────────────────────────────────
function dist2D(a, b) {
  return Math.hypot(b.x - a.x, b.z - a.z);
}

function isColliding(posA, posB) {
  return dist2D(posA, posB) < DRONE_RADIUS * 2;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Gaussian random with Box-Muller transform.
 * Returns a value ~N(0, 1).
 */
function gaussRandom() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

module.exports = {
  FIELD_WIDTH, FIELD_DEPTH, HOVER_ALTITUDE,
  LANE_SPACING, DRONE_RADIUS, SPRAY_WIDTH,
  TREES_PER_ZONE, ZONE_W, ZONE_D,
  buildZones, generateWaypoints,
  createCoverageGrid, markCovered, getCoveragePct,
  dist2D, isColliding, clamp, gaussRandom,
};
