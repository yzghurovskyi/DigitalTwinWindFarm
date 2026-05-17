import { DigitalTwinsClient } from "@azure/digital-twins-core";
import { DefaultAzureCredential } from "@azure/identity";
import "dotenv/config";

const adtUrl = process.env.ADT_URL;
if (!adtUrl) throw new Error("Missing ADT_URL");

const client = new DigitalTwinsClient(adtUrl, new DefaultAzureCredential());

const queries = [
  {
    name: "Turbines above vibration threshold",
    sql: "SELECT T.$dtId, T.vibrationMmS FROM DIGITALTWINS T WHERE IS_OF_MODEL(T, 'dtmi:windfarm:Turbine;1') AND T.vibrationMmS > 4.0"
  },
  {
    name: "Farm total power",
    sql: "SELECT F.$dtId, F.totalPowerKw FROM DIGITALTWINS F WHERE IS_OF_MODEL(F, 'dtmi:windfarm:WindFarm;1')"
  },
  {
    name: "Offline sensors",
    sql: "SELECT S.$dtId, S.kind FROM DIGITALTWINS S WHERE IS_OF_MODEL(S, 'dtmi:windfarm:Sensor;1') AND S.online = false"
  }
];

for (const q of queries) {
  console.log(`\n=== ${q.name} ===`);
  const rows = [];
  for await (const item of client.queryTwins(q.sql)) rows.push(item);
  console.log(JSON.stringify(rows, null, 2));
}
