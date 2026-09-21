const mongoose = require('mongoose');

const historicalScenarioSchema = new mongoose.Schema({
  businessId: { type: String, required: true, trim: true },
  scenarioId: { type: String, required: true, trim: true },
  sourceSha256: { type: String, required: true },
  status: { type: String, enum: ['importing', 'completed', 'failed'], required: true },
  importedRecords: { type: Number, default: 0, min: 0 },
  failureMessage: { type: String, default: null }
}, { timestamps: true });

historicalScenarioSchema.index(
  { businessId: 1, scenarioId: 1 },
  { unique: true, name: 'businessId_1_scenarioId_1' }
);

module.exports = mongoose.model('HistoricalScenario', historicalScenarioSchema);
