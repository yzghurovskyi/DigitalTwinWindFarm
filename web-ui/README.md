# realvirtual-WEB Integration

This folder contains the plugin implementation that links `realvirtual-WEB` to the lab backend.

## Steps

1. Clone and run `realvirtual-WEB` locally.
2. Copy files from `realvirtual-plugins/` into your `realvirtual-WEB/src/plugins/models/WindFarmLab/`.
3. Register plugin on model load (`WindFarmLab.glb` or your selected file name).
4. Ensure GLB object name matches:
   - `Turbine_01`
5. Start backend and simulator services.
6. Open `realvirtual-WEB` and load the wind farm model.

## What the Plugin Does

- Subscribes to websocket stream from backend.
- Colors turbines green/red based on alarm state.
- Updates tooltip details from latest telemetry.
- Pushes KPI cards (farm power, wind, active alarms).
- Shows incoming alerts in message panel.
