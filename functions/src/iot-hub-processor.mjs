import "dotenv/config";
import { app } from "@azure/functions";
import { DigitalTwinsClient } from "@azure/digital-twins-core";
import { DefaultAzureCredential } from "@azure/identity";

/**
 * IoT Hub Telemetry Processor
 *
 * Triggered by the IoT Hub built-in EventHub endpoint.
 * Each invocation receives a batch of D2C telemetry messages.
 *
 * Flow:
 *   Turbine device  →  IoT Hub (MQTT D2C)
 *   IoT Hub         →  EventHub endpoint  →  this Function
 *   Function        →  ADT (patch twins)
 *   Function        →  Backend /ingest (triggers WebSocket broadcast)
 *
 * Required application settings:
 *   ADT_URL          — ADT instance hostname
 *   BACKEND_INGEST_URL — Backend HTTP ingest endpoint
 *   IOT_HUB_CONNECTION — IoT Hub EventHub-compatible connection string
 *                        (used by the trigger binding)
 */

const adtUrl = process.env.ADT_URL;
const backendIngestUrl = process.env.BACKEND_INGEST_URL || "http://localhost:8080/ingest";
const FARM_ID = process.env.FARM_ID || "WindFarm_01";
const TURBINE_IDS = ["Turbine_01"];

let adtClient = null;
if (adtUrl) {
  adtClient = new DigitalTwinsClient(adtUrl, new DefaultAzureCredential());
} else {
  console.warn("[iot-processor] ADT_URL not set — twin writes disabled.");
}

// ── Patch helpers ─────────────────────────────────────────────────────────

async function patchTurbine(turbineId, payload) {
  if (!adtClient) return;
  const now = new Date().toISOString();
  await adtClient.updateDigitalTwin(turbineId, [
    { op: "replace", path: "/windSpeedMs",  value: payload.windSpeedMs },
    { op: "replace", path: "/vibrationMmS", value: payload.vibrationMmS },
    { op: "replace", path: "/nacelleTempC", value: payload.nacelleTempC },
    { op: "replace", path: "/rotorRpm",     value: payload.rotorRpm },
    { op: "replace", path: "/powerKw",      value: payload.powerKw },
    { op: "replace", path: "/alarmActive",  value: payload.alarmActive },
    { op: "replace", path: "/status",       value: payload.status },
    { op: "replace", path: "/lastUpdated",  value: now }
  ]);
}

async function patchSensor(turbineId, kind, value) {
  if (!adtClient) return;
  const sensorId = `${turbineId}_Sensor_${kind}`;
  await adtClient.updateDigitalTwin(sensorId, [
    { op: "replace", path: "/value",  value },
    { op: "replace", path: "/online", value: true }
  ]);
}

async function patchFarm(totalPowerKw, averageWindSpeedMs) {
  if (!adtClient) return;
  await adtClient.updateDigitalTwin(FARM_ID, [
    { op: "replace", path: "/totalPowerKw",       value: totalPowerKw },
    { op: "replace", path: "/averageWindSpeedMs", value: averageWindSpeedMs },
    { op: "replace", path: "/lastUpdated",        value: new Date().toISOString() }
  ]);
}

// ── Farm-level KPI aggregation (in-memory within function instance) ────────
// Note: Azure Functions Consumption plan may run multiple instances.
// For a lab, single-instance accuracy is sufficient.

const farmState = new Map();

function computeFarmKpis() {
  const reported = TURBINE_IDS.map((id) => farmState.get(id)).filter(Boolean);
  if (!reported.length) return null;
  return {
    totalPowerKw: Number(reported.reduce((s, x) => s + x.powerKw, 0).toFixed(2)),
    averageWindSpeedMs: Number(
      (reported.reduce((s, x) => s + x.windSpeedMs, 0) / TURBINE_IDS.length).toFixed(2)
    )
  };
}

// ── Forward to backend for WebSocket broadcast ─────────────────────────────

async function forwardToBackend(message) {
  try {
    const res = await fetch(backendIngestUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message)
    });
    if (!res.ok) {
      console.warn(`[iot-processor] Backend ingest returned ${res.status}`);
    }
  } catch (err) {
    console.warn("[iot-processor] Could not forward to backend:", err.message);
  }
}

// ── Azure Function trigger ─────────────────────────────────────────────────

app.eventHub("iotHubTelemetryProcessor", {
  // Binds to the IoT Hub built-in EventHub endpoint.
  // eventHubName must match the EntityPath in IOT_HUB_CONNECTION (not "messages/events").
  // Get the value: IoT Hub → Built-in endpoints → "Event Hub-compatible name".
  connection: "IOT_HUB_CONNECTION",
  eventHubName: "%IOT_HUB_EVENTHUB_NAME%",
  cardinality: "many",
  consumerGroup: "azfunctions",
  handler: async (messages, context) => {
    context.log(`[iot-processor] Processing batch of ${messages.length} message(s)`);

    for (const msg of messages) {
      let payload;
      try {
        payload = typeof msg === "string" ? JSON.parse(msg) : msg;
      } catch {
        context.log.warn("[iot-processor] Skipping non-JSON message");
        continue;
      }

      const { turbineId } = payload;
      if (!turbineId) {
        context.log.warn("[iot-processor] Message missing turbineId — skipping");
        continue;
      }

      farmState.set(turbineId, payload);
      const kpis = computeFarmKpis();

      try {
        await patchTurbine(turbineId, payload);
        await Promise.allSettled([
          patchSensor(turbineId, "WindSpeed",   payload.windSpeedMs),
          patchSensor(turbineId, "Vibration",   payload.vibrationMmS),
          patchSensor(turbineId, "Temperature", payload.nacelleTempC),
          patchSensor(turbineId, "Power",       payload.powerKw)
        ]);
        if (kpis) await patchFarm(kpis.totalPowerKw, kpis.averageWindSpeedMs);
      } catch (err) {
        context.log.error("[iot-processor] ADT patch error:", err.message);
      }

      // Forward to backend for WebSocket broadcast (best-effort)
      await forwardToBackend(payload);
    }
  }
});
