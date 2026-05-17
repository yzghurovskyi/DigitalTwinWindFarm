import { DigitalTwinsClient } from "@azure/digital-twins-core";
import { DefaultAzureCredential } from "@azure/identity";

export function createAdtClient(adtUrl) {
  if (!adtUrl) return null;
  return new DigitalTwinsClient(adtUrl, new DefaultAzureCredential());
}

export async function patchTurbine(client, turbineId, payload) {
  if (!client) return;
  const patch = [
    { op: "replace", path: "/windSpeedMs", value: payload.windSpeedMs },
    { op: "replace", path: "/vibrationMmS", value: payload.vibrationMmS },
    { op: "replace", path: "/nacelleTempC", value: payload.nacelleTempC },
    { op: "replace", path: "/rotorRpm", value: payload.rotorRpm },
    { op: "replace", path: "/powerKw", value: payload.powerKw },
    { op: "replace", path: "/alarmActive", value: payload.alarmActive },
    { op: "replace", path: "/status", value: payload.status }
  ];
  await client.updateDigitalTwin(turbineId, patch);
}

export async function patchFarm(client, farmId, totalPowerKw, averageWindSpeedMs) {
  if (!client) return;
  const patch = [
    { op: "replace", path: "/totalPowerKw", value: totalPowerKw },
    { op: "replace", path: "/averageWindSpeedMs", value: averageWindSpeedMs }
  ];
  await client.updateDigitalTwin(farmId, patch);
}

/**
 * Patch the per-sensor twin that corresponds to a telemetry reading.
 * sensorKind matches the "kind" property seeded in seed-twins.mjs:
 *   "WindSpeed" | "Vibration" | "Temperature" | "Power"
 */
export async function patchSensor(client, turbineId, sensorKind, value) {
  if (!client) return;
  const sensorId = `${turbineId}_Sensor_${sensorKind}`;
  const patch = [
    { op: "replace", path: "/value", value },
    { op: "replace", path: "/online", value: true }
  ];
  await client.updateDigitalTwin(sensorId, patch);
}
