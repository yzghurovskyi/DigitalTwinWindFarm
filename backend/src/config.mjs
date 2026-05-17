/**
 * Shared runtime configuration.
 *
 * Single source of truth for turbine IDs and farm ID used by the
 * server, KPI service, and ADT client.  Consumers that previously
 * duplicated this list should import from here.
 */

export const TURBINE_IDS = ['Turbine_01'];

/** ADT twin ID of the farm root.  Falls back to the well-known lab name. */
export const FARM_ID = process.env.FARM_ID || 'WindFarm_01';
