const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

test('JSON responses preserve UTF-8 text and declare the JSON content type', async () => {
  const app = express();
  app.get('/unicode', (req, res) => res.json({
    period: 'período',
    information: 'información',
    configuration: 'configuración',
    forecast: 'predicción',
    transaction: 'transacción',
    notification: 'notificación',
    latest: 'último',
    item: 'ítem',
    child: 'niño',
    year: 'año',
    signal: 'señal',
    person: 'José',
    amount: 'S/ 17.61',
    questions: '¿Qué?',
    exclamation: '¡Listo!'
  }));
  const server = app.listen(0, '127.0.0.1');

  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/unicode`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /^application\/json; charset=utf-8$/i);
    const body = await response.json();
    assert.equal(body.period, 'período');
    assert.equal(body.information, 'información');
    assert.equal(body.item, 'ítem');
    assert.equal(body.person, 'José');
    assert.equal(body.questions, '¿Qué?');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
