// SPDX-License-Identifier: AGPL-3.0-only

import type { RVViewer } from '../../../core/rv-viewer';
import type { ModelPluginModule } from '../../../core/rv-model-plugin-manager';
import { WindFarmPlugin } from '../../windfarm-plugin';

export const models = ['WindFarmLab', 'windfarmlab', 'Wind turbine', 'Wind_turbine', 'animated_wind_turbine'];

const registeredIds: string[] = [];

export function registerModelPlugins(viewer: RVViewer): void {
  // 'Blades' is the container node in animated_wind_turbine.glb that holds the rotating blade mesh.
  // Rotating this container spins the blades around the correct pivot point.
  const plugin = new WindFarmPlugin('http://localhost:8080', {
    Turbine_01: 'Blades',
  });
  viewer.use(plugin);
  registeredIds.push(plugin.id);
}

export function unregisterModelPlugins(viewer: RVViewer): void {
  for (const id of registeredIds) {
    viewer.removePlugin(id);
  }
  registeredIds.length = 0;
}

export default { models, registerModelPlugins, unregisterModelPlugins } satisfies ModelPluginModule;
