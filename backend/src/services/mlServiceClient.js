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
  const post = async (path, payload, signal, v3 = false) => {
    if (!serviceUrl || !serviceSecret || typeof fetchImpl !== 'function') {
      throw new MlServiceUnavailableError();
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(
        `${serviceUrl.replace(/\/+$/, '')}${path}`,
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

      if (!response.ok) {
        if (v3) {
          const body = await response.json().catch(() => null);
          const allowed = ['PRODUCT_NOT_FOUND', 'CUSTOMER_NOT_FOUND', 'SUPPLIER_NOT_FOUND', 'AMBIGUOUS_ENTITY', 'INVALID_PERIOD', 'UNSUPPORTED_HORIZON', 'INSUFFICIENT_HISTORY', 'ARTIFACT_UNAVAILABLE', 'SCENARIO_NOT_SUPPORTED', 'TENANT_MISMATCH'];
          const code = body?.code || body?.error?.code || body?.detail?.code;
          if (allowed.includes(code)) { const error = new MlServiceUnavailableError(); error.functionalCode = code; throw error; }
        }
        throw new MlServiceUnavailableError();
      }
      const body = await response.json();
      if (v3) return body;
      if (
        !body || !Array.isArray(body.results)
        || body.results.some(result => (
          !result || typeof result !== 'object' || Array.isArray(result)
          || typeof result.productId !== 'string' || !result.productId
          || typeof result.sku !== 'string' || !result.sku
          || typeof result.status !== 'string' || !result.status
        ))
      ) throw new MlServiceUnavailableError();
      return body;
    } catch (error) {
      if (error instanceof MlServiceUnavailableError) throw error;
      throw new MlServiceUnavailableError();
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  };

  const predictDemand = payload => post('/v1/predict/demand', payload);
  const intelligence = (domain, payload, { signal } = {}) => {
    if (!['business', 'inventory', 'forecast', 'cross-sell', 'customers', 'suppliers', 'health'].includes(domain)) throw new MlServiceUnavailableError();
    return post(`/v3/intelligence/${domain}`, payload, signal, true);
  };
  return { predictDemand, intelligence };
};

module.exports = {
  DEFAULT_TIMEOUT_MS,
  MlServiceUnavailableError,
  createMlServiceClient
};
