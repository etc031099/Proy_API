'use strict';
const { SCHEMA_REASONS } = require('./groundedOutputSchema');
const { NUMBER_PATTERNS } = require('./groundedNumbers');
const { LIMITATION_REASONS, isLimitationCode } = require('./groundedLimitations');
const safeSchemaField = value => typeof value === 'string'
  && /^(?:\$|observations(?:\[[0-2]\](?:\.(?:evidenceRefs(?:\[[0-3]\])?|interpretation|advisoryRecommendation))?)?|limitations(?:\[[01]\])?)$/.test(value);
const REASONS = new Set(['NONE', 'CONTENT_JSON_INVALID', 'OUTPUT_SCHEMA_INVALID', 'EVIDENCE_REFERENCE_INVALID',
  'TEXT_FIELD_INVALID', 'OUTPUT_TEXT_TOO_LONG', 'UNSAFE_CONTENT', 'UNSUPPORTED_SEMANTIC_CLAIM', 'UNKNOWN_ENTITY',
  'UNSUPPORTED_NUMBER', 'LIMITATION_NOT_ALLOWED', 'PROVIDER_UNAVAILABLE', 'HTTP_ERROR', 'ENVELOPE_JSON_INVALID', 'USAGE_INVALID',
  'OUTPUT_TRUNCATED', 'CONTENT_EMPTY', 'MODEL_MISMATCH', 'FINISH_REASON_UNSUPPORTED', 'ENVELOPE_SCHEMA_INVALID',
  'CONTEXT_BUDGET_EXCEEDED', 'CONTEXT_BUILD_FAILED']);
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
  ...(source.validationReason === 'UNKNOWN_ENTITY' && ['UNKNOWN_IDENTIFIER', 'UNKNOWN_NAME_AFTER_ACTION',
    'UNKNOWN_LABELLED_ENTITY', 'UNKNOWN_PURCHASE_ENTITY'].includes(source.entityReason) ? { entityReason: source.entityReason } : {}),
  ...(source.validationReason === 'UNKNOWN_ENTITY' && source.entityReason === 'UNKNOWN_LABELLED_ENTITY'
    && ['PRODUCT', 'CUSTOMER', 'SUPPLIER', 'UNKNOWN'].includes(source.labelledEntityType)
    ? { labelledEntityType: source.labelledEntityType } : {}),
  ...(source.validationReason === 'LIMITATION_NOT_ALLOWED' && LIMITATION_REASONS.includes(source.limitationReason)
    ? { limitationReason: source.limitationReason } : {}),
  ...(source.validationReason === 'LIMITATION_NOT_ALLOWED' && isLimitationCode(source.limitationCode)
    ? { limitationCode: source.limitationCode } : {}),
  ...(source.validationReason === 'UNSUPPORTED_NUMBER' && Array.isArray(source.unsupportedNumbers)
    ? { unsupportedNumbers: source.unsupportedNumbers.slice(0, 3).filter(value => typeof value === 'number'
      && Number.isFinite(value) && Math.abs(value) <= 1e9) } : {}),
  ...(source.validationReason === 'UNSUPPORTED_NUMBER' && Array.isArray(source.unsupportedNumberDetails) && Array.isArray(source.unsupportedNumbers)
    ? { unsupportedNumberDetails: source.unsupportedNumberDetails.slice(0, 3)
      .filter(detail => detail && typeof detail.value === 'number' && Number.isFinite(detail.value)
        && Math.abs(detail.value) <= 1e9 && source.unsupportedNumbers?.includes(detail.value)
        && NUMBER_PATTERNS.includes(detail.pattern))
      .map(detail => ({ value: detail.value, pattern: detail.pattern })) } : {}),
  ...(typeof source.validationField === 'string'
    && /^(?:observations\[[0-2]\]\.(?:interpretation|advisoryRecommendation|evidenceRefs)|limitations\[[01]\])$/.test(source.validationField)
    ? { validationField: source.validationField } : {})
});
const logGroundedValidation = source => {
  // Fixed fields and bounded rejected numbers only. No generated prose, prompts or error messages.
  const diagnostic = safeGroundedDiagnostic(source);
  try { console.info('[GroundedValidation]', JSON.stringify({ groundedValidation: diagnostic })); }
  catch { /* Diagnostic sinks cannot change the synthesis outcome. */ }
};
module.exports = { safeGroundedDiagnostic, logGroundedValidation };
