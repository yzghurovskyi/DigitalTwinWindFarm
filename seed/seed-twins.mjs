import { DigitalTwinsClient } from "@azure/digital-twins-core";
import { DefaultAzureCredential } from "@azure/identity";
import "dotenv/config";

const adtUrl = process.env.ADT_URL;
if (!adtUrl) throw new Error("Missing ADT_URL");

const client = new DigitalTwinsClient(adtUrl, new DefaultAzureCredential());

const farmId = "WindFarm_01";
const turbineIds = ["Turbine_01"];

// ── --delete mode: wipe all twins and relationships ───────────────────────

if (process.argv.includes("--delete")) {
  console.log("--delete: removing all twins and relationships...");
  const allTwins = [];
  for await (const twin of client.queryTwins("SELECT * FROM digitaltwins")) {
    allTwins.push(twin.$dtId);
  }
  // Delete all relationships first
  for (const id of allTwins) {
    for await (const rel of client.listRelationships(id)) {
      await client.deleteRelationship(id, rel.$relationshipId);
    }
  }
  // Then delete all twins
  for (const id of allTwins) {
    await client.deleteDigitalTwin(id);
    console.log(`  Deleted twin: ${id}`);
  }
  console.log("All twins deleted.");
  process.exit(0);
}

async function upsertTwin(id, modelId, properties) {
  const twin = { $metadata: { $model: modelId }, ...properties };
  await client.upsertDigitalTwin(id, JSON.stringify(twin));
  console.log(`Upserted twin ${id}`);
}

async function upsertRel(sourceId, relId, relName, targetId) {
  await client.upsertRelationship(sourceId, relId, {
    $relationshipId: relId,
    $sourceId: sourceId,
    $relationshipName: relName,
    $targetId: targetId
  });
}

await upsertTwin(farmId, "dtmi:windfarm:WindFarm;1", {
  name: "Lab Wind Farm",
  location: "Campus Lab",
  totalPowerKw: 0,
  averageWindSpeedMs: 0,
  lastUpdated: new Date().toISOString()
});

for (const tId of turbineIds) {
  await upsertTwin(tId, "dtmi:windfarm:Turbine;1", {
    name: tId,
    status: "Running",
    windSpeedMs: 0,
    vibrationMmS: 0,
    nacelleTempC: 0,
    rotorRpm: 0,
    powerKw: 0,
    alarmActive: false,
    lastUpdated: new Date().toISOString()
  });

  await upsertRel(farmId, `${farmId}-contains-${tId}`, "contains", tId);
  await upsertRel(tId, `${tId}-locatedIn-${farmId}`, "locatedIn", farmId);

  // Sensors (aligned to DTDL Sensor model)
  const sensors = [
    ["WindSpeed", "m/s"],
    ["Vibration", "mm/s"],
    ["Temperature", "C"],
    ["Power", "kW"]
  ];

  for (const [kind, unit] of sensors) {
    const sensorId = `${tId}_Sensor_${kind}`;
    await upsertTwin(sensorId, "dtmi:windfarm:Sensor;1", {
      name: sensorId,
      kind,
      unit,
      value: 0,
      online: true
    });
    await upsertRel(tId, `${tId}-hasSensor-${sensorId}`, "hasSensor", sensorId);
  }

  // Nacelle twin (gearbox temp + yaw)
  const nacelleId = `${tId}_Nacelle`;
  await upsertTwin(nacelleId, "dtmi:windfarm:Nacelle;1", {
    gearboxTempC: 0,
    yawAngleDeg: 0,
    online: true
  });
  await upsertRel(tId, `${tId}-hasNacelle-${nacelleId}`, "hasNacelle", nacelleId);

  // BladeSet twin (pitch + health)
  const bladeSetId = `${tId}_BladeSet`;
  await upsertTwin(bladeSetId, "dtmi:windfarm:BladeSet;1", {
    pitchAngleDeg: 0,
    healthScore: 100
  });
  await upsertRel(tId, `${tId}-hasBladeSet-${bladeSetId}`, "hasBladeSet", bladeSetId);
}

console.log("Twin seed complete.");
