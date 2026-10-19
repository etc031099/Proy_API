'use strict';

const mongoose = require('mongoose');
const config = require('../config/v3Operational');
const { ForecastMlUpdateState } = require('../models');
const { createForecastRidgeTrainingWorker } = require('./forecastRidgeTrainingWorker');
const { createForecastModelRegistryService } = require('./forecastModelRegistryService');
const fence = require('./mlTestFence');
const targetAuthorization = require('./mlTestTargetAuthorization');
const access = require('./mlTestAccess');
const { drainInCapturedEpoch } = require('./mlTestLocalRidgeDrain');

const SAFE_CODE = /^[A-Z][A-Z0-9_:-]{0,119}$/;
const fail = (code, httpStatus = 409) => { throw Object.assign(new Error(code), { code, httpStatus }); };

function modelSummary(model) {
  if (!model) return null;
  return {
    modelVersion: Number.isSafeInteger(model.modelVersion) ? model.modelVersion : null,
    trainedDataVersion: model.trainedDataVersion == null ? null : String(model.trainedDataVersion),
    dataCutoff: typeof model.dataCutoff === 'string' ? model.dataCutoff : null
  };
}

function messageFor(outcome) {
  switch (outcome) {
    case 'NOT_MATURE': return 'La evidencia del escenario aún debe completar su período de madurez.';
    case 'DEBOUNCE_NOT_ELAPSED': return 'Los cambios recientes se están agrupando antes de la evaluación.';
    case 'COOLDOWN_ACTIVE': return 'La evaluación se pospuso por el intervalo de seguridad vigente.';
    case 'NO_PENDING_WORK': return 'La revisión terminó: no había trabajo pendiente.';
    case 'PREVIOUS_FAILURE_NOT_RETRYABLE': return 'La evaluación previa requiere atención antes de reintentarse.';
    case 'LEASE_ACTIVE': return 'Ya hay una evaluación de este horizonte en curso.';
    case 'NO_PROMOTION_INSUFFICIENT_HISTORY': return 'La evaluación terminó sin promoción porque la evidencia histórica fue insuficiente.';
    case 'PROMOTED': return 'La política aprobó la promoción y el modelo activo cambió.';
    case 'REJECTED': return 'La evaluación se completó; la política rechazó el candidato y se conservó el modelo activo.';
    default: return 'La revisión local terminó con el resultado indicado.';
  }
}

function createMlTestLocalRidgeAnalysis({ env = process.env, client = mongoose.connection.getClient(),
  db = mongoose.connection.db, target = targetAuthorization, adminAccess = access, epochFence = fence,
  workerFactory = createForecastRidgeTrainingWorker,
  registry = createForecastModelRegistryService(), State = ForecastMlUpdateState,
  drain = drainInCapturedEpoch, now = () => new Date() } = {}) {
  return {
    async execute({ user, horizonDays }) {
      if (![7, 14].includes(horizonDays)) fail('ML_TEST_HORIZON_INVALID', 400);
      adminAccess.authorizeAdminAction(user, {}, {});
      const authorization = await target.authorizeLocalTarget({ client, db, user, env });
      if (!target.authorized(client, db, authorization)) fail('ML_TEST_LOCAL_TARGET_INVALID', 503);

      const control = await db.collection('mltestcontrols').findOne({ businessId: config.businessId }, { promoteLongs: false });
      const token = await epochFence.capture(db);
      if (!control || token.state !== 'TEST_ACTIVE' || token.resetEpoch === '0'
          || !token.testCycleId || control.state !== 'TEST_ACTIVE'
          || String(control.resetEpoch) !== token.resetEpoch || control.testCycleId !== token.testCycleId
          || !/^[a-f0-9-]{36}$/.test(control.activeCheckpointId || '')) fail('ML_TEST_CYCLE_NOT_ACTIVE');
      const checkpointId = control.activeCheckpointId;
      const checkpoint = await db.collection('mltestcheckpoints').findOne({ checkpointId,
        businessId: config.businessId, scenarioId: config.scenarioId }, { projection: { status: 1 } });
      if (checkpoint?.status !== 'READY') fail('ML_TEST_CHECKPOINT_NOT_READY');

      const scope = { businessId: config.businessId, scenarioId: config.scenarioId, horizonDays };
      const before = modelSummary(await registry.getActiveModelMetadata(scope));
      const worker = workerFactory();
      const outcome = await drain({ db, worker, horizonDays, token, fence: epochFence,
        readState: days => State.findOne({ businessId: config.businessId, scenarioId: config.scenarioId,
          horizonDays: days }).lean(),
        precondition: async expected => {
          await epochFence.assertCurrent(db, expected);
          const current = await db.collection('mltestcontrols').findOne({ businessId: config.businessId }, { promoteLongs: false });
          const currentCheckpoint = current?.activeCheckpointId === checkpointId
            ? await db.collection('mltestcheckpoints').findOne({ checkpointId,
              businessId: config.businessId, scenarioId: config.scenarioId }, { projection: { status: 1 } }) : null;
          if (current?.state !== 'TEST_ACTIVE' || current.activeCheckpointId !== checkpointId
              || currentCheckpoint?.status !== 'READY') fail('ML_TEST_CYCLE_NOT_ACTIVE');
        }, now });
      const result = outcome.result;
      const after = modelSummary(await registry.getActiveModelMetadata(scope));
      const promoted = Boolean(result?.status === 'PROMOTED' && after?.modelVersion != null
        && before?.modelVersion !== after.modelVersion);
      const rawOutcome = result?.status || outcome.evaluation || 'WORKER_RESULT_UNAVAILABLE';
      const safeOutcome = SAFE_CODE.test(rawOutcome) ? rawOutcome : 'WORKER_RESULT_UNAVAILABLE';
      const rawReason = outcome.evaluation || result?.reasonCode || result?.failureCode || null;
      const reasonCode = typeof rawReason === 'string' && SAFE_CODE.test(rawReason) ? rawReason : null;
      return {
        horizonDays, testCycleId: token.testCycleId, resetEpoch: token.resetEpoch,
        outcome: safeOutcome,
        trained: result?.trained === true,
        candidateCreated: result?.candidateCreated === true,
        promoted,
        reasonCode,
        requiredOrigins: 107,
        availableOrigins: Number.isSafeInteger(result?.availableOrigins) && result.availableOrigins >= 0
          ? result.availableOrigins : null,
        activeModelBefore: before,
        activeModelAfter: after,
        message: messageFor(safeOutcome)
      };
    }
  };
}

module.exports = { createMlTestLocalRidgeAnalysis, modelSummary, messageFor };
