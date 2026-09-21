#!/usr/bin/env node
require('dotenv').config();
const mongoose = require('mongoose');
const { resetHistoricalScenario } = require('./lib/historicalScenario');

const args = Object.fromEntries(process.argv.slice(2).map(argument => {
  const [key, ...value] = argument.replace(/^--/, '').split('=');
  return [key, value.join('=') || true];
}));

const main = async () => {
  if (!args['business-id'] || !args['scenario-id'] || args.confirm !== true) {
    throw new Error('Usage: --business-id=TENANT --scenario-id=SCENARIO --confirm');
  }
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
  await mongoose.connect(process.env.MONGODB_URI);
  const result = await resetHistoricalScenario({
    businessId: args['business-id'],
    scenarioId: args['scenario-id']
  });
  console.log(JSON.stringify(result, null, 2));
};

main()
  .catch(error => { console.error(error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
