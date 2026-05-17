// SPDX-License-Identifier: AGPL-3.0-only

/**
 * windFarmStore — Lightweight external store shared between WindFarmPlugin
 * and the WindFarm React slot components.
 *
 * Uses the React useSyncExternalStore pattern: no Zustand dependency.
 * Plugin writes; React components read.
 */

const MAX_HISTORY = 30;

type KpiState = {
  totalPowerKw: number;
  averageWindSpeedMs: number;
  activeAlarms: number;
};

export type TurbineStatus = {
  turbineId: string;
  powerKw: number;
  windSpeedMs: number;
  windDirectionDeg?: number;
  rotorRpm: number;
  vibrationMmS: number;
  nacelleTempC: number;
  alarmActive: boolean;
  status: string;
  timestamp: string;
  /** 0–100 % equipment resource remaining. Decreases while turbine runs. */
  resourcePct?: number;
  /** False when the operator has stopped the turbine via the control panel. */
  running?: boolean;
};

function createWindFarmStore() {
  let kpi: KpiState = { totalPowerKw: 0, averageWindSpeedMs: 0, activeAlarms: 0 };
  let turbineStatus: TurbineStatus | null = null;
  /**
   * Registered by WindFarmPlugin so React components can send start/stop
   * commands without knowing the backend URL.
   */
  let _controlFn: ((turbineId: string, running: boolean) => Promise<void>) | null = null;
  /** Display value — set by the plugin's onRender using its currentYawRad,
   *  so the widget is always in sync with the 3D arrow. */
  let windDirectionDeg = 0;
  /**
   * Yaw alignment efficiency: 1.0 = nacelle perfectly facing wind (100% capacity),
   * 0.0 = nacelle perpendicular to wind (0% capacity).
   * Formula: cos²(yaw_error), matches the physics used for blade RPM scaling.
   * Updated every render frame by WindFarmPlugin.onRender().
   */
  let yawCapacityPct = 1;
  const powerHistory: number[] = [];
  const windHistory: number[] = [];
  const listeners = new Set<() => void>();

  function notify() {
    for (const l of listeners) l();
  }

  return {
    setKpi(next: KpiState) {
      kpi = next;
      powerHistory.push(next.totalPowerKw);
      windHistory.push(next.averageWindSpeedMs);
      if (powerHistory.length > MAX_HISTORY) powerHistory.shift();
      if (windHistory.length > MAX_HISTORY) windHistory.shift();
      notify();
    },
    setTurbineStatus(next: TurbineStatus) {
      turbineStatus = next;
      notify();
    },
    /** Called by WindFarmPlugin.onRender with the current interpolated display angle.
     *  Only triggers a React re-render when the rounded degree value actually changes. */
    setDisplayWindDirDeg(deg: number) {
      const rounded = Math.round(((deg % 360) + 360) % 360);
      if (rounded !== Math.round(windDirectionDeg)) {
        windDirectionDeg = rounded;
        notify();
      }
    },
    /**
     * Called by WindFarmPlugin.onRender with the cos²(yaw_error) efficiency value.
     * 1.0 = nacelle aligned with wind (100 % capacity).
     * 0.0 = nacelle perpendicular to wind (0 % capacity).
     * Only notifies listeners when the value changes by more than 0.5 %.
     */
    setYawCapacityPct(pct: number) {
      if (Math.abs(pct - yawCapacityPct) > 0.005) {
        yawCapacityPct = pct;
        notify();
      }
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getKpi() {
      return kpi;
    },
    getTurbineStatus() {
      return turbineStatus;
    },
    getWindDirectionDeg() {
      return windDirectionDeg;
    },
    getYawCapacityPct() {
      return yawCapacityPct;
    },
    getPowerHistory() {
      return powerHistory as readonly number[];
    },
    getWindHistory() {
      return windHistory as readonly number[];
    },
    /** Plugin registers its send-command function here on model load. */
    setControlFn(fn: ((turbineId: string, running: boolean) => Promise<void>) | null) {
      _controlFn = fn;
    },
    /**
     * Called by UI components to start or stop a turbine.
     * Delegates to the registered control function (set by WindFarmPlugin).
     * No-op when no backend connection is available (demo mode).
     */
    async controlTurbine(turbineId: string, running: boolean): Promise<void> {
      await _controlFn?.(turbineId, running);
    }
  };
}

export const windFarmStore = createWindFarmStore();
