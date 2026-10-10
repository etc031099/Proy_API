const DEFAULT_SKILL_TIMEOUT_MS = 5000;
const REMOTE_ML_SKILL_TIMEOUT_MS = 25000;
// Keep the HTTP call below the skill deadline so its AbortController can stop
// a slow ML request before the enclosing agent execution deadline expires.
const AGENT_ML_HTTP_TIMEOUT_MS = 20000;

const ML_DEPENDENT_SKILLS = Object.freeze([
  'get_demand_forecast',
  'get_replenishment_candidates',
  'analyze_demand_forecast',
  'get_replenishment_cost',
  'plan_replenishment_budget',
  'compare_supplier_costs'
]);

const skillTimeoutMs = skillId => ML_DEPENDENT_SKILLS.includes(skillId)
  ? REMOTE_ML_SKILL_TIMEOUT_MS : DEFAULT_SKILL_TIMEOUT_MS;

module.exports = {
  DEFAULT_SKILL_TIMEOUT_MS,
  REMOTE_ML_SKILL_TIMEOUT_MS,
  AGENT_ML_HTTP_TIMEOUT_MS,
  ML_DEPENDENT_SKILLS,
  skillTimeoutMs
};
