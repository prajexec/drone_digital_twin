/**
 * simulation.js — Digital Twin Central Brain
 *
 * Responsibilities:
 *   1. Maintain global world state (drones, zones, wind, events)
 *   2. Run simulation loop @ 200ms (5 Hz)
 *   3. Intelligent task allocation (score-based)
 *   4. Dynamic reassignment (charged drones → uncompleted zones)
 *   5. Collision avoidance (min-distance check)
 *   6. Wind simulation (slowly drifting vector)
 *   7. Rich typed event system
 *   8. Mission prediction (ETA, coverage rate)
 */

const { buildZones, generateWaypoints, TREES_PER_ZONE, dist2D, getCoveragePct, clamp, gaussRandom } = require('./fieldMath');
const { createDrone, tickDrone, FULL_CHARGE } = require('./droneLogic');

const TICK_MS      = 200;
const TICK_S       = TICK_MS / 1000;
const NUM_DRONES   = 6;
const DRONE_COLORS = [210, 150, 40, 270, 330, 90];
const MIN_DRONE_DIST = 8; // minimum safe distance between airborne drones

// ─── Global State ─────────────────────────────────────────────────────────────
let zones     = [];
let drones    = [];
let tick      = 0;
let startTime = null;
let emitFn    = null;

// Wind state (simulated meteorological data)
let wind = {
  direction: 0,       // radians (0 = East, PI/2 = North)
  speed: 0,           // 0-5 scale
  dx: 0, dz: 0,       // unit vector components
  gustTimer: 0,
};

// Event system
let eventIdCounter = 0;
let recentEvents = []; // persistent buffer for getState()
const MAX_RECENT_EVENTS = 50;

// ─── Init ─────────────────────────────────────────────────────────────────────
function init(emitter) {
  emitFn = emitter;
  zones  = buildZones();

  zones.forEach(zone => {
    zone._waypoints      = generateWaypoints(zone);
    zone._totalWaypoints = zone._waypoints.length;
  });

  drones = zones.map((zone, idx) => {
    // Spread base stations: different X for each drone to avoid proximity spam
    const baseX = -40 - (idx * 15);
    const drone = createDrone(`drone_${idx + 1}`, zone, DRONE_COLORS[idx], baseX);
    zone.assignedDrone = drone.id;
    return drone;
  });

  // Intelligent initial dispatch — best drone for zone_1
  const bestDroneIdx = _findBestDrone(zones[0]);
  if (bestDroneIdx >= 0) {
    _dispatchDrone(drones[bestDroneIdx], zones[0]);
    // Push initial dispatch event to persistent log
    const initEvent = {
      id: ++eventIdCounter,
      message: `DISPATCHED:${drones[bestDroneIdx].id}→${zones[0].id}:initial_assignment`,
      timestamp: Date.now(),
      type: 'info',
    };
    recentEvents.push(initEvent);
  }

  startTime = Date.now();
  console.log('[DigitalTwin] Initialized — 6 drones, 6 zones, wind simulation active');
  _startLoop();
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────
function _dispatchDrone(drone, zone) {
  drone.status         = 'SPRAYING';
  drone.assignedZone   = zone.id;
  zone.status          = 'ACTIVE';
  zone.assignedDrone   = drone.id;
  drone.waypointQueue  = [...zone._waypoints];
  drone.targetWaypoint = drone.waypointQueue[0];
  console.log(`[DigitalTwin] Dispatching ${drone.id} → ${zone.id}`);
}

// ─── Intelligent Task Allocator ───────────────────────────────────────────────
/**
 * Score-based allocation: find the best available drone for a zone.
 * Score = battery_weight(0.4) + distance_weight(0.3) + missions_weight(0.3)
 *
 * @returns {number} drone index or -1
 */
function _findBestDrone(zone) {
  let bestScore = -1;
  let bestIdx   = -1;

  const maxDist = 700; // approximate max distance across field

  drones.forEach((drone, idx) => {
    // Only consider IDLE or fully CHARGED drones
    if (drone.status !== 'IDLE' && !(drone.status === 'CHARGING' && drone.battery >= FULL_CHARGE)) {
      return;
    }

    const batteryScore  = drone.battery / 100;                           // 0-1
    const distScore     = 1 - (dist2D(drone.position, { x: zone.cx, z: zone.cz }) / maxDist); // 0-1
    const missionScore  = 1 - (drone.missionsFlown / 6);                 // prefer less-used drones

    const score = batteryScore * 0.4 + distScore * 0.3 + missionScore * 0.3;

    if (score > bestScore) {
      bestScore = score;
      bestIdx   = idx;
    }
  });

  return bestIdx;
}

/**
 * Find the next uncompleted, unassigned zone.
 * Prioritizes by zone.priority (lower = higher priority).
 */
function _findNextZone() {
  return zones
    .filter(z => z.status !== 'COMPLETED' && z.status !== 'ACTIVE')
    .sort((a, b) => a.priority - b.priority)[0] || null;
}

// ─── Collision Avoidance ──────────────────────────────────────────────────────
let lastProximityTick = {}; // track last alert per pair

function _checkCollisions(events) {
  const airborne = drones.filter(d => d.position.y > 1 && (d.status === 'SPRAYING' || d.status === 'RETURNING'));
  
  for (let i = 0; i < airborne.length; i++) {
    for (let j = i + 1; j < airborne.length; j++) {
      const d = dist2D(airborne[i].position, airborne[j].position);
      if (d < MIN_DRONE_DIST) {
        // Rate-limit alerts: max once per 25 ticks per pair
        const pairKey = `${airborne[i].id}_${airborne[j].id}`;
        if (lastProximityTick[pairKey] && tick - lastProximityTick[pairKey] < 25) continue;
        lastProximityTick[pairKey] = tick;

        const yielder = airborne[i].battery < airborne[j].battery ? airborne[i] : airborne[j];
        const other   = yielder === airborne[i] ? airborne[j] : airborne[i];
        const dx = yielder.position.x - other.position.x;
        const dz = yielder.position.z - other.position.z;
        const len = Math.hypot(dx, dz) || 1;
        yielder.position.x += (dx / len) * 1.0;
        yielder.position.z += (dz / len) * 1.0;
        events.push(`PROXIMITY_ALERT:${airborne[i].id}↔${airborne[j].id}:dist=${d.toFixed(1)}`);
      }
    }
  }
}

// ─── Wind Simulation ──────────────────────────────────────────────────────────
function _updateWind() {
  wind.gustTimer--;

  if (wind.gustTimer <= 0) {
    // New wind pattern every 50-200 ticks (10-40 seconds)
    wind.gustTimer = 50 + Math.floor(Math.random() * 150);
    
    // Slowly shift direction
    wind.direction += (gaussRandom() * 0.3);
    wind.direction  = wind.direction % (Math.PI * 2);

    // Speed: 0-3 normally, occasional gusts up to 5
    const isGust = Math.random() < 0.1;
    wind.speed = clamp(
      wind.speed + gaussRandom() * (isGust ? 1.5 : 0.5),
      0, 5
    );
  }

  wind.dx = Math.cos(wind.direction);
  wind.dz = Math.sin(wind.direction);
}

// ─── Main Loop ────────────────────────────────────────────────────────────────
function _startLoop() {
  setInterval(() => {
    tick++;
    const now = Date.now();
    const events = [];

    // 1. Update wind
    _updateWind();

    // 2. Tick all drones
    drones.forEach((drone, idx) => {
      const oldStatus = drone.status;
      const droneEvents = tickDrone(drone, zones, now, wind);
      events.push(...droneEvents);

      // 3. Sequential handoff: when drone starts returning, dispatch next available
      if (oldStatus === 'SPRAYING' && drone.status === 'RETURNING') {
        const nextZone = _findNextZone();
        if (nextZone) {
          const bestIdx = _findBestDrone(nextZone);
          if (bestIdx >= 0) {
            _dispatchDrone(drones[bestIdx], nextZone);
            events.push(`DISPATCHED:${drones[bestIdx].id}→${nextZone.id}:replacing:${drone.id}`);
          }
        }
      }

      // 4. Re-deploy charged drones to uncompleted zones
      if (oldStatus === 'CHARGING' && drone.battery >= FULL_CHARGE) {
        const nextZone = _findNextZone();
        if (nextZone) {
          _dispatchDrone(drone, nextZone);
          events.push(`REDEPLOYED:${drone.id}→${nextZone.id}:battery:${drone.battery.toFixed(0)}%`);
        } else {
          // No more zones to do
          drone.status = 'MISSION_COMPLETE';
          events.push(`MISSION_COMPLETE:${drone.id}:all_zones_handled`);
        }
      }
    });

    // 5. Collision avoidance
    _checkCollisions(events);

    // 6. Check full mission completion
    const allDone = zones.every(z => z.status === 'COMPLETED');
    const allLanded = drones.every(d => d.status === 'MISSION_COMPLETE' || d.status === 'CHARGING');
    if (allDone && allLanded) {
      const alreadySent = events.some(e => e.includes('ALL_ZONES_COMPLETE'));
      if (!alreadySent) {
        events.push('ALL_ZONES_COMPLETE:mission_finished');
      }
    }

    // 7. Build and emit telemetry
    const payload = _buildPayload(now, events);
    if (emitFn) emitFn(payload);

    // Log notable events
    if (events.length > 0) {
      events.forEach(e => console.log(`[T${tick}] ${e}`));
    }
  }, TICK_MS);
}

// ─── Payload Builder ──────────────────────────────────────────────────────────
function _buildPayload(now, events = []) {
  const activeDrones  = drones.filter(d => d.status === 'SPRAYING' || d.status === 'RETURNING').length;
  const chargingCount = drones.filter(d => d.status === 'CHARGING').length;
  const totalCoverage = _totalCoverage();
  const elapsed = ((now - startTime) / 1000).toFixed(0);

  // Mission ETA: based on average completion rate
  const elapsedSec = Number(elapsed);
  let missionEta = 0;
  if (totalCoverage > 0 && totalCoverage < 100) {
    const ratePerSec = totalCoverage / (elapsedSec || 1);
    missionEta = Math.round((100 - totalCoverage) / ratePerSec);
  }

  // ─── Digital Twin System-Level Metrics ────────────────────────
  const totalTreesSprayed = drones.reduce((s, d) => s + d.totalTreesSprayed, 0);
  const totalBatteryConsumed = drones.reduce((s, d) => s + (100 - d.battery) + (d.missionsFlown * (100 - 20)), 0);
  const totalAreaCovered = drones.reduce((s, d) => s + d.sprayingArea, 0);

  // Operational efficiency: trees sprayed per battery % consumed
  const operationalEfficiency = totalBatteryConsumed > 0
    ? parseFloat((totalTreesSprayed / totalBatteryConsumed).toFixed(2))
    : 0;

  // Coverage rate: acres per hour (100 acres total, extrapolated from current rate)
  const acresCovered = (totalCoverage / 100) * 100; // 100 acres total
  const hoursElapsed = elapsedSec / 3600;
  const coverageRateAcresPerHour = hoursElapsed > 0
    ? parseFloat((acresCovered / hoursElapsed).toFixed(1))
    : 0;

  // Resource utilization: area output per unit battery consumed
  const resourceUtilization = totalBatteryConsumed > 0
    ? parseFloat((totalAreaCovered / totalBatteryConsumed).toFixed(2))
    : 0;

  // Fleet utilization: fraction of fleet actively working (0-1)
  const fleetUtilization = parseFloat((activeDrones / NUM_DRONES).toFixed(2));

  return {
    timestamp: now,
    tick,
    elapsed_s: elapsedSec,
    events: _convertAndStoreEvents(events, now),
    // Global environment
    wind: {
      direction_deg: parseFloat(((wind.direction * 180 / Math.PI) % 360).toFixed(0)),
      speed: parseFloat(wind.speed.toFixed(1)),
      dx: parseFloat(wind.dx.toFixed(3)),
      dz: parseFloat(wind.dz.toFixed(3)),
    },
    metrics: {
      total_coverage_percent: parseFloat(totalCoverage.toFixed(2)),
      active_drones: activeDrones,
      charging_drones: chargingCount,
      total_trees_sprayed: totalTreesSprayed,
      total_trees: TREES_PER_ZONE * 6,
      completed_zones: zones.filter(z => z.status === 'COMPLETED').length,
      mission_eta_seconds: missionEta,
      // Digital Twin KPIs
      operational_efficiency: operationalEfficiency,
      coverage_rate_acres_per_hour: coverageRateAcresPerHour,
      resource_utilization: resourceUtilization,
      fleet_utilization: fleetUtilization,
      total_battery_consumed: parseFloat(totalBatteryConsumed.toFixed(1)),
    },
    drones: drones.map(d => ({
      id:              d.id,
      assigned_zone:   d.assignedZone,
      status:          d.status,
      battery:         parseFloat(d.battery.toFixed(1)),
      position:        {
        x: parseFloat(d.position.x.toFixed(2)),
        y: parseFloat(d.position.y.toFixed(2)),
        z: parseFloat(d.position.z.toFixed(2)),
      },
      target_waypoint: d.targetWaypoint
        ? { x: parseFloat(d.targetWaypoint.x.toFixed(2)), z: parseFloat(d.targetWaypoint.z.toFixed(2)) }
        : null,
      trail:           d.trail.slice(-20),
      distance_traveled: parseFloat(d.distanceTraveled.toFixed(1)),
      speed:           parseFloat(d.speed.toFixed(2)),
      efficiency:      parseFloat(d.efficiency.toFixed(1)),
      spraying_area:   parseFloat(d.sprayingArea.toFixed(1)),
      color_hue:       d.colorHue,
      motor_fault:     d.motorFault,
      missions_flown:  d.missionsFlown,
      prediction:      d.prediction,
    })),
    zones: zones.map(z => ({
      id:               z.id,
      status:           z.status,
      completion_pct:   parseFloat(z.completionPct.toFixed(1)),
      assigned_drone:   z.assignedDrone,
      bounds: {
        xMin: z.xMin, xMax: z.xMax,
        zMin: z.zMin, zMax: z.zMax,
      },
      cx: z.cx,
      cz: z.cz,
      area: z.area,
    })),
  };
}

// ─── Event classification ─────────────────────────────────────────────────────
function _classifyEvent(msg) {
  if (msg.includes('ZONE_COMPLETE') || msg.includes('ALL_ZONES') || msg.includes('MISSION_COMPLETE'))
    return 'success';
  if (msg.includes('CHARGE_READY') || msg.includes('CHARGE_50'))
    return 'success';
  if (msg.includes('RTB') || msg.includes('LOW_BATTERY') || msg.includes('PROXIMITY'))
    return 'warning';
  if (msg.includes('MOTOR_FAULT'))
    return 'error';
  if (msg.includes('FAULT_CLEARED'))
    return 'info';
  if (msg.includes('DISPATCHED') || msg.includes('REDEPLOYED') || msg.includes('LANDED'))
    return 'info';
  return 'info';
}

function _totalCoverage() {
  const sum = zones.reduce((s, z) => s + z.completionPct, 0);
  return sum / zones.length;
}

/**
 * Convert raw event strings to typed event objects and store in persistent buffer.
 */
function _convertAndStoreEvents(rawEvents, now) {
  const typed = rawEvents.map(msg => ({
    id: ++eventIdCounter,
    message: msg,
    timestamp: now,
    type: _classifyEvent(msg),
  }));
  recentEvents.push(...typed);
  if (recentEvents.length > MAX_RECENT_EVENTS) {
    recentEvents = recentEvents.slice(-MAX_RECENT_EVENTS);
  }
  return typed;
}

// ─── Public API ───────────────────────────────────────────────────────────────
function getState() {
  const state = _buildPayload(Date.now());
  // On getState (initial snapshot), include all recent events so new clients see history
  state.events = [...recentEvents];
  return state;
}

/**
 * Bidirectional Command Interface — closes the Digital Twin control loop.
 * Commands flow: UI → WebSocket → handleCommand → engine state mutation → telemetry update → UI
 *
 * Supported commands:
 *   - recall_drone:    Force a specific drone to return to base immediately
 *   - reassign_drone:  Reassign a drone to a specific zone
 *   - prioritize_zone: Change zone priority (affects task allocation order)
 */
function handleCommand(command) {
  const now = Date.now();
  const { type, payload } = command;

  switch (type) {
    case 'recall_drone': {
      const drone = drones.find(d => d.id === payload.droneId);
      if (drone && drone.status === 'SPRAYING') {
        drone.status = 'RETURNING';
        const zone = zones.find(z => z.id === drone.assignedZone);
        if (zone) {
          zone.status = 'PENDING';
          zone.assignedDrone = null;
        }
        const evt = {
          id: ++eventIdCounter,
          message: `MANUAL_RECALL:${drone.id}:operator_command`,
          timestamp: now,
          type: 'warning',
        };
        recentEvents.push(evt);
        return { success: true, event: evt };
      }
      return { success: false, reason: 'Drone not spraying or not found' };
    }

    case 'reassign_drone': {
      const drone = drones.find(d => d.id === payload.droneId);
      const zone  = zones.find(z => z.id === payload.zoneId);
      if (drone && zone && (drone.status === 'IDLE' || (drone.status === 'CHARGING' && drone.battery >= FULL_CHARGE))) {
        _dispatchDrone(drone, zone);
        const evt = {
          id: ++eventIdCounter,
          message: `MANUAL_ASSIGN:${drone.id}→${zone.id}:operator_override`,
          timestamp: now,
          type: 'info',
        };
        recentEvents.push(evt);
        return { success: true, event: evt };
      }
      return { success: false, reason: 'Drone not available or zone not found' };
    }

    case 'prioritize_zone': {
      const zone = zones.find(z => z.id === payload.zoneId);
      if (zone) {
        zone.priority = payload.priority || 0; // lower = higher priority
        const evt = {
          id: ++eventIdCounter,
          message: `PRIORITY_CHANGE:${zone.id}:priority=${zone.priority}:operator_decision`,
          timestamp: now,
          type: 'info',
        };
        recentEvents.push(evt);
        return { success: true, event: evt };
      }
      return { success: false, reason: 'Zone not found' };
    }

    default:
      return { success: false, reason: `Unknown command: ${type}` };
  }
}

module.exports = { init, getState, handleCommand };
