/**
 * droneLogic.js — Drone State Machine + Simulated Hardware Layer
 *
 * State machine:
 *   IDLE → SPRAYING → RETURNING → CHARGING → (re-deploy or MISSION_COMPLETE)
 *
 * Simulated hardware realism:
 *   - Gaussian noise on position (GPS jitter)
 *   - Wind vector affecting speed & drift
 *   - Speed variation per tick
 *   - Random motor failure chance
 *   - Battery recharging at base
 *   - Predictive: can this drone finish its zone?
 */

const {
  dist2D, clamp, gaussRandom,
  HOVER_ALTITUDE, TREES_PER_ZONE, LANE_SPACING,
  markCovered,
} = require('./fieldMath');

// ─── Physics constants ────────────────────────────────────────────────────────
const SPRAY_TIME_S    = 5.0;
const TREE_SPACING    = 2.0;
const BASE_SPEED      = (TREE_SPACING / SPRAY_TIME_S) * 0.2; // 0.08 units/tick
const RETURN_SPEED    = BASE_SPEED * 3;
const LAND_SPEED      = 0.3;
const MOVE_DRAIN      = 0.008;
const SPRAY_DRAIN     = 0.04;
const HOVER_DRAIN     = 0.003;
const CHARGE_RATE     = 0.25;  // % per tick while charging
const TICK_S          = 0.2;
const LOW_BATTERY     = 20;
const FULL_CHARGE     = 95;   // charged "enough" to redeploy (not always 100)
const FAILURE_CHANCE  = 0.00008; // per tick (~0.04% per minute)

// Noise parameters
const POS_NOISE_STD   = 0.03;  // position jitter (world units)
const SPEED_NOISE_STD = 0.008; // speed variation

// ─── Factory ──────────────────────────────────────────────────────────────────
function createDrone(id, zone, colorHue, baseX = 0) {
  return {
    id,
    assignedZone:     zone.id,
    status:           'IDLE',        // IDLE | SPRAYING | RETURNING | CHARGING | MISSION_COMPLETE
    battery:          100,
    position:         { x: baseX, y: 0, z: zone.zMin },
    startPosition:    { x: baseX, y: 0, z: zone.zMin },
    targetWaypoint:   null,
    waypointQueue:    [],
    treesSprayedThisTick: 0,
    totalTreesSprayed:    0,
    distanceTraveled:     0,
    speed:                0,
    efficiency:           0,
    sprayingArea:         0,
    colorHue,
    trail:            [],
    TRAIL_MAX:        40,
    // Hardware simulation fields
    motorFault:       false,
    faultTick:        0,
    missionsFlown:    0,    // how many zones this drone has completed
    // Prediction fields (computed each tick)
    prediction: {
      canFinishZone:     true,
      etaSeconds:        0,
      batteryAtFinish:   100,
      confidence:        1.0,
    },
  };
}

// ─── Main tick ────────────────────────────────────────────────────────────────
/**
 * @param {DroneState} drone
 * @param {Zone[]}     zones
 * @param {number}     now
 * @param {{ dx: number, dz: number, speed: number }} wind — global wind vector
 * @returns {string[]}  array of event strings (can be empty)
 */
function tickDrone(drone, zones, now, wind = { dx: 0, dz: 0, speed: 0 }) {
  const events = [];

  // Hover drain when airborne
  if (drone.position.y > 0) {
    drone.battery -= HOVER_DRAIN * TICK_S;
    drone.battery  = clamp(drone.battery, 0, 100);
  }

  // Motor fault check (only when airborne and spraying)
  if (drone.status === 'SPRAYING' && !drone.motorFault) {
    if (Math.random() < FAILURE_CHANCE) {
      drone.motorFault = true;
      drone.faultTick  = 5; // reduced speed for 5 ticks then auto-recover
      events.push(`MOTOR_FAULT:${drone.id}:temporary_reduced_thrust`);
    }
  }

  // Auto-recover from fault
  if (drone.motorFault) {
    drone.faultTick--;
    if (drone.faultTick <= 0) {
      drone.motorFault = false;
      events.push(`FAULT_CLEARED:${drone.id}:motors_nominal`);
    }
  }

  switch (drone.status) {
    case 'IDLE':
      drone.speed = 0;
      break;

    case 'SPRAYING': {
      const ev = _handleSpraying(drone, zones, wind);
      if (ev) events.push(...ev);
      break;
    }

    case 'RETURNING': {
      const ev = _handleReturning(drone, zones, wind);
      if (ev) events.push(...ev);
      break;
    }

    case 'CHARGING': {
      const ev = _handleCharging(drone);
      if (ev) events.push(...ev);
      break;
    }

    case 'MISSION_COMPLETE':
      drone.speed = 0;
      break;
  }

  // Update prediction for active drones
  if (drone.status === 'SPRAYING') {
    _updatePrediction(drone, zones, wind);
  }

  return events;
}

// ─── SPRAYING handler ─────────────────────────────────────────────────────────
function _handleSpraying(drone, zones, wind) {
  const events = [];

  // Take off if grounded
  if (drone.position.y < HOVER_ALTITUDE) {
    drone.position.y = Math.min(drone.position.y + LAND_SPEED, HOVER_ALTITUDE);
    drone.speed = LAND_SPEED / TICK_S;
    return events;
  }

  // Look up assigned zone first
  const zone = zones.find(z => z.id === drone.assignedZone);
  if (!zone) return events;

  // Predictive battery check: can we finish the zone?
  // Grace period: let drone fly for at least 50 waypoints before checking prediction
  const hasFlownEnough = drone.waypointQueue.length < (zone._totalWaypoints - 50);
  if (drone.battery <= LOW_BATTERY) {
    drone.status = 'RETURNING';
    events.push(`RTB:${drone.id}:low_battery:${drone.battery.toFixed(1)}%`);
    return events;
  }
  if (hasFlownEnough && !drone.prediction.canFinishZone) {
    drone.status = 'RETURNING';
    events.push(`RTB:${drone.id}:insufficient_battery_for_zone:${drone.battery.toFixed(1)}%`);
    return events;
  }

  // Zone complete
  if (!drone.targetWaypoint || drone.waypointQueue.length === 0) {
    zone.completionPct = 100;
    zone.status = 'COMPLETED';
    zone.assignedDrone = null;
    drone.status = 'RETURNING';
    drone.missionsFlown++;
    events.push(`ZONE_COMPLETE:${zone.id}:by:${drone.id}`);
    return events;
  }

  // Calculate effective speed (with noise, wind, fault)
  let effectiveSpeed = BASE_SPEED;
  effectiveSpeed += gaussRandom() * SPEED_NOISE_STD; // speed jitter
  effectiveSpeed *= drone.motorFault ? 0.4 : 1.0;    // fault penalty

  // Wind effect: headwind/tailwind relative to movement direction
  const target = drone.targetWaypoint;
  const dx = target.x - drone.position.x;
  const dz = target.z - drone.position.z;
  const moveLen = Math.hypot(dx, dz) || 1;
  const moveDirX = dx / moveLen;
  const moveDirZ = dz / moveLen;
  const windDot = (wind.dx * moveDirX + wind.dz * moveDirZ) * wind.speed * 0.01;
  effectiveSpeed += windDot;
  effectiveSpeed = Math.max(0.01, effectiveSpeed); // never negative/zero

  const d = dist2D(drone.position, target);
  let moved = 0;

  if (d <= effectiveSpeed) {
    drone.position.x = target.x;
    drone.position.z = target.z;
    moved = d;
    drone.waypointQueue.shift();
    drone.targetWaypoint = drone.waypointQueue[0] || null;
    zone._waypoints = drone.waypointQueue;
  } else {
    const ratio = effectiveSpeed / d;
    drone.position.x += dx * ratio;
    drone.position.z += dz * ratio;
    moved = effectiveSpeed;
  }

  // GPS noise (small position jitter)
  drone.position.x += gaussRandom() * POS_NOISE_STD;
  drone.position.z += gaussRandom() * POS_NOISE_STD;

  // Wind drift (lateral push)
  drone.position.x += wind.dx * wind.speed * 0.002;
  drone.position.z += wind.dz * wind.speed * 0.002;

  drone.position.y = HOVER_ALTITUDE;

  // Battery drain
  drone.battery -= moved * MOVE_DRAIN;
  drone.battery -= SPRAY_DRAIN * TICK_S;
  drone.battery  = clamp(drone.battery, 0, 100);

  // Metrics
  drone.distanceTraveled += moved;
  drone.speed = effectiveSpeed / TICK_S;

  const treesThisTick = moved / TREE_SPACING;
  drone.treesSprayedThisTick = treesThisTick;
  drone.totalTreesSprayed   += treesThisTick;
  drone.sprayingArea = drone.distanceTraveled * TREE_SPACING;

  const drainSinceStart = 100 - drone.battery;
  drone.efficiency = drainSinceStart > 0 ? (drone.totalTreesSprayed / drainSinceStart) : 0;

  // Mark coverage grid
  if (zone._coverageGrid) {
    markCovered(zone._coverageGrid, zone, drone.position.x, drone.position.z);
    zone.completionPct = clamp(
      (zone._coverageGrid.coveredCount / zone._coverageGrid.totalCells) * 100,
      0, 99.9
    );
  }

  _pushTrail(drone);
  return events;
}

// ─── RETURNING handler ────────────────────────────────────────────────────────
function _handleReturning(drone, zones, wind) {
  const events = [];
  const home = drone.startPosition;
  const d    = dist2D(drone.position, home);

  let speed = RETURN_SPEED;
  speed *= drone.motorFault ? 0.5 : 1.0;

  if (d <= speed) {
    drone.position.x = home.x;
    drone.position.z = home.z;

    // Landing sequence
    if (drone.position.y > 0) {
      drone.position.y = Math.max(0, drone.position.y - LAND_SPEED);
      drone.speed = LAND_SPEED / TICK_S;
      _pushTrail(drone);
      return events;
    }

    // Landed → enter charging state
    drone.position.y = 0;
    drone.speed = 0;
    drone.treesSprayedThisTick = 0;
    drone.status = 'CHARGING';
    drone.motorFault = false;
    events.push(`LANDED:${drone.id}:entering_charge_mode`);
    return events;
  }

  const dx = home.x - drone.position.x;
  const dz = home.z - drone.position.z;
  const ratio = speed / d;
  drone.position.x += dx * ratio;
  drone.position.z += dz * ratio;

  // Wind drift during return
  drone.position.x += wind.dx * wind.speed * 0.001;
  drone.position.z += wind.dz * wind.speed * 0.001;

  drone.battery -= speed * MOVE_DRAIN;
  drone.battery  = clamp(drone.battery, 0, 100);
  drone.speed = speed / TICK_S;
  drone.treesSprayedThisTick = 0;

  _pushTrail(drone);
  return events;
}

// ─── CHARGING handler ─────────────────────────────────────────────────────────
function _handleCharging(drone) {
  const events = [];
  drone.speed = 0;
  drone.position.y = 0;

  // Recharge battery
  const oldBat = drone.battery;
  drone.battery = clamp(drone.battery + CHARGE_RATE, 0, 100);

  // Log charge milestones
  if (oldBat < 50 && drone.battery >= 50) {
    events.push(`CHARGE_50:${drone.id}:battery_at_50%`);
  }
  if (drone.battery >= FULL_CHARGE) {
    events.push(`CHARGE_READY:${drone.id}:battery_${drone.battery.toFixed(0)}%`);
    // Don't auto-dispatch — simulation.js will decide
  }

  return events;
}

// ─── Prediction engine ────────────────────────────────────────────────────────
function _updatePrediction(drone, zones, wind) {
  const zone = zones.find(z => z.id === drone.assignedZone);
  if (!zone) {
    drone.prediction = { canFinishZone: true, etaSeconds: 0, batteryAtFinish: 100, confidence: 0.5 };
    return;
  }

  const remainingWPs = drone.waypointQueue.length;
  const totalWPs     = zone._totalWaypoints || 1;
  const avgWPDist    = TREE_SPACING;
  const remainingDist = remainingWPs * avgWPDist;

  // Time estimate (in seconds)
  const speedPerSec = Math.max(0.01, BASE_SPEED / TICK_S);
  const etaSeconds = remainingDist / speedPerSec;

  // Battery estimate: drain per tick × number of ticks
  const ticksToFinish = etaSeconds / TICK_S;
  const drainPerTick = (BASE_SPEED * MOVE_DRAIN) + (SPRAY_DRAIN * TICK_S) + (HOVER_DRAIN * TICK_S);
  const batteryNeeded = drainPerTick * ticksToFinish;
  const batteryAtFinish = drone.battery - batteryNeeded;

  // Return cost estimate
  const returnDist = dist2D(drone.position, drone.startPosition);
  const returnTicks = returnDist / RETURN_SPEED;
  const returnBatteryCost = (returnTicks * RETURN_SPEED * MOVE_DRAIN) + (returnTicks * HOVER_DRAIN * TICK_S);

  // Can finish if battery at end of zone is above LOW_BATTERY + return cost
  const canFinish = batteryAtFinish > (LOW_BATTERY + returnBatteryCost);

  // Confidence: increases with progress, decreases with wind
  const progressPct = (totalWPs - remainingWPs) / totalWPs;
  const windPenalty = (wind.speed || 0) * 0.02;
  const confidence = clamp(0.6 + progressPct * 0.35 - windPenalty, 0.3, 0.99);

  drone.prediction = {
    canFinishZone: canFinish,
    etaSeconds: Math.round(etaSeconds),
    batteryAtFinish: parseFloat(batteryAtFinish.toFixed(1)),
    confidence: parseFloat(confidence.toFixed(2)),
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function _pushTrail(drone) {
  drone.trail.push({ x: drone.position.x, z: drone.position.z });
  if (drone.trail.length > drone.TRAIL_MAX) drone.trail.shift();
}

module.exports = {
  createDrone, tickDrone,
  BASE_SPEED, RETURN_SPEED, LOW_BATTERY, FULL_CHARGE, CHARGE_RATE,
};
