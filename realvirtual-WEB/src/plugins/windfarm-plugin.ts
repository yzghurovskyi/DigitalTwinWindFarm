// SPDX-License-Identifier: AGPL-3.0-only

import type { RVViewerPlugin } from '../core/rv-plugin';
import type { RVViewer } from '../core/rv-viewer';
import type { UISlotEntry } from '../core/rv-ui-plugin';
import type { LoadResult } from '../core/engine/rv-scene-loader';
import type { Material, Object3D } from 'three';
import { ArrowHelper, Box3, CanvasTexture, Quaternion, Sprite, SpriteMaterial, Vector3 } from 'three';
import { windFarmStore } from './windfarm-store';
import {
  WindFarmPowerKpi,
  WindFarmWindKpi,
  WindFarmAlarmKpi,
  WindFarmDirectionKpi,
  WindFarmYawKpi,
  WindFarmResourceKpi,
} from './WindFarmKpiCards';
import {
  WindFarmStatusMessage,
  WindFarmAlarmMessage,
  WindFarmResourcePanel,
  WindFarmControlPanel,
} from './WindFarmMessages';

type TelemetryPayload = {
  turbineId: string;
  windSpeedMs: number;
  windDirectionDeg?: number;
  /** Simulated nacelle yaw position (° CW from North). When present the
   *  simulator is the source-of-truth for nacelle orientation and the viewer
   *  just smoothly interpolates toward this value instead of wind direction. */
  nacelleAngleDeg?: number;
  /** cos²(yaw_error) pre-computed by the simulator. */
  yawCapacityPct?: number;
  vibrationMmS: number;
  nacelleTempC: number;
  rotorRpm: number;
  powerKw: number;
  alarmActive: boolean;
  status: string;
  timestamp: string;
  /** 0–100 % equipment resource remaining. Added by the backend. */
  resourcePct?: number;
  /** False when the operator has stopped this turbine. Added by the backend. */
  running?: boolean;
};

type KpiPayload = {
  totalPowerKw: number;
  averageWindSpeedMs: number;
  activeAlarms: number;
};

type AlertPayload = {
  level: 'info' | 'warning' | string;
  turbineId: string;
  message: string;
};

type ControlPayload = {
  turbineId: string;
  running: boolean;
  resourcePct: number;
};

type StreamEnvelope =
  | { type: 'telemetry'; payload: TelemetryPayload }
  | { type: 'kpi'; payload: KpiPayload }
  | { type: 'alert'; payload: AlertPayload }
  | { type: 'control'; payload: ControlPayload }
  | { type: 'bootstrap'; payload: unknown };

/** Maximum WebSocket reconnect delay in ms (30 s). */
const MAX_RECONNECT_MS = 30_000;

/** Track which THREE.js materials have already been cloned to avoid
 *  mutating shared material instances (common THREE.js pitfall). */
const clonedMaterials = new WeakSet<object>();

/** Reusable Quaternion / Vector3 to avoid per-frame allocations. */
const _spinQuat = new Quaternion();
/**
 * The Blades node's local Y axis points in the -Z direction in the GLB rest
 * pose (confirmed by inspecting the node quaternion [0.387,-0.592,0.592,-0.387]).
 * This is the rotor shaft axis.  Spinning around local Y (0,1,0) therefore
 * rotates the blades in the rotor disc plane — correct HAWT behaviour.
 * After nacelle yaw, the Blades node inherits the parent rotation so local Y
 * always stays aligned with the wind direction automatically.
 */
const _bladeSpinAxis = new Vector3(0, 1, 0);

/**
 * GLB inspection: the effective rotor shaft in the Three.js scene points along
 * +X (East) in the RootNode rest pose, because the FBX Z-up → Y-up correction
 * is baked into the Blades quaternion but shifts the shaft by +π/2.
 * Wind convention: yawRad = -(windDeg * π/180), nacelle.rotation.y = yawRad + offset.
 * For wind FROM North (yawRad=0): shaft must point (0,0,-1) = North.
 *   R_y(0 + offset) * (1,0,0) = (cos(offset), 0, -sin(offset)) = (0,0,-1)
 *   → offset = +π/2  (rotate CCW 90° from top to bring +X shaft to face North).
 */
const YAW_OFFSET_RAD = Math.PI / 2;

/**
 * Demo mode: blade spin RPM used before the first real telemetry frame arrives.
 * 8 RPM is a realistic rated-speed value for a large utility turbine.
 */
const DEMO_RPM = 8;

/**
 * Demo mode: how fast the virtual wind direction sweeps (rad/s).
 * One full 360° revolution every 60 seconds — slow enough to clearly show
 * the nacelle yawing to track the changing wind direction.
 */
const DEMO_YAW_RAD_PER_SEC = (2 * Math.PI) / 60;

export class WindFarmPlugin implements RVViewerPlugin {
  readonly id = 'windfarm-plugin';

  /** KPI bar slot registrations. */
  readonly slots: UISlotEntry[] = [
    { slot: 'kpi-bar',  component: WindFarmPowerKpi,      order: 50 },
    { slot: 'kpi-bar',  component: WindFarmWindKpi,       order: 51 },
    { slot: 'kpi-bar',  component: WindFarmAlarmKpi,      order: 52 },
    { slot: 'kpi-bar',  component: WindFarmDirectionKpi,  order: 53 },
    { slot: 'kpi-bar',  component: WindFarmYawKpi,        order: 54 },
    { slot: 'kpi-bar',  component: WindFarmResourceKpi,   order: 55 },
    { slot: 'messages', component: WindFarmStatusMessage, order: 10 },
    { slot: 'messages', component: WindFarmResourcePanel, order: 12 },
    { slot: 'messages', component: WindFarmControlPanel,  order: 14 },
    { slot: 'messages', component: WindFarmAlarmMessage,  order: 5  },
  ];

  private viewer: RVViewer | null = null;
  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private reconnectDelay = 1_000;
  private backendUrl: string;
  private objectByTwin = new Map<string, string>();

  /** Last known alarm state per turbine — used to avoid duplicate messages. */
  private alarmState = new Map<string, boolean>();
  /** Latest rotorRpm per turbine — used by onRender for blade animation. */
  private rotorRpm = new Map<string, number>();
  /** Unique scene-object names already seen (de-duplicated set for rotation). */
  private rotatingObjects = new Set<string>();
  /** Optional explicit twinId → sceneObjectName mapping. When provided, the
   *  auto-discovery fallback is skipped entirely. */
  private readonly explicitMapping: Record<string, string> | null;
  /** ArrowHelper showing live wind direction, added directly to the viewer scene. */
  private windVane: ArrowHelper | null = null;
  /** N / S / E / W sprite labels placed around the turbine at ground level. */
  private compassLabels: Sprite[] = [];
  /** The turbine RootNode — yawed around Y to face the wind. */
  private nacelleYawNode: Object3D | null = null;
  /** The Blades container node — directly spun around its local Y axis (rotor shaft). */
  private bladesSpinNode: Object3D | null = null;
  /** Target nacelle yaw angle (radians) — from nacelleAngleDeg when the simulator
   *  tracks yaw, otherwise derived from windDirectionDeg. */
  private targetYawRad = 0;
  /** True wind direction (radians). Used for the wind arrow and yaw-error KPI. */
  private windDirRad = 0;
  /** Current interpolated yaw angle applied to nacelleYawNode each frame. */
  private currentYawRad = 0;
  /** False until the first telemetry arrives — used to snap instantly on load. */
  private hasInitialYaw = false;
  /** True once the simulator has sent nacelleAngleDeg at least once — when set,
   *  the blade RPM already includes yaw efficiency so the viewer skips its own
   *  multiplication to avoid double-applying the factor. */
  private simTracksYaw = false;
  /**
   * True from model load until the first real telemetry frame arrives.
   * In this state the nacelle yaws to track a slowly-rotating virtual wind
   * direction and the blades spin at DEMO_RPM, so the physics are immediately
   * visible without needing a live backend connection.
   */
  private demoMode = true;
  /** Accumulated demo time (seconds) — drives the virtual wind direction. */
  private demoTimer = 0;
  /** Unsubscribe function for the 'turbine-control' viewer event listener. */
  private controlOff: (() => void) | null = null;
  /** Unsubscribe function for the 'turbine-damage' viewer event listener. */
  private damageOff: (() => void) | null = null;

  constructor(backendUrl = 'http://localhost:8080', explicitMapping?: Record<string, string>) {
    this.backendUrl = backendUrl;
    this.explicitMapping = explicitMapping ?? null;
  }

  onModelLoaded(result: LoadResult, viewer: RVViewer): void {
    // Allow settings.json pluginConfig to override the constructor-supplied backendUrl.
    const cfgUrl = result.modelConfig?.pluginConfig?.['windfarm-plugin']?.['backendUrl'];
    if (typeof cfgUrl === 'string' && cfgUrl) {
      this.backendUrl = cfgUrl;
    }
    this.viewer = viewer;
    this.normalizeModelScale(viewer);
    this.createWindVane(viewer);
    this.createCompassLabels(viewer);
    // Store the RootNode — rotating it around Y yaws the nacelle+blades
    // to face into the wind (tower is cylindrical, looks the same from any angle).
    // Primary: find via Blades.parent (Blades is guaranteed in scene since it spins).
    // Fallback: direct name lookup.
    const bladesNode = viewer.scene.getObjectByName('Blades');
    this.nacelleYawNode = bladesNode?.parent
      ?? viewer.scene.getObjectByName('RootNode')
      ?? null;
    if (this.nacelleYawNode) {
      this.nacelleYawNode.matrixAutoUpdate = true;
    }
    // Store the Blades container so onRender always spins the right node,
    // regardless of how objectByTwin resolves via the fallback heuristic.
    this.bladesSpinNode = bladesNode
      ?? viewer.scene.getObjectByName('Blades_WindTurbine_PBR_0')
      ?? null;
    this.buildObjectMap();
    // Register the control function so React components can start/stop turbines.
    windFarmStore.setControlFn((turbineId, running) => this.sendControl(turbineId, running));
    // Also listen to the viewer event bus so any plugin or the browser console
    // can emit 'turbine-control' to start/stop a turbine without going through React.
    this.controlOff = viewer.on('turbine-control', ({ turbineId, running }) => {
      void this.sendControl(turbineId, running);
    });
    this.damageOff = viewer.on('turbine-damage', ({ turbineId, damagePct }) => {
      void this.sendDamage(turbineId, damagePct);
    });
    // Start demo animation immediately so the nacelle and blades are already
    // moving on first paint, before any backend data arrives.
    // hasInitialYaw = true enables the wind arrow and yaw KPI from frame 1.
    this.demoMode = true;
    this.demoTimer = 0;
    this.hasInitialYaw = true;
    this.windDirRad = 0;
    this.targetYawRad = 0;
    this.currentYawRad = 0;
    this.reconnectDelay = 1_000;
    this.connect();
  }

  onModelCleared(): void {
    this.closeSocket();
    windFarmStore.setControlFn(null);
    this.controlOff?.();
    this.controlOff = null;
    this.damageOff?.();
    this.damageOff = null;
    this.objectByTwin.clear();
    this.alarmState.clear();
    this.rotorRpm.clear();
    this.rotatingObjects.clear();
    this.nacelleYawNode = null;
    this.bladesSpinNode = null;
    this.hasInitialYaw = false;
    this.simTracksYaw = false;
    this.demoMode = true;
    this.demoTimer = 0;
    this.windDirRad = 0;
    if (this.windVane) {
      this.windVane.parent?.remove(this.windVane);
      this.windVane = null;
    }
    for (const label of this.compassLabels) {
      label.parent?.remove(label);
      (label.material as SpriteMaterial).map?.dispose();
      label.material.dispose();
    }
    this.compassLabels = [];
  }

  /**
   * Called every render frame (variable dt, seconds).
   * Rotates each unique scene object by the average rotor RPM of the turbines
   * mapped to it. 1 RPM = 2π/60 rad/s.
   */
  onRender(frameDt: number): void {
    if (!this.viewer) return;
    const scene = this.viewer.scene;

    // ── Demo mode — drive a slowly-rotating virtual wind before real data arrives ──
    if (this.demoMode) {
      this.demoTimer += frameDt;
      // Slowly sweep wind direction around the compass (one full revolution / 60 s).
      // Using the same sign convention as real telemetry: negative = clockwise from North.
      const demoWindRad = -(this.demoTimer * DEMO_YAW_RAD_PER_SEC);
      this.windDirRad   = demoWindRad;
      this.targetYawRad = demoWindRad;
    }

    // ── Nacelle yaw — smooth interpolation toward target wind direction ──
    if (this.nacelleYawNode || this.windVane) {
      // Shortest-path angle difference (handles 350°→10° wrap correctly)
      let diff = this.targetYawRad - this.currentYawRad;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      // 5°/s yaw rate — slow enough that the rotation arc is clearly visible
      // when wind direction changes, letting the yaw-efficiency effect be seen.
      const maxStep = (5 * Math.PI / 180) * frameDt;
      this.currentYawRad += Math.max(-maxStep, Math.min(maxStep, diff));

      if (this.nacelleYawNode) {
        // THREE.js R_y(θ) applied to default shaft direction (0,0,-1):
        //   x = -sin(θ),  z = -cos(θ)
        // Wind from deg° CW from North: shaft must point (sin(deg_rad), 0, -cos(deg_rad)).
        // Solving: -sin(rotation.y) = sin(deg_rad)  →  rotation.y = -deg_rad = targetYawRad = currentYawRad.
        // (No negation — the shaft direction and the wind arrow use the same sign convention.)
        this.nacelleYawNode.rotation.y = this.currentYawRad + YAW_OFFSET_RAD;
        this.nacelleYawNode.updateMatrix();
      }

      // ── Wind arrow — always shows the TRUE wind direction (windDirRad), not the
      // nacelle position.  Scene convention: N = -Z, E = +X.
      if (this.windVane && this.hasInitialYaw) {
        this.windVane.setDirection(
          new Vector3(-Math.sin(this.windDirRad), 0, -Math.cos(this.windDirRad))
        );
      }

      // ── Push wind direction (not nacelle angle) to the KPI widget ──
      if (this.hasInitialYaw) {
        const displayDeg = ((-this.windDirRad * 180 / Math.PI) % 360 + 360) % 360;
        windFarmStore.setDisplayWindDirDeg(displayDeg);
      }
    }

    // ── Yaw alignment → effective RPM ─────────────────────────────────
    // Yaw error = angle between nacelle and true wind direction.
    // When the simulator sends nacelleAngleDeg, the nacelle target differs from
    // wind direction — use windDirRad as the ideal alignment reference.
    const yawError = Math.atan2(
      Math.sin(this.currentYawRad - this.windDirRad),
      Math.cos(this.currentYawRad - this.windDirRad)
    );
    const yawEfficiency = Math.max(0, Math.cos(yawError) ** 2);

    // Publish capacity % to the store so KPI cards and status panel reflect it.
    windFarmStore.setYawCapacityPct(yawEfficiency);

    // ── Rotor spin — always targets the Blades container node directly ──────
    // objectByTwin fallback heuristic maps by name-pattern and can resolve to
    // the wrong mesh (nacelle body instead of blades).  Using the node reference
    // captured at load time guarantees the correct target.
    if (this.bladesSpinNode) {
      const rpmValues = [...this.rotorRpm.values()];
      let avgRpm: number;
      if (rpmValues.length > 0) {
        const rawAvgRpm = rpmValues.reduce((a, b) => a + b, 0) / rpmValues.length;
        // rotorRpm from the backend is already scaled by resource & running state.
        // When the simulator already applies yaw capacity to RPM (simTracksYaw),
        // use the value directly.  Otherwise fall back to the viewer-side factor.
        avgRpm = this.simTracksYaw ? rawAvgRpm : rawAvgRpm * yawEfficiency;
      } else if (this.demoMode) {
        // No real RPM data yet — use the demo default so blades spin immediately.
        // Scale by yaw efficiency so the physics are visually consistent even in demo.
        avgRpm = DEMO_RPM * yawEfficiency;
      } else {
        avgRpm = 0;
      }
      if (avgRpm > 0) {
        const angularVelocityRad = (avgRpm * Math.PI * 2) / 60 * frameDt;
        this.bladesSpinNode.quaternion.multiply(
          _spinQuat.setFromAxisAngle(_bladeSpinAxis, angularVelocityRad),
        );
      }
    }

    // ── Always request a new frame so yaw and blade spin render continuously ──
    // The viewer uses a dirty-flag renderer — without this call the scene is
    // only re-drawn on user interaction, making all animations appear frozen.
    this.viewer.markRenderDirty();
  }

  dispose(): void {
    this.onModelCleared();
  }

  /**
   * Places cardinal-direction labels (N / S / E / W) as camera-facing sprites
   * at a fixed radius around the turbine base.  The convention matches the wind
   * arrow: 0 ° (North) → arrow points +Z, so N label sits at -Z.
   * Radius is 52 units — clear of the 18-unit wind arrow at x = 35.
   */
  private createCompassLabels(viewer: RVViewer): void {
    const R = 52; // radius from scene origin
    const Y =  8; // height above ground
    const cardinals: Array<{ label: string; x: number; z: number }> = [
      { label: 'N', x:  0, z: -R },
      { label: 'S', x:  0, z:  R },
      { label: 'E', x:  R, z:  0 },
      { label: 'W', x: -R, z:  0 },
    ];
    for (const { label, x, z } of cardinals) {
      const sprite = this.makeCompassSprite(label);
      sprite.position.set(x, Y, z);
      sprite.name = `__compass_${label}`;
      viewer.scene.add(sprite);
      this.compassLabels.push(sprite);
    }
  }

  /** Renders a single letter onto a canvas and returns a billboard Sprite. */
  private makeCompassSprite(text: string): Sprite {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;

    // Transparent background, bold white letter with a subtle dark halo
    ctx.clearRect(0, 0, size, size);
    ctx.font = `bold ${size * 0.7}px Arial, sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor  = 'rgba(0,0,0,0.85)';
    ctx.shadowBlur   = 10;
    ctx.fillStyle    = '#ffffff';
    ctx.fillText(text, size / 2, size / 2);

    const texture  = new CanvasTexture(canvas);
    const material = new SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false });
    const sprite   = new Sprite(material);
    sprite.scale.set(7, 7, 1);
    return sprite;
  }

  private createWindVane(viewer: RVViewer): void {
    // Arrow points along +Z by default (treated as North).
    // rotation.y will be driven by windDirectionDeg from telemetry.
    // Placed 35 units to the right of the turbine base, slightly elevated.
    const dir = new Vector3(0, 0, 1);
    const origin = new Vector3(35, 6, 0);
    const vane = new ArrowHelper(dir, origin, 18, 0x00bfff, 5, 3.5);
    vane.name = '__windVane';
    viewer.scene.add(vane);
    this.windVane = vane;
  }

  private normalizeModelScale(viewer: RVViewer): void {
    const scene = viewer.scene;

    // Force-update every world matrix so Box3.setFromObject reads correct values.
    // The loader sets matrixAutoUpdate=false on static meshes, so world matrices
    // can be stale at onModelLoaded time if the render loop hasn't run yet.
    scene.updateMatrixWorld(true);

    // Find the Sketchfab_model root node by name, then use its PARENT (which is
    // the gltf.scene Group added to viewer.scene) so we can move the whole asset.
    const sketchfabNode = scene.getObjectByName('Sketchfab_model');
    let modelRoot: Object3D = sketchfabNode?.parent ?? sketchfabNode ?? scene;

    // If we ended up at the viewer scene itself, fall back to first non-empty child
    if (modelRoot === scene) {
      for (let i = scene.children.length - 1; i >= 0; i--) {
        const box = new Box3().setFromObject(scene.children[i]);
        if (!box.isEmpty()) { modelRoot = scene.children[i]; break; }
      }
    }
    if (modelRoot === scene) return;

    const box = new Box3().setFromObject(modelRoot);
    if (box.isEmpty()) return;

    const size = box.getSize(new Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    if (maxDim < 0.001) return;

    // Scale the root to a target height of 60 scene units
    const s = 60 / maxDim;
    modelRoot.scale.multiplyScalar(s);
    // Force matrices to update immediately — don't wait for the render loop
    modelRoot.updateWorldMatrix(false, true);

    // Re-compute the post-scale box and center the model horizontally, sit on y=0
    box.setFromObject(modelRoot);
    const center = box.getCenter(new Vector3());
    modelRoot.position.x -= center.x;
    modelRoot.position.z -= center.z;
    modelRoot.position.y -= box.min.y;
    modelRoot.updateWorldMatrix(false, true);

    // Animate camera to frame the normalized model
    viewer.fitToNodes([modelRoot]);
  }

  private buildObjectMap(): void {
    this.objectByTwin.clear();

    // Use explicit mapping when provided — no scene traversal needed
    if (this.explicitMapping) {
      for (const [twinId, objectName] of Object.entries(this.explicitMapping)) {
        this.objectByTwin.set(twinId, objectName);
      }
      return;
    }

    const scene = (this.viewer as unknown as { scene?: Object3D }).scene;
    if (!scene) return;

    ['Turbine_01', 'Turbine_02', 'Turbine_03'].forEach((id) => {
      const obj = scene.getObjectByName(id);
      if (obj) this.objectByTwin.set(id, id);
    });

    // Fallback for single-turbine models
    if (this.objectByTwin.size === 0) {
      const candidates: string[] = [];
      scene.traverse((node) => {
        const lower = node.name.toLowerCase();
        if (lower.includes('turbine') || lower.includes('wind')) {
          candidates.push(node.name);
        }
      });
      const fallback = candidates.slice(0, 3);
      if (fallback[0]) this.objectByTwin.set('Turbine_01', fallback[0]);
      if (fallback[1]) this.objectByTwin.set('Turbine_02', fallback[1]);
      if (fallback[2]) this.objectByTwin.set('Turbine_03', fallback[2]);
    }
  }

  private connect(): void {
    this.closeSocket();
    const streamUrl = this.backendUrl.replace(/^http/i, 'ws') + '/stream';
    this.ws = new WebSocket(streamUrl);

    this.ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as StreamEnvelope;
        if (message.type === 'telemetry') this.handleTelemetry(message.payload);
        if (message.type === 'kpi') this.handleKpi(message.payload);
        if (message.type === 'alert') this.handleAlert(message.payload);
        if (message.type === 'control') this.handleControl(message.payload);
      } catch {
        // malformed frame — ignore
      }
    };

    this.ws.onerror = (event) => {
      console.error('[WindFarmPlugin] WebSocket error', event);
      // onclose fires after onerror; reconnect is handled there
    };

    this.ws.onopen = () => {
      // Successful connection — reset backoff
      this.reconnectDelay = 1_000;
    };

    this.ws.onclose = () => {
      this.scheduleReconnect();
    };
  }

  private closeSocket(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null; // prevent double-reconnect on explicit close
      this.ws.close();
      this.ws = null;
    }
  }

  /** Exponential backoff: 1 s → 2 s → 4 s … capped at 30 s. */
  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_MS);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.viewer) this.connect();
    }, delay);
  }

  private handleTelemetry(payload: TelemetryPayload): void {
    if (!this.viewer) return;
    // Real telemetry has arrived — disable demo mode so real data takes over.
    // Do this before processing the payload so the first real wind direction
    // and RPM values are applied on this same frame.
    this.demoMode = false;
    const scene = this.viewer.scene;

    const objectName = this.objectByTwin.get(payload.turbineId);
    if (!objectName) return;

    // Color the turbine body mesh for alarm state.
    // The blades container ('Blades') has no material; the actual mesh nodes do.
    // Try the tower body first; fall back to the first mesh found in the scene.
    const colorTargets: string[] = ['Main Unit_WindTurbine_PBR_0', 'Blades_WindTurbine_PBR_0', objectName];
    const alarmColor = payload.alarmActive ? 0xff4d4f : 0x52c41a;
    for (const targetName of colorTargets) {
      const node = scene.getObjectByName(targetName) as Object3D & {
        material?: Material & { color?: { setHex: (hex: number) => void }; clone?: () => Material };
      };
      if (node?.material?.color?.setHex) {
        if (!clonedMaterials.has(node.material)) {
          node.material = node.material.clone?.() ?? node.material;
          clonedMaterials.add(node.material);
        }
        node.material.color.setHex(alarmColor);
      }
    }

    // Store latest RPM for rotation animation
    this.rotorRpm.set(payload.turbineId, payload.rotorRpm);

    // Wind direction: drives the arrow and yaw-error KPI.
    // Meteorological convention: degrees the wind comes FROM, clockwise from North.
    if (payload.windDirectionDeg !== undefined) {
      this.windDirRad = -(payload.windDirectionDeg * Math.PI) / 180;
    }

    // Nacelle target: prefer nacelleAngleDeg from the simulator (true digital-twin
    // position) so the 3D nacelle exactly mirrors the simulated state.
    // Fall back to windDirectionDeg for backward-compat with older simulators.
    if (payload.nacelleAngleDeg !== undefined) {
      this.simTracksYaw  = true;
      this.targetYawRad  = -(payload.nacelleAngleDeg * Math.PI) / 180;
      if (!this.hasInitialYaw) {
        this.currentYawRad = this.targetYawRad;
        this.hasInitialYaw = true;
      }
    } else if (payload.windDirectionDeg !== undefined) {
      this.targetYawRad = this.windDirRad;
      // Snap to initial wind direction immediately so the turbine
      // doesn't have to slowly yaw from 0° on page load
      if (!this.hasInitialYaw) {
        this.currentYawRad = this.targetYawRad;
        this.hasInitialYaw = true;
      }
    }

    // Update message panel store
    windFarmStore.setTurbineStatus(payload);

    // Only emit a message-add when the alarm STATE changes (not on every tick)
    const wasAlarm = this.alarmState.get(payload.turbineId) ?? false;
    if (payload.alarmActive !== wasAlarm) {
      this.alarmState.set(payload.turbineId, payload.alarmActive);
    }
  }

  private handleKpi(payload: KpiPayload): void {
    windFarmStore.setKpi(payload);
  }

  private handleControl(payload: ControlPayload): void {
    // Immediately reflect operator start/stop in the store so the UI updates
    // before the next telemetry tick arrives.
    const current = windFarmStore.getTurbineStatus();
    if (current && current.turbineId === payload.turbineId) {
      windFarmStore.setTurbineStatus({
        ...current,
        running: payload.running,
        resourcePct: payload.resourcePct,
        status: payload.running ? current.status : 'Stopped',
      });
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private handleAlert(_payload: AlertPayload): void {
    // Alarm state is surfaced via the WindFarmAlarmMessage messages slot component.
  }

  /**
   * Sends a start or stop command to the backend REST API.
   * Registered in the store so React components can call it without
   * knowing the backend URL.
   */
  private async sendDamage(turbineId: string, damagePct: number): Promise<void> {
    try {
      const res = await fetch(`${this.backendUrl}/api/control/damage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ turbineId, damagePct }),
      });
      if (!res.ok) {
        const text = await res.text();
        console.error('[WindFarmPlugin] Damage command failed:', res.status, text);
      }
    } catch (err) {
      console.error('[WindFarmPlugin] Damage command error:', err);
    }
  }

  private async sendControl(turbineId: string, running: boolean): Promise<void> {
    try {
      const res = await fetch(`${this.backendUrl}/api/control/turbine`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ turbineId, running }),
      });
      if (!res.ok) {
        const text = await res.text();
        console.error('[WindFarmPlugin] Control command failed:', res.status, text);
      }
    } catch (err) {
      console.error('[WindFarmPlugin] Control command error:', err);
    }
  }
}
