# Wind Farm Digital Twin Lab

This repository implements a lab-scale wind farm digital twin using Azure Digital Twins (ADT) for the twin graph and `realvirtual-WEB` as the browser UI.

## Lab Scope

- 1 wind farm
- 1 turbine
- Sensor set per turbine: wind speed, vibration, nacelle temperature, rotor RPM, generated power, alarm state

## Repository Layout

- `infra/` Azure deployment templates and deploy script
- `models/` DTDL models for the wind farm twin graph
- `seed/` Twin graph and relationship seeding scripts
- `simulator/` Telemetry simulator that emits wind farm signals
- `backend/` API + ADT updater + realtime stream gateway
- `web-ui/` Integration artifacts for `realvirtual-WEB` plugin
- `demo/` Scenario scripts and presenter runbook
- `docs/` Architecture and operations notes

## Quick Start

1. Install prerequisites:
   - Azure CLI
   - Node.js 20+
2. Copy `.env.example` files in `backend/` and `simulator/` to `.env`.
3. Deploy infra from `infra/`.
4. Upload models from `models/` and seed graph using `seed/`.
5. Start services:
   - `backend`
   - `simulator`
6. Integrate `web-ui/realvirtual-plugins/windfarm-plugin.ts` in your `realvirtual-WEB` app.
