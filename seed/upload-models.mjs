import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DigitalTwinsClient } from "@azure/digital-twins-core";
import { DefaultAzureCredential } from "@azure/identity";
import "dotenv/config";

const adtUrl = process.env.ADT_URL;
if (!adtUrl) throw new Error("Missing ADT_URL");

const client = new DigitalTwinsClient(adtUrl, new DefaultAzureCredential());
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const replace = process.argv.includes("--replace");

const files = [
  "../models/WindFarm.json",
  "../models/Turbine.json",
  "../models/Sensor.json",
  "../models/Nacelle.json",
  "../models/BladeSet.json"
];

const models = [];
for (const relativePath of files) {
  const content = await readFile(join(__dirname, relativePath), "utf8");
  models.push(JSON.parse(content));
}

if (replace) {
  console.log("--replace: deleting existing models...");
  // Collect existing model IDs from the instance
  const existing = [];
  for await (const m of client.listModels()) {
    existing.push(m.id);
  }

  if (existing.length === 0) {
    console.log("No models found to delete.");
  } else {
    // Try multiple deletion passes to handle dependency ordering automatically
    let remaining = [...existing];
    let lastCount = -1;
    while (remaining.length > 0 && remaining.length !== lastCount) {
      lastCount = remaining.length;
      const nextRound = [];
      for (const id of remaining) {
        try {
          await client.deleteModel(id);
          console.log(`  Deleted model: ${id}`);
        } catch (err) {
          if (err.statusCode === 409) {
            // Still referenced by another model — retry next pass
            nextRound.push(id);
          } else if (err.code === "ModelReferencedByTwin" || err.statusCode === 400) {
            console.error(`\nCannot delete ${id}: twins are still using it.`);
            console.error("Delete all twins first with:  node seed-twins.mjs --delete\n");
            process.exit(1);
          } else {
            throw err;
          }
        }
      }
      remaining = nextRound;
    }
    if (remaining.length > 0) {
      console.error("Could not delete these models (unresolvable dependencies):", remaining);
      process.exit(1);
    }
  }
  console.log("All existing models deleted.");
}

try {
  await client.createModels(models);
  console.log("Models uploaded.");
} catch (err) {
  if (err.code === "ModelIdAlreadyExists" || err.statusCode === 409) {
    console.log("Models already exist in ADT — skipping upload. Use --replace to force re-upload.");
  } else {
    throw err;
  }
}
