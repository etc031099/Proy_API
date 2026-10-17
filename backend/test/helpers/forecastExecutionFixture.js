'use strict';
const Model = require('../../src/models/ForecastMlUpdateExecution');
const { createForecastMlUpdateExecutionService } = require('../../src/services/forecastMlUpdateExecutionService');
const nested = (object, key) => key.split('.').reduce((value, part) => value?.[part], object);
const matches = (row, filter) => Object.entries(filter).every(([key, value]) => nested(row, key) === value);

function fixture() {
  const rows = [], counts = { reads: 0, writes: 0 }, filters = [];
  const uniqueIndexes = Model.schema.indexes().filter(([, options]) => options.unique);
  const repository = {
    withSession: () => repository,
    async find(filter) { counts.reads++; filters.push(filter); return structuredClone(rows.find(row => matches(row, filter)) || null); },
    async insert(row) {
      await new Model(row).validate();
      for (const [keys, options] of uniqueIndexes) {
        if (options.partialFilterExpression && !Object.keys(options.partialFilterExpression).every(key => typeof nested(row, key) === 'string')) continue;
        if (rows.some(other => Object.keys(keys).every(key => nested(row, key) === nested(other, key)))) {
          throw Object.assign(new Error('duplicate'), { code: 11000 });
        }
      }
      rows.push(structuredClone(row)); counts.writes++; return structuredClone(row);
    },
    async replace(scope, executionId, writeVersion, values) {
      const filter = { ...scope, executionId, writeVersion }; filters.push(filter);
      const index = rows.findIndex(row => matches(row, filter));
      if (index < 0) return null;
      const next = { ...structuredClone(rows[index]), writeVersion: writeVersion + 1 };
      for (const [key, value] of Object.entries(values)) {
        if (key.startsWith('github.')) { next.github ||= {}; next.github[key.slice(7)] = value; }
        else next[key] = structuredClone(value);
      }
      await new Model(next).validate();
      if (rows[index].writeVersion !== writeVersion) return null;
      rows[index] = next; counts.writes++; return structuredClone(next);
    },
  };
  const service = createForecastMlUpdateExecutionService({ repository, clock: () => new Date('2026-10-17T18:00:00Z') });
  return { service, repository, rows, counts, filters };
}
module.exports = { fixture };
