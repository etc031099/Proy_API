'use strict';

const path = require('node:path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const models = require('../src/models');
const { assertLocalMongoUri, buildLocalDockerUri, DEFAULT_DATASET, importPackage, SCENARIO_ID } = require('./lib/minimarketV3Mongo');

function readFlag(args, name) { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; }

async function main() {
  const args = process.argv.slice(2);
  if (!args.includes('--local-docker')) throw new Error('Uso: npm run v3:import -- --local-docker [--reset --scenario-id minimarket-pasco-v3].');
  const scenarioId = readFlag(args, '--scenario-id') || SCENARIO_ID;
  if (args.includes('--reset') && scenarioId !== SCENARIO_ID) throw new Error('Reset abortado: debe declarar --scenario-id minimarket-pasco-v3.');
  const directory = readFlag(args, '--directory') || DEFAULT_DATASET;
  dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });
  const uri = assertLocalMongoUri(buildLocalDockerUri(process.env.MONGODB_URI_DOCKER || ''));
  await mongoose.connect(uri.toString(), { serverSelectionTimeoutMS: 7000, autoIndex: false });
  try {
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    if (mongoose.connection.host !== '127.0.0.1' || mongoose.connection.name !== 'inventory_billing'
        || !hello.isWritablePrimary || !hello.setName) throw new Error('Guard M6.4: Mongo no está conectado al PRIMARY local esperado.');
    for (const model of [models.Product, models.Contact, models.Transaction, models.InventoryMovement, models.HistoricalScenario, models.MinimarketV3Record]) {
      await model.createIndexes();
    }
    const result = await importPackage({ directory, reset: args.includes('--reset'), scenarioId });
    console.log(JSON.stringify({ status: 'PASS', environment: 'LOCAL_DOCKER_ONLY', database: mongoose.connection.name, primary: true, ...result }, null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
