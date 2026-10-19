'use strict';

const certificate = require('../evidence/forecast-replay/cert-stable-2020.json');

function getCertifiedStable2020Replay() {
  // Return a detached value so route consumers cannot mutate the module cache.
  return JSON.parse(JSON.stringify(certificate));
}

module.exports = {
  getCertifiedStable2020Replay,
};
