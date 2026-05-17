// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WindFarmKpiCards — KPI bar slot components for the Wind Farm Digital Twin.
 *
 * Reads live data from WindFarmStore (updated by WindFarmPlugin) and renders
 * four KPI cards into the kpi-bar slot:
 *   • Farm Power (kW)
 *   • Avg Wind Speed (m/s)
 *   • Active Alarms
 *   • Wind Direction (compass rose + degrees)
 */

import { useSyncExternalStore } from 'react';
import { Box, Paper, Typography } from '@mui/material';
import { KpiCard } from '../core/hmi/KpiCard';
import type { UISlotProps } from '../../core/rv-ui-plugin';
import { windFarmStore } from './windfarm-store';

export function WindFarmPowerKpi(_props: UISlotProps) {
  const kpi = useSyncExternalStore(windFarmStore.subscribe, windFarmStore.getKpi);
  const sparkline = useSyncExternalStore(windFarmStore.subscribe, windFarmStore.getPowerHistory) as number[];
  return (
    <KpiCard
      label="Farm Power"
      value={kpi.totalPowerKw.toFixed(0)}
      unit="kW"
      color="#4fc3f7"
      secondary="3 turbines"
      sparkline={sparkline}
      animate={false}
    />
  );
}

export function WindFarmWindKpi(_props: UISlotProps) {
  const kpi = useSyncExternalStore(windFarmStore.subscribe, windFarmStore.getKpi);
  const sparkline = useSyncExternalStore(windFarmStore.subscribe, windFarmStore.getWindHistory) as number[];
  return (
    <KpiCard
      label="Avg Wind"
      value={kpi.averageWindSpeedMs.toFixed(1)}
      unit="m/s"
      color="#66bb6a"
      sparkline={sparkline}
      animate={false}
    />
  );
}

export function WindFarmAlarmKpi(_props: UISlotProps) {
  const kpi = useSyncExternalStore(windFarmStore.subscribe, windFarmStore.getKpi);
  const hasAlarms = kpi.activeAlarms > 0;
  return (
    <KpiCard
      label="Active Alarms"
      value={String(kpi.activeAlarms)}
      unit=""
      color={hasAlarms ? '#ef5350' : '#66bb6a'}
      secondary={hasAlarms ? 'Check turbines' : 'All clear'}
      animate={false}
    />
  );
}

// ── Compass rose helpers ────────────────────────────────────────────────────

const COMPASS_LABELS = ['N', 'E', 'S', 'W'];

function compassLabel(deg: number): string {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(deg / 45) % 8];
}

function CompassRose({ deg }: { deg: number }) {
  const R = 22;   // outer ring radius
  const cx = 30;
  const cy = 30;
  // The arrow shows wind direction (where wind comes FROM).
  // rotate() is clockwise in SVG, matching meteorological convention.
  const arrowAngle = deg;
  return (
    <svg width={60} height={60} viewBox="0 0 60 60" style={{ display: 'block' }}>
      {/* Outer ring */}
      <circle cx={cx} cy={cy} r={R} fill="none" stroke="#444" strokeWidth={1.5} />
      {/* Cardinal tick marks */}
      {COMPASS_LABELS.map((_, i) => {
        const a = (i * 90 - 90) * Math.PI / 180;
        const x1 = cx + (R - 4) * Math.cos(a);
        const y1 = cy + (R - 4) * Math.sin(a);
        const x2 = cx + R * Math.cos(a);
        const y2 = cy + R * Math.sin(a);
        return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#888" strokeWidth={1.5} />;
      })}
      {/* Cardinal labels */}
      {COMPASS_LABELS.map((label, i) => {
        const a = (i * 90 - 90) * Math.PI / 180;
        const x = cx + (R + 7) * Math.cos(a);
        const y = cy + (R + 7) * Math.sin(a) + 4;
        return (
          <text key={label} x={x} y={y} textAnchor="middle" fontSize={7}
            fill="#aaa" fontFamily="sans-serif">{label}</text>
        );
      })}
      {/* Wind direction arrow — rotates clockwise from North */}
      <g transform={`rotate(${arrowAngle}, ${cx}, ${cy})`}>
        {/* Arrow shaft pointing FROM wind source (downward = wind comes from that direction) */}
        <line x1={cx} y1={cy - 14} x2={cx} y2={cy + 10}
          stroke="#00bfff" strokeWidth={2} strokeLinecap="round" />
        {/* Arrowhead */}
        <polygon
          points={`${cx},${cy - 18} ${cx - 4},${cy - 10} ${cx + 4},${cy - 10}`}
          fill="#00bfff"
        />
        {/* Tail feathers */}
        <line x1={cx - 4} y1={cy + 8} x2={cx} y2={cy + 14} stroke="#00bfff" strokeWidth={1.5} />
        <line x1={cx + 4} y1={cy + 8} x2={cx} y2={cy + 14} stroke="#00bfff" strokeWidth={1.5} />
      </g>
      {/* Center dot */}
      <circle cx={cx} cy={cy} r={2.5} fill="#00bfff" />
    </svg>
  );
}

export function WindFarmDirectionKpi(_props: UISlotProps) {
  const deg     = useSyncExternalStore(windFarmStore.subscribe, windFarmStore.getWindDirectionDeg);
  const speedMs = useSyncExternalStore(windFarmStore.subscribe, () => windFarmStore.getKpi().averageWindSpeedMs);

  return (
    <Paper
      elevation={2}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        px: 1.5,
        py: 0.75,
        bgcolor: 'rgba(255,255,255,0.04)',
        borderRadius: 2,
        minWidth: 90,
        gap: 0.25,
      }}
    >
      <Typography variant="caption" sx={{ color: '#aaa', fontSize: '0.65rem', lineHeight: 1, mb: 0.25 }}>
        Wind Direction
      </Typography>
      <CompassRose deg={deg} />
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.5, mt: 0.25 }}>
        <Typography variant="body2" sx={{ fontWeight: 700, color: '#00bfff', fontSize: '0.95rem' }}>
          {deg.toFixed(0)}°
        </Typography>
        <Typography variant="caption" sx={{ color: '#aaa', fontSize: '0.65rem' }}>
          {compassLabel(deg)}
        </Typography>
      </Box>
      <Typography variant="caption" sx={{ color: '#66bb6a', fontSize: '0.7rem' }}>
        {speedMs.toFixed(1)} m/s
      </Typography>
    </Paper>
  );
}

/**
 * Yaw Capacity KPI card — shows the cos²(yaw_error) efficiency as a percentage.
 * 100 % = nacelle perfectly aligned with wind, 0 % = perpendicular (no power).
 * The colour transitions from green → amber → red as alignment degrades.
 */
export function WindFarmYawKpi(_props: UISlotProps) {
  const pct = useSyncExternalStore(windFarmStore.subscribe, windFarmStore.getYawCapacityPct);
  const capPct = Math.round(pct * 100);
  const color = capPct >= 80 ? '#66bb6a' : capPct >= 40 ? '#ffa726' : '#ef5350';
  return (
    <KpiCard
      label="Yaw Capacity"
      value={String(capPct)}
      unit="%"
      color={color}
      secondary={capPct >= 80 ? 'Aligned' : capPct >= 40 ? 'Yawing…' : 'Misaligned'}
      animate={false}
    />
  );
}

/**
 * Resource KPI card — shows the remaining equipment resource percentage.
 * Decreases while the turbine is running; colour transitions green → amber → red.
 */
export function WindFarmResourceKpi(_props: UISlotProps) {
  const t = useSyncExternalStore(windFarmStore.subscribe, windFarmStore.getTurbineStatus);
  const pct = t?.resourcePct ?? 100;
  const running = t?.running !== false;
  const rounded = Math.round(pct);
  const color = pct >= 60 ? '#66bb6a' : pct >= 25 ? '#ffa726' : '#ef5350';
  const secondary = !running ? 'Stopped' : pct >= 60 ? 'Good' : pct >= 25 ? 'Degraded' : 'Critical';
  return (
    <KpiCard
      label="Resource"
      value={String(rounded)}
      unit="%"
      color={color}
      secondary={secondary}
      animate={false}
    />
  );
}
