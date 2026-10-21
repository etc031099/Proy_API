'use strict';

const AGENT_IDS = Object.freeze([
  'coordinator', 'operations', 'analyst', 'sales', 'inventory', 'forecast', 'customers', 'procurement', 'associations'
]);
const LEGACY_AGENT_IDS = Object.freeze(['analyst']);
const PLANNED_SPECIALIST_IDS = Object.freeze(['sales', 'inventory', 'forecast', 'customers', 'procurement', 'associations']);
const isAgentId = value => AGENT_IDS.includes(value);

module.exports = { AGENT_IDS, LEGACY_AGENT_IDS, PLANNED_SPECIALIST_IDS, isAgentId };
