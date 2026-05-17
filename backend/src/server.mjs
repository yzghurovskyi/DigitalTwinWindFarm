import "dotenv/config";
import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import { createAdtClient, patchFarm, patchTurbine, patchSensor } from "./adt-client.mjs";
import { KpiService } from "./kpi-service.mjs";
import { FARM_ID, TURBINE_IDS } from "./config.mjs";

const app = express();
const port = Number(process.env.PORT || 8080);
const adtClient = createAdtClient(process.env.ADT_URL);

if (!process.env.ADT_URL) {
  console.warn("[WARN] ADT_URL is not set — twin graph writes are disabled. Copy backend/.env.example to .env.");
}

const kpiService = new KpiService();

// ── Per-turbine control state ─────────────────────────────────────────────
// running:     true = turbine operating, false = stopped by operator command
// resourcePct: 0–100, represents cumulative equipment wear/efficiency.
//              Decreases by RESOURCE_DECAY_PCT_PER_TICK every ingest tick
//              while the turbine is running; pauses when stopped.
const RESOURCE_DECAY_PCT_PER_TICK = 0.1; // ~0.067 %/s at 1.5 s/tick → drained in ~25 min

const turbineControl = new Map(
  TURBINE_IDS.map((id) => [id, { running: true, resourcePct: 100 }])
);

app.use(cors());
app.use(express.json());

const alerts = [];

function pushAlert(message) {
  const alert = {
    id: `${Date.now()}-${message.turbineId}`,
    turbineId: message.turbineId,
    timestamp: new Date().toISOString(),
    level: "warning",
    message: message.status
  };
  alerts.unshift(alert);
  if (alerts.length > 100) alerts.pop();
}

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: "/stream" });

function broadcast(event) {
  const payload = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(payload);
  }
}

// ── Pre-load ADT state on startup ────────────────────────────────────────
// Restores KPI state so the server is correct immediately after a restart,
// rather than showing zeroes until every turbine re-reports.
if (adtClient) {
  (async () => {
    try {
      const sql = `SELECT * FROM DIGITALTWINS T WHERE IS_OF_MODEL(T, 'dtmi:windfarm:Turbine;1')`;
      const twins = [];
      for await (const item of adtClient.queryTwins(sql)) twins.push(item);
      kpiService.loadFromAdt(twins);
      console.log(`[startup] Loaded ${twins.length} turbine twins from ADT.`);
    } catch (err) {
      console.warn("[startup] Could not pre-load ADT state:", err.message);
    }
  })();
}

// ── Ingest endpoint (called by simulator or IoT Hub processor function) ──
app.post("/ingest", async (req, res) => {
  const message = req.body;
  const required = ["turbineId", "windSpeedMs", "vibrationMmS", "nacelleTempC", "rotorRpm", "powerKw", "alarmActive", "status"];
  for (const key of required) {
    if (message[key] === undefined) return res.status(400).json({ error: `Missing ${key}` });
  }

  // ── Apply operator control state ──────────────────────────────────────
  // Get or create control entry (handles turbines added after startup).
  if (!turbineControl.has(message.turbineId)) {
    turbineControl.set(message.turbineId, { running: true, resourcePct: 100 });
  }
  const ctrl = turbineControl.get(message.turbineId);

  if (!ctrl.running) {
    // Turbine stopped: zero out all outputs; resource does not drain.
    message.powerKw  = 0;
    message.rotorRpm = 0;
    message.status   = "Stopped";
    message.alarmActive = false;
  } else {
    // Turbine running: decay resource and scale power & RPM accordingly.
    ctrl.resourcePct = Math.max(0, ctrl.resourcePct - RESOURCE_DECAY_PCT_PER_TICK);
    const factor = ctrl.resourcePct / 100;
    message.powerKw  = Number((message.powerKw  * factor).toFixed(2));
    message.rotorRpm = Number((message.rotorRpm * factor).toFixed(2));
    if (ctrl.resourcePct < 30) {
      // Critical: auto-stop turbine to prevent further damage.
      ctrl.running = false;
      message.powerKw  = 0;
      message.rotorRpm = 0;
      message.alarmActive = true;
      message.status = "CRITICAL: auto-stopped (resource below 30%)";
      console.log(`[auto-stop] ${message.turbineId} automatically stopped — resource at ${ctrl.resourcePct.toFixed(1)}%`);
      broadcast({ type: "control", payload: { turbineId: message.turbineId, running: false, resourcePct: ctrl.resourcePct } });
    } else if (ctrl.resourcePct < 70 && !message.alarmActive) {
      message.alarmActive = true;
      message.status = "WARNING: resource below 70%";
    }
  }

  // Attach control state so the frontend can display it without a separate poll.
  message.resourcePct = Number(ctrl.resourcePct.toFixed(2));
  message.running     = ctrl.running;

  const kpis = kpiService.update(message);
  if (message.alarmActive) pushAlert(message);

  // Patch ADT with try/catch so a transient ADT error does not kill the request
  try {
    await patchTurbine(adtClient, message.turbineId, message);
    await patchFarm(adtClient, FARM_ID, kpis.totalPowerKw, kpis.averageWindSpeedMs);

    // Keep per-sensor twins in sync
    await Promise.allSettled([
      patchSensor(adtClient, message.turbineId, "WindSpeed", message.windSpeedMs),
      patchSensor(adtClient, message.turbineId, "Vibration", message.vibrationMmS),
      patchSensor(adtClient, message.turbineId, "Temperature", message.nacelleTempC),
      patchSensor(adtClient, message.turbineId, "Power", message.powerKw)
    ]);
  } catch (err) {
    console.error("[ADT] Patch failed:", err.message);
  }

  broadcast({ type: "telemetry", payload: message });
  broadcast({ type: "kpi", payload: kpis });
  if (message.alarmActive) broadcast({ type: "alert", payload: alerts[0] });

  res.json({ ok: true });
});

app.get("/api/state", (_req, res) => {
  res.json({
    farmId: FARM_ID,
    turbines: kpiService.listTurbines(),
    alerts: alerts.slice(0, 10)
  });
});

app.post("/api/control/acknowledge", (req, res) => {
  const turbineId = req.body.turbineId;
  if (!turbineId) return res.status(400).json({ error: "Missing turbineId" });
  const alert = {
    id: `${Date.now()}-${turbineId}-ack`,
    turbineId,
    timestamp: new Date().toISOString(),
    level: "info",
    message: "Operator acknowledged alarm"
  };
  alerts.unshift(alert);
  broadcast({ type: "alert", payload: alert });
  res.json({ ok: true });
});

// ── Turbine start / stop control ──────────────────────────────────────────
app.post("/api/control/turbine", (req, res) => {
  const { turbineId, running } = req.body;
  if (!turbineId || typeof running !== "boolean") {
    return res.status(400).json({ error: "Body must contain turbineId (string) and running (boolean)" });
  }
  if (!TURBINE_IDS.includes(turbineId) && !turbineControl.has(turbineId)) {
    return res.status(404).json({ error: `Unknown turbineId: ${turbineId}` });
  }
  if (!turbineControl.has(turbineId)) {
    turbineControl.set(turbineId, { running: true, resourcePct: 100 });
  }
  const ctrl = turbineControl.get(turbineId);
  ctrl.running = running;
  console.log(`[control] ${turbineId} → ${running ? "START" : "STOP"} (resource: ${ctrl.resourcePct.toFixed(1)}%)`);
  // Immediately notify all WebSocket clients so the UI updates without waiting
  // for the next telemetry tick.
  broadcast({ type: "control", payload: { turbineId, running: ctrl.running, resourcePct: ctrl.resourcePct } });
  res.json({ ok: true, turbineId, running: ctrl.running, resourcePct: ctrl.resourcePct });
});

// ── Turbine damage (bird strike, etc.) ────────────────────────────────────
app.post("/api/control/damage", (req, res) => {
  const { turbineId, damagePct } = req.body;
  if (!turbineId || typeof damagePct !== "number" || damagePct <= 0) {
    return res.status(400).json({ error: "Body must contain turbineId (string) and damagePct (number > 0)" });
  }
  if (!turbineControl.has(turbineId)) {
    turbineControl.set(turbineId, { running: true, resourcePct: 100 });
  }
  const ctrl = turbineControl.get(turbineId);
  const prevPct = ctrl.resourcePct;
  ctrl.resourcePct = Math.max(0, ctrl.resourcePct - damagePct);
  console.log(`[damage] ${turbineId} damaged by ${damagePct}% → resource now ${ctrl.resourcePct.toFixed(1)}%`);
  // Auto-stop if resource dropped below 30%.
  if (ctrl.resourcePct < 30 && ctrl.running) {
    ctrl.running = false;
    console.log(`[auto-stop] ${turbineId} automatically stopped after damage — resource at ${ctrl.resourcePct.toFixed(1)}%`);
    pushAlert({ turbineId, status: `CRITICAL: auto-stopped after damage — resource at ${ctrl.resourcePct.toFixed(1)}% (was ${prevPct.toFixed(1)}%)` });
  } else if (ctrl.resourcePct < 70) {
    // Below 70% warning threshold.
    pushAlert({ turbineId, status: `Damage event: resource dropped to ${ctrl.resourcePct.toFixed(1)}% (−${damagePct}%, was ${prevPct.toFixed(1)}%)` });
  }
  if (ctrl.resourcePct < 70) broadcast({ type: "alert", payload: alerts[0] });
  broadcast({ type: "control", payload: { turbineId, running: ctrl.running, resourcePct: ctrl.resourcePct } });
  res.json({ ok: true, turbineId, running: ctrl.running, resourcePct: ctrl.resourcePct });
});

// ── Turbine repair ────────────────────────────────────────────────────────
app.post("/api/control/repair", (req, res) => {
  const { turbineId, repairPct } = req.body;
  if (!turbineId || typeof repairPct !== "number" || repairPct <= 0) {
    return res.status(400).json({ error: "Body must contain turbineId (string) and repairPct (number > 0)" });
  }
  if (!turbineControl.has(turbineId)) {
    turbineControl.set(turbineId, { running: false, resourcePct: 0 });
  }
  const ctrl = turbineControl.get(turbineId);
  const prevPct = ctrl.resourcePct;
  ctrl.resourcePct = Math.min(100, ctrl.resourcePct + repairPct);
  console.log(`[repair] ${turbineId} repaired by ${repairPct}% → resource now ${ctrl.resourcePct.toFixed(1)}%`);
  const alert = {
    id: `${Date.now()}-${turbineId}-repair`,
    turbineId,
    timestamp: new Date().toISOString(),
    level: "info",
    message: `Repair event: resource restored to ${ctrl.resourcePct.toFixed(1)}% (+${repairPct}%, was ${prevPct.toFixed(1)}%)`
  };
  alerts.unshift(alert);
  if (alerts.length > 100) alerts.pop();
  broadcast({ type: "alert", payload: alert });
  broadcast({ type: "control", payload: { turbineId, running: ctrl.running, resourcePct: ctrl.resourcePct } });
  res.json({ ok: true, turbineId, running: ctrl.running, resourcePct: ctrl.resourcePct });
});

wss.on("connection", (socket) => {
  // Send bootstrap with current control state per turbine embedded
  const turbines = kpiService.listTurbines().map((t) => {
    const ctrl = turbineControl.get(t.turbineId);
    return ctrl ? { ...t, resourcePct: ctrl.resourcePct, running: ctrl.running } : t;
  });
  socket.send(
    JSON.stringify({
      type: "bootstrap",
      payload: { turbines, alerts: alerts.slice(0, 10) }
    })
  );
});

httpServer.listen(port, () => {
  console.log(`Backend listening on http://localhost:${port}`);
  console.log(`Tracking turbines: ${TURBINE_IDS.join(", ")}`);
});
