const DEFAULT_TIMEOUT_MS = 10000;

class MlServiceUnavailableError extends Error {
  constructor(message = 'ML service is unavailable') {
    super(message);
    this.name = 'MlServiceUnavailableError';
    this.code = 'ML_SERVICE_UNAVAILABLE';
  }
}

const createMlServiceClient = ({
  serviceUrl = process.env.ML_SERVICE_URL,
  serviceSecret = process.env.ML_SERVICE_SECRET,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = global.fetch
} = {}) => {
  const predictDemand = async payload => {
    if (!serviceUrl || !serviceSecret || typeof fetchImpl !== 'function') {
      throw new MlServiceUnavailableError();
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(
        `${serviceUrl.replace(/\/+$/, '')}/v1/predict/demand`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-ML-Service-Secret': serviceSecret
          },
          body: JSON.stringify(payload),
          signal: controller.signal
        }
      );

      if (!response.ok) throw new MlServiceUnavailableError();
      const body = await response.json();
      if (!body || !Array.isArray(body.results)) throw new MlServiceUnavailableError();
      return body;
    } catch (error) {
      if (error instanceof MlServiceUnavailableError) throw error;
      throw new MlServiceUnavailableError();
    } finally {
      clearTimeout(timeout);
    }
  };

  return { predictDemand };
};

module.exports = {
  DEFAULT_TIMEOUT_MS,
  MlServiceUnavailableError,
  createMlServiceClient
};
