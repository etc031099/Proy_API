'use strict';
const { deepFreeze, isPlainObject } = require('./contracts');
const text = maxLength => ({ type: 'string', minLength: 1, maxLength, pattern: '\\S' });
// Single contract used by both the provider instruction and the local parser.
const GROUNDED_OUTPUT_SCHEMA = deepFreeze({ type: 'object', additionalProperties: false,
  required: ['observations', 'limitations'], properties: {
    observations: { type: 'array', minItems: 1, maxItems: 3, items: {
      type: 'object', additionalProperties: false,
      required: ['evidenceRefs', 'interpretation', 'advisoryRecommendation'], properties: {
        evidenceRefs: { type: 'array', minItems: 1, maxItems: 4, uniqueItems: true, items: text(16) },
        interpretation: text(900), advisoryRecommendation: text(900)
      } } },
    limitations: { type: 'array', maxItems: 2, uniqueItems: true, items: { ...text(240),
      description: 'Only codes explicitly listed in context.allowedLimitations; otherwise return [].' } }
  } });
const MAX_OUTPUT_TEXT = 2160;
const SCHEMA_REASONS = Object.freeze(['JSON_PARSE_FAILED', 'REQUIRED_FIELD_MISSING', 'WRONG_TYPE',
  'TOO_MANY_RECOMMENDATIONS', 'FIELD_TOO_LONG', 'UNKNOWN_FIELD', 'EMPTY_RECOMMENDATIONS',
  'TOO_MANY_ITEMS', 'EMPTY_ARRAY', 'EMPTY_TEXT', 'DUPLICATE_ITEMS']);
const parseGroundedSchema = input => {
  const fail = (schemaReason, schemaField, legacyReason = 'OUTPUT_SCHEMA_INVALID') => {
    throw Object.assign(new Error('GROUNDED_INVALID_RESPONSE'), { validationReason: legacyReason,
      schemaReason, schemaField, validationLayer: 'SCHEMA' });
  };
  let output;
  if (typeof input !== 'string') fail('WRONG_TYPE', '$');
  const trimmed = input.trim();
  // Only a single whole-response fence is accepted; never extract embedded JSON.
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  try { output = JSON.parse(fenced ? fenced[1] : trimmed); }
  catch { fail('JSON_PARSE_FAILED', '$', 'CONTENT_JSON_INVALID'); }
  let textLength = 0;
  const check = (value, schema, path) => {
    if (schema.type === 'object') {
      if (!isPlainObject(value)) fail('WRONG_TYPE', path);
      for (const key of schema.required) if (!Object.hasOwn(value, key)) fail('REQUIRED_FIELD_MISSING', path === '$' ? key : `${path}.${key}`);
      // Do not echo arbitrary provider-generated property names in diagnostics.
      if (Object.keys(value).some(key => !Object.hasOwn(schema.properties, key))) fail('UNKNOWN_FIELD', path);
      for (const [key, item] of Object.entries(value)) check(item, schema.properties[key], path === '$' ? key : `${path}.${key}`);
    } else if (schema.type === 'array') {
      if (!Array.isArray(value)) fail('WRONG_TYPE', path);
      if (value.length < (schema.minItems || 0)) fail(path === 'observations' ? 'EMPTY_RECOMMENDATIONS' : 'EMPTY_ARRAY', path);
      if (value.length > schema.maxItems) fail(path === 'observations' ? 'TOO_MANY_RECOMMENDATIONS' : 'TOO_MANY_ITEMS', path);
      if (schema.uniqueItems && new Set(value).size !== value.length) fail('DUPLICATE_ITEMS', path);
      value.forEach((item, index) => check(item, schema.items, `${path}[${index}]`));
    } else {
      if (typeof value !== 'string') fail('WRONG_TYPE', path);
      if (!value.trim()) fail('EMPTY_TEXT', path);
      if (value.length > schema.maxLength) fail('FIELD_TOO_LONG', path, 'OUTPUT_TEXT_TOO_LONG');
      if (/\.(?:interpretation|advisoryRecommendation)$/.test(path)) textLength += value.length;
      if (textLength > MAX_OUTPUT_TEXT) fail('FIELD_TOO_LONG', path, 'OUTPUT_TEXT_TOO_LONG');
    }
  };
  check(output, GROUNDED_OUTPUT_SCHEMA, '$');
  return output;
};
module.exports = { GROUNDED_OUTPUT_SCHEMA, MAX_OUTPUT_TEXT, SCHEMA_REASONS, parseGroundedSchema };
