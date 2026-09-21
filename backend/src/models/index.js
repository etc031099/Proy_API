const User = require('./User');
const Product = require('./Product');
const Contact = require('./Contact');
const Transaction = require('./Transaction');
const TelegramConnection = require('./TelegramConnection');
const CreditPayment = require('./CreditPayment');
const InventoryMovement = require('./InventoryMovement');
const HistoricalScenario = require('./HistoricalScenario');

module.exports = {
  User,
  Product,
  Contact,
  Transaction,
  TelegramConnection,
  CreditPayment,
  InventoryMovement,
  HistoricalScenario
};
