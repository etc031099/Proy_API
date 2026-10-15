'use strict';
const { SCHEMA_REASONS } = require('./groundedOutputSchema');
const safeSchemaField = value => typeof value === 'string'
  && /^(?:\$|observations(?:\[[0-2]\](?:\.(?:evidenceRefs(?:\[[0-3]\])?|interpretation|advisoryRecommendation))?)?|limitations(?:\[[01]\])?)$/.test(value);
const REASONS = new Set(['NONE', 'CONTENT_JSON_INVALID', 'OUTPUT_SCHEMA_INVALID', 'EVIDENCE_REFERENCE_INVALID',
  'TEXT_FIELD_INVALID', 'OUTPUT_TEXT_TOO_LONG', 'UNSAFE_CONTENT', 'UNSUPPORTED_SEMANTIC_CLAIM', 'UNKNOWN_ENTITY',
  'UNSUPPORTED_NUMBER', 'LIMITATION_NOT_ALLOWED', 'PROVIDER_UNAVAILABLE', 'HTTP_ERROR', 'ENVELOPE_JSON_INVALID', 'USAGE_INVALID',
  'OUTPUT_TRUNCATED', 'CONTENT_EMPTY', 'MODEL_MISMATCH', 'FINISH_REASON_UNSUPPORTED', 'ENVELOPE_SCHEMA_INVALID']);
const safeGroundedDiagnostic = (source = {}) => ({
  provider: ['deepseek', 'gemini'].includes(source.provider) ? source.provider : null,
  model: typeof source.model === 'string' && /^[\w.-]{1,100}$/.test(source.model) ? source.model : null,
  providerResponseReceived: typeof source.providerResponseReceived === 'boolean' ? source.providerResponseReceived : null,
  httpStatus: Number.isInteger(source.httpStatus) && source.httpStatus >= 100 && source.httpStatus <= 599 ? source.httpStatus : null,
  contentPresent: typeof source.contentPresent === 'boolean' ? source.contentPresent : null,
  contentLength: Number.isSafeInteger(source.contentLength) && source.contentLength >= 0 && source.contentLength <= 6000 ? source.contentLength : null,
  finishReason: ['stop', 'length', 'tool_calls', 'content_filter', 'insufficient_system_resource'].includes(source.finishReason) ? source.finishReason : null,
  usagePresent: typeof source.usagePresent === 'boolean' ? source.usagePresent : null,
  usageParseResult: ['ABSENT', 'COMPLETE', 'INCOMPLETE', 'INVALID'].includes(source.usageParseResult) ? source.usageParseResult : null,
  validationResult: source.validationResult === 'ACCEPTED' ? 'ACCEPTED' : 'REJECTED',
  validationPassed: source.validationResult === 'ACCEPTED',
  validationReason: REASONS.has(source.validationReason) ? source.validationReason : 'OTHER',
  ...(['SCHEMA', 'GROUNDING'].includes(source.validationLayer) ? { validationLayer: source.validationLayer } : {}),
  ...(SCHEMA_REASONS.includes(source.schemaReason) ? { schemaReason: source.schemaReason } : {}),
  ...(safeSchemaField(source.schemaField) ? { schemaField: source.schemaField } : {}),
  ...(typeof source.validationField === 'string'
    && /^(?:observations\[[0-2]\]\.(?:interpretation|advisoryRecommendation|evidenceRefs)|limitations\[[01]\])$/.test(source.validationField)
    ? { validationField: source.validationField } : {})
});
const logGroundedValidation = source => {
  // Fixed fields only. Never include generated prose, prompts, error messages or values.
  const diagnostic = safeGroundedDiagnostic(source);
  try { console.info('[GroundedValidation]', JSON.stringify({ groundedValidation: diagnostic })); }
  catch { /* Diagnostic sinks cannot change the synthesis outcome. */ }
};
module.exports = { safeGroundedDiagnostic, logGroundedValidation };
