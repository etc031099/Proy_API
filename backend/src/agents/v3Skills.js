'use strict';

const V3_SKILLS = Object.freeze({
  get_business_analytics: { domain: 'business', agents: ['analyst'], modes: ['summary', 'compare', 'rank', 'anomalies'], metrics: ['units', 'revenue', 'gross_margin', 'tickets'] },
  get_inventory_intelligence: { domain: 'inventory', agents: ['operations', 'analyst'], modes: ['summary', 'detail', 'rank', 'recommendations'], metrics: ['stockout_risk', 'low_stock', 'overstock', 'slow_moving', 'abc_a', 'az', 'single_source_critical', 'reorder'] },
  get_product_forecast: { domain: 'forecast', agents: ['analyst'], modes: ['detail', 'compare', 'rank', 'summary', 'method', 'evaluation'] },
  get_cross_sell_recommendations: { domain: 'cross-sell', agents: ['analyst'], modes: ['recommend', 'rules', 'summary'] },
  get_customer_intelligence: { domain: 'customers', agents: ['analyst'], modes: ['detail', 'rank', 'preferences', 'activity', 'summary', 'clustering'], metrics: ['spend', 'tickets', 'recency', 'gross_margin'] },
  get_supplier_intelligence: { domain: 'suppliers', agents: ['analyst'], modes: ['detail', 'rank', 'summary', 'alternatives', 'dependency'], metrics: ['spend', 'orders', 'lead_time', 'late_share', 'dependency', 'fastestLeadTime', 'punctuality', 'delays', 'productCoverage', 'exclusiveProducts'] },
  get_business_health: { domain: 'health', agents: ['analyst'] }
});
const V3_IDS = Object.freeze(Object.keys(V3_SKILLS));
// Flat, closed skill arguments use the existing registry validator. Tenant and lineage
// are deliberately absent; only the authenticated adapter constructs service context.
const v3SkillProperties = id => {
  const spec = V3_SKILLS[id], text = maxLength => ({ type: 'string', minLength: 1, maxLength });
  const props = { limit: { type: 'integer', minimum: 1, maximum: id === 'get_business_health' ? 5 : 20 } };
  if (spec.modes) props.mode = { type: 'string', enum: spec.modes, maxLength: 20 };
  if (spec.metrics) props.metric = { type: 'string', enum: spec.metrics, maxLength: 30 };
  if (spec.domain === 'forecast') props.concept = { type: 'string', enum: ['algorithm', 'features', 'supervised', 'wape', 'baseline', 'why_method'] };
  if (spec.domain === 'customers') {
    props.clusterFilter = text(80); props.clusterId = { type: 'integer', minimum: 1, maximum: 10 };
    props.concept = { type: 'string', enum: ['kmeans', 'silhouette', 'ari', 'rfm', 'unsupervised'] };
  }
  if (spec.domain === 'business') props.concept = { type: 'string', enum: ['isolation_forest', 'anomaly', 'score', 'contamination', 'fraud', 'unsupervised'] };
  if (spec.domain === 'cross-sell') props.concept = { type: 'string', enum: ['fp_growth', 'support', 'confidence', 'lift', 'causality'] };
  if (spec.domain === 'inventory' || spec.domain === 'suppliers') props.concept = { type: 'string', enum: ['not_ml'] };
  if (id !== 'get_business_health') props.offset = { type: 'integer', minimum: 0, maximum: 10000 };
  if (['business', 'customers', 'suppliers', 'health'].includes(spec.domain)) {
    props.startDate = { ...text(10), format: 'date' }; props.endDate = { ...text(10), format: 'date' };
  }
  if (['business', 'inventory', 'forecast', 'cross-sell', 'suppliers'].includes(spec.domain)) props.productRef = text(100);
  if (['inventory', 'forecast'].includes(spec.domain)) props.productRefs = text(504);
  if (spec.domain === 'customers') props.customerRef = text(100);
  if (spec.domain === 'suppliers' || spec.domain === 'inventory') props.supplierRef = text(100);
  if (spec.domain === 'forecast') { props.horizonDays = { type: 'integer', minimum: 1, maximum: 365 }; props.asOfDate = { ...text(10), format: 'date' }; }
  if (spec.domain === 'business') { props.entityType = { ...text(20), enum: ['product', 'category'] }; props.categoryCode = text(64); props.subcategoryCode = text(64); props.categoryRef = text(100); props.subcategoryRef = text(100); }
  if (spec.domain === 'inventory') {
    props.risk = { ...text(10), enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] };
    props.abc = { ...text(1), enum: ['A', 'B', 'C'] }; props.xyz = { ...text(1), enum: ['X', 'Y', 'Z'] };
    props.flag = { ...text(30), enum: ['low_stock', 'overstock', 'slow_moving', 'dead_stock', 'single_source', 'should_reorder'] };
  }
  if (spec.domain === 'customers') props.segment = { ...text(20), enum: ['AT_RISK', 'INACTIVE', 'NEW', 'LOYAL', 'TOP_HIGH_VALUE', 'POTENTIAL'] };
  if (spec.domain === 'suppliers') props.sortDirection = { ...text(4), enum: ['asc', 'desc'] };
  return props;
};
module.exports = { V3_SKILLS, V3_IDS, v3SkillProperties };
