import { TURBINE_IDS } from "./config.mjs";

export class KpiService {
  state = new Map();

  update(message) {
    this.state.set(message.turbineId, message);
    return this._compute();
  }

  /**
   * Pre-load state from an array of turbine objects retrieved from ADT
   * so that KPIs are correct immediately after a backend restart.
   */
  loadFromAdt(turbines) {
    for (const t of turbines) {
      if (t.$dtId) this.state.set(t.$dtId, {
        turbineId: t.$dtId,
        windSpeedMs: t.windSpeedMs ?? 0,
        vibrationMmS: t.vibrationMmS ?? 0,
        nacelleTempC: t.nacelleTempC ?? 0,
        rotorRpm: t.rotorRpm ?? 0,
        powerKw: t.powerKw ?? 0,
        alarmActive: t.alarmActive ?? false,
        status: t.status ?? "Unknown"
      });
    }
  }

  _compute() {
    // Only include turbines that have reported; use 0 for unreported ones so
    // the farm KPI reflects the full turbine count from the start.
    const rows = TURBINE_IDS.map((id) => this.state.get(id) ?? null);
    const reported = rows.filter(Boolean);
    if (!reported.length) {
      return { totalPowerKw: 0, averageWindSpeedMs: 0, activeAlarms: 0 };
    }
    const totalPowerKw = reported.reduce((sum, x) => sum + x.powerKw, 0);
    // Average over ALL turbines, treating unreported ones as 0 wind speed
    const averageWindSpeedMs = reported.reduce((sum, x) => sum + x.windSpeedMs, 0) / TURBINE_IDS.length;
    const activeAlarms = reported.filter((x) => x.alarmActive).length;
    return {
      totalPowerKw: Number(totalPowerKw.toFixed(2)),
      averageWindSpeedMs: Number(averageWindSpeedMs.toFixed(2)),
      activeAlarms
    };
  }

  listTurbines() {
    return TURBINE_IDS.map((id) => this.state.get(id)).filter(Boolean);
  }
}
