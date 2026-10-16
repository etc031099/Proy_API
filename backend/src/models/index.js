const User = require('./User');
const Product = require('./Product');
const Contact = require('./Contact');
const Transaction = require('./Transaction');
const TelegramConnection = require('./TelegramConnection');
const CreditPayment = require('./CreditPayment');
const InventoryMovement = require('./InventoryMovement');
const HistoricalScenario = require('./HistoricalScenario');
const MinimarketV3Record = require('./MinimarketV3Record');
const V3OperationalRevision = require('./V3OperationalRevision');
const V3OperationalChange = require('./V3OperationalChange');
const ForecastModelArtifact = require('./ForecastModelArtifact');
const ForecastModelRegistry = require('./ForecastModelRegistry');

module.exports = {
  User,
  Product,
  Contact,
  Transaction,
  TelegramConnection,
  CreditPayment,
  InventoryMovement,
  HistoricalScenario,
  MinimarketV3Record,
  V3OperationalRevision,
  V3OperationalChange,
  ForecastModelArtifact,
  ForecastModelRegistry
};
