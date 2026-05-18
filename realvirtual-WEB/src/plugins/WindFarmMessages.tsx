// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WindFarmMessages — messages slot component for the Wind Farm Digital Twin.
 *
 * Renders three TileCards in the right message panel:
 *   1. Live turbine status (power, wind, RPM) — always visible once data arrives
 *   2. Resource bar — equipment resource % with colour-coded health indicator
 *   3. Alarm tile — only when alarmActive is true
 */

import { useSyncExternalStore, useCallback, useState } from 'react';
import { Box, Typography, Button, CircularProgress } from '@mui/material';
import { TileCard } from '../core/hmi/TileCard';
import type { UISlotProps } from '../core/rv-ui-plugin';
import { windFarmStore } from './windfarm-store';

export function WindFarmStatusMessage(_props: UISlotProps) {
  const t = useSyncExternalStore(windFarmStore.subscribe, windFarmStore.getTurbineStatus);
  const yawPct = useSyncExternalStore(windFarmStore.subscribe, windFarmStore.getYawCapacityPct);
  if (!t) return null;
  const dirStr = t.windDirectionDeg !== undefined
    ? ` · ${t.windDirectionDeg.toFixed(0)}°`
    : '';
  return (
    <TileCard
      title={t.turbineId}
      subtitle={`${t.powerKw.toFixed(0)} kW · ${t.windSpeedMs.toFixed(1)} m/s${dirStr} · ${t.rotorRpm.toFixed(0)} RPM · ${Math.round(yawPct * 100)}% yaw`}
      severity="info"
      icon="speed"
      timestamp="Live"
    />
  );
}

/** Resource health bar — green → amber → red as resource depletes. */
export function WindFarmResourcePanel(_props: UISlotProps) {
  const t = useSyncExternalStore(windFarmStore.subscribe, windFarmStore.getTurbineStatus);
  if (!t) return null;

  const pct = t.resourcePct ?? 100;
  const color = pct >= 60 ? '#66bb6a' : pct >= 25 ? '#ffa726' : '#ef5350';
  const label = pct >= 60 ? 'Good' : pct >= 25 ? 'Degraded' : 'Critical';

  return (
    <Box
      sx={{
        px: 1.5,
        py: 1,
        borderRadius: 2,
        bgcolor: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.08)',
      }}
    >
      <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
        <Typography variant="caption" sx={{ color: '#aaa', fontSize: '0.7rem' }}>
          Equipment Resource
        </Typography>
        <Typography variant="caption" sx={{ color, fontSize: '0.7rem', fontWeight: 700 }}>
          {pct.toFixed(1)}% — {label}
        </Typography>
      </Box>
      {/* Track */}
      <Box sx={{ height: 6, borderRadius: 3, bgcolor: 'rgba(255,255,255,0.1)', overflow: 'hidden' }}>
        {/* Fill */}
        <Box
          sx={{
            height: '100%',
            width: `${pct}%`,
            bgcolor: color,
            borderRadius: 3,
            transition: 'width 0.6s ease, background-color 0.4s ease',
          }}
        />
      </Box>
    </Box>
  );
}

/** Start / Stop control panel — sends commands to the backend via the store. */
export function WindFarmControlPanel(_props: UISlotProps) {
  const t = useSyncExternalStore(windFarmStore.subscribe, windFarmStore.getTurbineStatus);
  const [pending, setPending] = useState(false);

  const handleControl = useCallback(async (running: boolean) => {
    if (!t || pending) return;
    setPending(true);
    try {
      await windFarmStore.controlTurbine(t.turbineId, running);
    } finally {
      setPending(false);
    }
  }, [t, pending]);

  if (!t) return null;
  const isRunning = t.running !== false; // default true when field absent (demo mode)

  return (
    <Box
      sx={{
        px: 1.5,
        py: 1,
        borderRadius: 2,
        bgcolor: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.08)',
        display: 'flex',
        alignItems: 'center',
        gap: 1,
      }}
    >
      <Typography variant="caption" sx={{ color: '#aaa', fontSize: '0.7rem', flexGrow: 1 }}>
        {t.turbineId} — {isRunning ? 'Running' : 'Stopped'}
      </Typography>

      {pending && <CircularProgress size={14} sx={{ color: '#aaa' }} />}

      <Button
        size="small"
        variant={isRunning ? 'outlined' : 'contained'}
        color="success"
        disabled={isRunning || pending}
        onClick={() => handleControl(true)}
        sx={{ minWidth: 60, fontSize: '0.7rem', py: 0.25 }}
      >
        Start
      </Button>

      <Button
        size="small"
        variant={!isRunning ? 'outlined' : 'contained'}
        color="error"
        disabled={!isRunning || pending}
        onClick={() => handleControl(false)}
        sx={{ minWidth: 60, fontSize: '0.7rem', py: 0.25 }}
      >
        Stop
      </Button>
    </Box>
  );
}

export function WindFarmAlarmMessage(_props: UISlotProps) {
  const t = useSyncExternalStore(windFarmStore.subscribe, windFarmStore.getTurbineStatus);
  if (!t?.alarmActive) return null;
  return (
    <TileCard
      title={`${t.turbineId} — ALARM`}
      subtitle={t.status}
      severity="error"
      icon="warning"
      timestamp={new Date(t.timestamp).toLocaleTimeString()}
    />
  );
}
