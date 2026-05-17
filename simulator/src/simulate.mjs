import "dotenv/config";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const mode = process.argv[2] || "normal";
const ingestUrl = process.env.BACKEND_INGEST_URL || "http://localhost:8080/ingest";
const pollMs = Number(process.env.POLL_MS || 1500);
const turbines = ["Turbine_01"];

// ── IoT Hub device clients (optional) ────────────────────────────────────
// When IOT_HUB_CONN_TURBINE_XX env vars are set the simulator sends
// telemetry as D2C messages to IoT Hub.  Without them it falls back to
// the backend HTTP /ingest endpoint (useful for local development).

const iotClients = new Map();
let IotMessage = null; // captured once during initIotHubClients

async function initIotHubClients() {
  const connStrings = {
    Turbine_01: process.env.IOT_HUB_CONN_TURBINE_01
  };

  const anyConnStr = Object.values(connStrings).some(Boolean);
  if (!anyConnStr) return false; // IoT Hub not configured — use HTTP ingest

  try {
    // Use createRequire so CJS named exports are resolved correctly in ESM
    const { Client, Message } = require("azure-iot-device");
    const { Mqtt } = require("azure-iot-device-mqtt");
    IotMessage = Message;

    for (const [turbineId, connStr] of Object.entries(connStrings)) {
      if (!connStr) {
        console.warn(`[IoT Hub] No connection string for ${turbineId} — skipping`);
        continue;
      }
      const client = Client.fromConnectionString(connStr, Mqtt);
      await client.open();
      iotClients.set(turbineId, client);
      console.log(`[IoT Hub] Connected device: ${turbineId}`);
    }
    return iotClients.size > 0;
  } catch (err) {
    console.error("[IoT Hub] Init failed:", err.message);
    console.warn("[IoT Hub] Falling back to HTTP ingest");
    return false;
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function randomIn(min, max) {
  return min + Math.random() * (max - min);
}

// ── Wind direction — slow clockwise sweep with per-scenario turbulence ──────
// A full 360° sweep takes 60 ticks (90 s at 1.5 s/tick), clearly showing the
// nacelle yaw tracking behaviour.  Storm mode sweeps faster and adds gusty
// turbulence so the yaw lag and efficiency drop are visible.

let windDir = randomIn(0, 360);          // current wind direction (°)
// Start nacelle offset 30–60° away so yawCapacity begins noticeably below 100 %
// and the viewer can clearly show the nacelle tracking the wind.
const initialYawOffset = (Math.random() < 0.5 ? 1 : -1) * randomIn(30, 60);
let nacelleYawAngle = (windDir + initialYawOffset + 360) % 360;

// windDelta: current rate of direction change (°/tick), can be + or −.
// Uses an Ornstein-Uhlenbeck process: each tick it is pulled back towards 0
// plus random noise, so it regularly crosses zero and changes spin direction.
let windDelta = randomIn(-2, 2);

function stepWindDirection() {
  // Mean-reversion coefficient: higher = returns to zero faster.
  // At 0.15 the correlation time is ~7 ticks (~10 s) — natural feeling.
  const reversion  = mode === "storm" ? 0.08 : 0.15;
  const noiseScale = mode === "storm" ? 3.5  : 1.5;
  const deltaMax   = mode === "storm" ? 9    : 4;

  // Pull towards 0 + inject fresh noise every tick
  windDelta = windDelta * (1 - reversion) + randomIn(-noiseScale, noiseScale);
  windDelta = clamp(windDelta, -deltaMax, deltaMax);

  windDir = (windDir + windDelta + 360) % 360;
  return windDir;
}

/**
 * Slowly track wind direction with the nacelle.
 * Rate: 5°/s × (pollMs/1000 s/tick) — matches the viewer's 5°/s yaw animation.
 */
function stepNacelleYaw(currentWindDir) {
  const yawRatePerTick = 5 * (pollMs / 1000);
  // Shortest-path difference, wrapped to [-180, 180]
  let diff = ((currentWindDir - nacelleYawAngle + 180) % 360 + 360) % 360 - 180;
  const step = Math.max(-yawRatePerTick, Math.min(yawRatePerTick, diff));
  nacelleYawAngle = (nacelleYawAngle + step + 360) % 360;
  return nacelleYawAngle;
}

function makeMessage(turbineId) {
  const now = Date.now();

  const windDirDeg  = stepWindDirection();
  const nacelleDeg  = stepNacelleYaw(windDirDeg);

  // Yaw capacity: cos²(yaw_error).  1.0 = nacelle faces wind, 0.0 = perpendicular.
  const yawErrorDeg = ((nacelleDeg - windDirDeg + 180) % 360 + 360) % 360 - 180;
  const yawCapacityPct = Math.max(0, Math.cos(yawErrorDeg * Math.PI / 180) ** 2);

  const baseWind = mode === "storm" ? randomIn(16, 28) : randomIn(7, 14);
  const vibration = mode === "fault" ? randomIn(5.5, 8.2) : randomIn(1.2, 3.8);
  const nacelleTempC = mode === "fault" ? randomIn(85, 98) : randomIn(45, 68);
  // RPM is the IDEAL value at full alignment, then scaled by yaw capacity.
  const idealRpm  = clamp(baseWind * 1.2 + randomIn(-1.5, 1.5), 5, 40);
  const rotorRpm  = idealRpm * yawCapacityPct;
  const powerKw   = clamp(baseWind * 130 * yawCapacityPct + randomIn(-40, 50), 0, 4000);
  const alarmActive = vibration > 4.5 || nacelleTempC > 80;

  return {
    turbineId,
    scenario: mode,
    windSpeedMs:     Number(baseWind.toFixed(2)),
    windDirectionDeg: Number(windDirDeg.toFixed(1)),
    nacelleAngleDeg:  Number(nacelleDeg.toFixed(1)),
    yawCapacityPct:   Number(yawCapacityPct.toFixed(3)),
    vibrationMmS:    Number(vibration.toFixed(2)),
    nacelleTempC:    Number(nacelleTempC.toFixed(2)),
    rotorRpm:        Number(rotorRpm.toFixed(2)),
    powerKw:         Number(powerKw.toFixed(2)),
    alarmActive,
    status: alarmActive ? "ALARM: high vibration or temperature" : "Running",
    timestamp: new Date().toISOString()
  };
}

async function pushHttp(message) {
  const response = await fetch(ingestUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(message)
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ingest failed: ${response.status} ${text}`);
  }
}

async function pushIotHub(turbineId, message) {
  const client = iotClients.get(turbineId);
  if (!client) return pushHttp(message); // fallback if this device has no client
  const msg = new IotMessage(JSON.stringify(message));
  msg.contentType = "application/json";
  msg.contentEncoding = "utf-8";
  await client.sendEvent(msg);
}

// ── Main loop ─────────────────────────────────────────────────────────────

const useIotHub = await initIotHubClients();
console.log(`Starting simulator in "${mode}" mode -> ${useIotHub ? "IoT Hub" : ingestUrl}`);

setInterval(async () => {
  for (const turbineId of turbines) {
    const message = makeMessage(turbineId);
    try {
      if (useIotHub) {
        await pushIotHub(turbineId, message);
      } else {
        await pushHttp(message);
      }
      console.log(`[${message.timestamp}] ${message.turbineId} ${message.powerKw}kW alarm=${message.alarmActive}`);
    } catch (error) {
      console.error(`Failed to push ${turbineId}:`, error.message);
    }
  }
}, pollMs);
