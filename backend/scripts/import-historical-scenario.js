#!/usr/bin/env node
require('dotenv').config();
const mongoose = require('mongoose');
const { importHistoricalScenario } = require('./lib/historicalScenario');

const args = Object.fromEntries(process.argv.slice(2).map(argument => {
  const [key, ...value] = argument.replace(/^--/, '').split('=');
  return [key, value.join('=')];
}));

const main = async () => {
  if (!args.file || !args['business-id'] || !args['scenario-id']) {
    throw new Error('Usage: --file=events.ndjson --business-id=TENANT --scenario-id=SCENARIO [--batch-size=500]');
  }
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
  await mongoose.connect(process.env.MONGODB_URI);
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  if (!hello.setName || !hello.isWritablePrimary) {
    throw new Error('A writable MongoDB replica-set PRIMARY is required');
  }
  const result = await importHistoricalScenario({
    filePath: args.file,
    businessId: args['business-id'],
    scenarioId: args['scenario-id'],
    batchSize: Number(args['batch-size'] || 500)
  });
  console.log(JSON.stringify(result, null, 2));
};

main()
  .catch(error => { console.error(error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
