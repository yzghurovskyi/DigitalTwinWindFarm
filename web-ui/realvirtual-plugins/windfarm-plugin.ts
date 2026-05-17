/* eslint-disable @typescript-eslint/no-explicit-any */
export class WindFarmPlugin {
  id = "windfarm-plugin";
  private ws?: WebSocket;
  private backendUrl: string;
  private mapping: Record<string, string>;
  private viewer: any;
  private latestKpi = { totalPowerKw: 0, averageWindSpeedMs: 0, activeAlarms: 0 };

  constructor(options?: { backendUrl?: string; mapping?: Record<string, string> }) {
    this.backendUrl = options?.backendUrl ?? "http://localhost:8080";
    this.mapping = options?.mapping ?? {
      Turbine_01: "Turbine_01"
    };
  }

  install(viewer: any) {
    this.viewer = viewer;
    this.connect();

    viewer.on?.("object-clicked", (object: any) => {
      const objectName = object?.name;
      const twinId = this.mapping[objectName];
      if (!twinId) return;
      viewer.emit?.("message", {
        level: "info",
        text: `Selected ${twinId}. Use details panel for trends and alarms.`
      });
    });
  }

  uninstall() {
    this.ws?.close();
  }

  private connect() {
    const streamUrl = this.backendUrl.replace("http", "ws") + "/stream";
    this.ws = new WebSocket(streamUrl);

    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "telemetry") this.handleTelemetry(message.payload);
      if (message.type === "kpi") this.handleKpi(message.payload);
      if (message.type === "alert") this.handleAlert(message.payload);
    };

    this.ws.onclose = () => {
      setTimeout(() => this.connect(), 2000);
    };
  }

  private handleTelemetry(payload: any) {
    const objectName = Object.keys(this.mapping).find((key) => this.mapping[key] === payload.turbineId);
    if (!objectName) return;
    const object = this.viewer?.scene?.getObjectByName?.(objectName);
    if (!object) return;

    if (object.material) {
      const isAlarm = Boolean(payload.alarmActive);
      object.material.color.setHex(isAlarm ? 0xff4d4f : 0x2dc937);
    }

    this.viewer.emit?.("tooltip-update", {
      target: objectName,
      data: {
        turbineId: payload.turbineId,
        windSpeedMs: payload.windSpeedMs,
        powerKw: payload.powerKw,
        vibrationMmS: payload.vibrationMmS,
        nacelleTempC: payload.nacelleTempC,
        status: payload.status
      }
    });
  }

  private handleKpi(payload: any) {
    this.latestKpi = payload;
    this.viewer.emit?.("kpi-update", {
      cards: [
        { id: "farm-power", label: "Farm Power", value: `${payload.totalPowerKw} kW` },
        { id: "avg-wind", label: "Avg Wind", value: `${payload.averageWindSpeedMs} m/s` },
        { id: "alarms", label: "Active Alarms", value: String(payload.activeAlarms) }
      ]
    });
  }

  private handleAlert(payload: any) {
    this.viewer.emit?.("message", {
      level: payload.level === "info" ? "info" : "warning",
      text: `${payload.turbineId}: ${payload.message}`
    });
  }
}
