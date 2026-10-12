#!/usr/bin/env node
require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');

const MARKERS = [
  { name: 'latin1-lead-sequence', pattern: /\u00c3[\u0080-\u00ff]/u },
  { name: 'latin1-space-sequence', pattern: /\u00c2[\u0080-\u00bf]/u },
  { name: 'smart-punctuation-sequence', pattern: /\u00e2\u20ac[\u2122\u0153\u009d\u201c-\u201d\u2013\u2014]/u },
  { name: 'replacement-character-sequence', pattern: /\u00ef\u00bf\u00bd/u },
  { name: 'double-encoding-sequence', pattern: /\u00c3\u0192\u00c2/u },
  { name: 'unicode-replacement-character', pattern: /\ufffd/u }
];
const SENSITIVE_FIELD = /password|secret|token|credential|authorization|cookie|email|phone|address|documentnumber|hash/i;
const args = Object.fromEntries(process.argv.slice(2).map(value => {
  const [key, ...rest] = value.replace(/^--/, '').split('=');
  return [key, rest.join('=') || true];
}));
const maxDocuments = Number(args['max-documents'] || 100000);

const visit = (value, path, matches) => {
  if (typeof value === 'string') {
    const marker = MARKERS.find(candidate => candidate.pattern.test(value));
    if (marker) matches.push({ path, marker: marker.name });
    return;
  }
  if (!value || typeof value !== 'object' || value._bsontype || Buffer.isBuffer(value) || value instanceof Date) return;
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_FIELD.test(key)) continue;
    visit(child, path ? `${path}.${key}` : key, matches);
  }
};

const main = async () => {
  if (args['confirm-read-only'] !== true) {
    throw new Error('This scanner only performs reads. Pass --confirm-read-only to scan the database configured in MONGODB_URI.');
  }
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required; its value is never printed.');
  if (!Number.isSafeInteger(maxDocuments) || maxDocuments < 1 || maxDocuments > 1000000) {
    throw new Error('--max-documents must be an integer from 1 to 1000000');
  }

  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
    readPreference: 'secondaryPreferred'
  });
  const db = mongoose.connection.db;
  const collections = (await db.listCollections({}, { nameOnly: true }).toArray())
    .map(collection => collection.name)
    .filter(name => !name.startsWith('system.'))
    .sort();
  const results = [];

  for (const collectionName of collections) {
    const cursor = db.collection(collectionName).find({}, { projection: {} }).batchSize(100);
    const counts = new Map();
    let scannedDocuments = 0;
    while (scannedDocuments < maxDocuments && await cursor.hasNext()) {
      const document = await cursor.next();
      scannedDocuments += 1;
      const matches = [];
      visit(document, '', matches);
      const fieldsInDocument = new Set();
      for (const match of matches) {
        const key = `${match.path}\u0000${match.marker}`;
        fieldsInDocument.add(key);
        if (!counts.has(key)) counts.set(key, { field: match.path, marker: match.marker, documents: 0 });
      }
      for (const key of fieldsInDocument) counts.get(key).documents += 1;
    }
    const truncated = scannedDocuments === maxDocuments && await cursor.hasNext();
    await cursor.close();
    results.push({
      collection: collectionName,
      scannedDocuments,
      complete: !truncated,
      suspectedFields: [...counts.values()].map(entry => ({ ...entry, example: '[valor omitido]' }))
    });
  }

  console.log(JSON.stringify({ readOnly: true, sensitiveValuesPrinted: false, collections: results }, null, 2));
};

main()
  .catch(error => {
    console.error(JSON.stringify({ readOnly: true, error: error.name || 'AuditError' }));
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
