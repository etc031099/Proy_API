const test = require('node:test');
const assert = require('node:assert/strict');

const { MAX_SAFE_NUMERIC_VALUE, toFiniteNumber } = require('../src/utils/numbers');

test('toFiniteNumber converts numeric strings before arithmetic', () => {
  const value = toFiniteNumber('2', { field: 'Quantity', min: 0, integer: true });

  assert.equal(value, 2);
  assert.equal(5 + value, 7);
});

test('toFiniteNumber rejects arrays, objects and other non-scalar values', () => {
  const coercibleObject = {
    valueOf: () => 5,
    toString: () => '5'
  };
  const invalidValues = [[], [5], [5, 6], {}, coercibleObject, true, false];

  for (const value of invalidValues) {
    assert.throws(
      () => toFiniteNumber(value, { field: 'Value', min: 0 }),
      (error) => error.code === 'INVALID_NUMBER' && error.statusCode === 400
    );
  }
});

test('toFiniteNumber rejects missing, blank, non-finite and unsafe values', () => {
  for (const value of [NaN, Infinity, -Infinity, '', ' ', null, undefined]) {
    assert.throws(
      () => toFiniteNumber(value, { field: 'Value', min: 0 }),
      (error) => error.code === 'INVALID_NUMBER' && error.statusCode === 400
    );
  }

  assert.throws(() => toFiniteNumber(-1, { field: 'Stock', min: 0 }));
  assert.throws(() => toFiniteNumber('1.5', { field: 'Quantity', min: 0, integer: true }));
  assert.throws(() => toFiniteNumber(MAX_SAFE_NUMERIC_VALUE + 1, {
    field: 'Quantity', min: 0, integer: true
  }));
});

test('toFiniteNumber preserves null only when nullable is explicit', () => {
  assert.equal(toFiniteNumber(null, { field: 'Coordinate', nullable: true }), null);
  assert.throws(() => toFiniteNumber(null, { field: 'Coordinate' }));
});

test('toFiniteNumber accepts negative results when the caller domain allows them', () => {
  assert.equal(toFiniteNumber(-25.5, { field: 'Resulting balance' }), -25.5);
});

test('toFiniteNumber rejects invalid arithmetic results without changing negative-balance policy', () => {
  assert.throws(() => toFiniteNumber(Infinity, { field: 'Resulting balance' }));
  assert.throws(() => toFiniteNumber(NaN, { field: 'Resulting balance' }));
  assert.throws(() => toFiniteNumber(MAX_SAFE_NUMERIC_VALUE + 1, {
    field: 'Resulting balance'
  }));
  assert.equal(toFiniteNumber(-10, { field: 'Resulting balance' }), -10);
});
