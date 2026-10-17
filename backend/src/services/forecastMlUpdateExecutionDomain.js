'use strict';

// Audit vocabulary only: this module never imports the training pipeline.
const STATUSES = Object.freeze(['REQUESTED', 'PENDING', 'RUNNING', 'DEFERRED', 'NOT_ELIGIBLE',
  'EVALUATED_NO_PROMOTION', 'PROMOTED', 'PARTIAL', 'FAILED', 'INTERRUPTED', 'NO_PENDING_WORK']);
const TERMINAL = Object.freeze(['NOT_ELIGIBLE', 'EVALUATED_NO_PROMOTION', 'PROMOTED',
  'PARTIAL', 'FAILED', 'INTERRUPTED', 'NO_PENDING_WORK']);
const TRANSITIONS = Object.freeze({
  REQUESTED: ['PENDING', 'RUNNING', 'DEFERRED', 'FAILED', 'INTERRUPTED'],
  PENDING: ['RUNNING', 'DEFERRED', 'FAILED', 'INTERRUPTED'],
  DEFERRED: ['PENDING', 'RUNNING', 'FAILED', 'INTERRUPTED'],
  RUNNING: [...TERMINAL],
});
const IMPACT_STATUSES = Object.freeze(['NOT_APPLICABLE', 'PENDING', 'COMPLETE', 'PARTIAL', 'NOT_CAPTURED']);
const STAGES = Object.freeze(['REQUEST', 'PREFLIGHT', 'ELIGIBILITY', 'TRAINING', 'EVALUATION', 'PROMOTION', 'FINISHED']);
const REASONS = Object.freeze({
  ML_UPDATE_REQUESTED: 'Solicitud de evaluación registrada.',
  NO_PENDING_WORK: 'Se revisó el estado; no había trabajo pendiente.',
  DEBOUNCE_NOT_ELAPSED: 'La señal se conserva mientras termina el período de agrupación.',
  NOT_MATURE: 'Los datos aún no tienen la madurez requerida.',
  COOLDOWN_ACTIVE: 'La actualización espera el intervalo mínimo entre evaluaciones.',
  LEASE_ACTIVE: 'Otro intento conserva la ejecución en curso.',
  ELIGIBLE: 'La ejecución cumple los requisitos de elegibilidad.',
  PREVIOUS_FAILURE_NOT_RETRYABLE: 'El fallo anterior requiere nueva evidencia o revisión técnica.',
  NO_PROMOTION_INSUFFICIENT_HISTORY: 'No existe suficiente evidencia madura para una nueva promoción.',
  POLICY_FAILED: 'El candidato no superó la política de promoción.',
  PROMOTION_POLICY_FAILED: 'El candidato no superó la política de promoción.',
  REJECTED: 'El candidato fue evaluado y no se promovió.',
  PROMOTED: 'Se confirmó una nueva versión activa.',
  PARTIAL_HORIZON_RESULT: 'Los horizontes terminaron con resultados diferentes o incompletos.',
  TRAINING_FAILED: 'El intento falló; consulta el estado por horizonte.',
  TRAINING_TIMEOUT: 'El intento excedió su tiempo permitido.',
  STALE_FENCING_TOKEN: 'El intento perdió la autoridad para completar la operación.',
  REGISTRY_CAS_CONFLICT: 'El registro cambió durante la operación.',
  ACK_PENDING: 'El resultado existe y su confirmación está pendiente.',
  WORKER_FAILED: 'La ejecución encontró un fallo técnico.',
  WORKER_CYCLE_TIMEOUT: 'La ejecución excedió su tiempo permitido.',
  EXECUTION_INTERRUPTED: 'La ejecución se interrumpió antes de completar el ciclo.',
  IMPACT_NOT_CAPTURED: 'No se capturó una comparación atribuible al modelo.',
  NO_MODEL_PROMOTION: 'No hubo promoción de modelo para comparar.',
  UNKNOWN_REASON: 'El detalle técnico no está disponible en el catálogo seguro.',
  DISPATCH_DEFERRED: 'La solicitud está guardada; el disparo del worker quedó diferido.',
  CLAIM_NOT_ACQUIRED: 'Otro worker adquirió el trabajo antes de este intento.',
  PREFLIGHT_FAILED: 'El diagnóstico previo impidió continuar la ejecución.',
  REUSED_TRAINING_RESULT: 'Se recuperó un resultado durable anterior; no hubo una nueva promoción en este intento.',
});
const MAX_ATTEMPTS = 20;
const REQUIRED_ORIGINS = 107;
const POLICY_VERSION = 'M6.10A22-PROMOTION-v1';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const safeReason = value => value == null ? null
  : Object.hasOwn(REASONS, value) ? value : 'UNKNOWN_REASON';
const safeMessage = reason => reason == null ? null : REASONS[safeReason(reason)];
const validRevision = value => typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)
  && value.length <= 19 && BigInt(value) <= 9223372036854775807n;
const validDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

module.exports = { STATUSES, TERMINAL, TRANSITIONS, IMPACT_STATUSES, STAGES, REASONS,
  MAX_ATTEMPTS, REQUIRED_ORIGINS, POLICY_VERSION, fail, safeReason, safeMessage, validRevision, validDay };
