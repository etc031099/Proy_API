const { AgentError } = require('./contracts');
const { performance } = require('node:perf_hooks');
const { AGENT_ML_HTTP_TIMEOUT_MS } = require('./timeouts');

const escapeLiteral = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const productFields = { _id: 1, sku: 1, name: 1, category: 1, stock: 1, minStockLevel: 1 };
const productDto = row => ({
  id: String(row._id), sku: row.sku ?? null, name: row.name, category: row.category,
  stock: row.stock, minStockLevel: row.minStockLevel ?? 0
});
// Date arguments are inclusive UTC calendar days, including the entire end day.
const dateFilter = args => args.startDate ? {
  $gte: new Date(`${args.startDate}T00:00:00.000Z`),
  $lt: new Date(new Date(`${args.endDate}T00:00:00.000Z`).getTime() + 86400000)
} : undefined;
const listResult = (data, totalMatches, metadata = {}) => ({
  status: data.length ? 'READY' : 'NO_DATA', data,
  metadata: { ...metadata, totalMatches, returnedCount: data.length, truncated: totalMatches > data.length }
});

const createAgentForecastService = ({ createService, createMlClient } = {}) => {
  const serviceFactory = createService || require('../services/demandForecastService').createDemandForecastService;
  const mlClientFactory = createMlClient || require('../services/mlServiceClient').createMlServiceClient;
  return serviceFactory({ mlClient: mlClientFactory({ timeoutMs: AGENT_ML_HTTP_TIMEOUT_MS }) });
};

/** Trusted dependency injection for tests; arguments never select a model or query.
 * Each execution owns this factory, so forecast promises are only shared within
 * one authenticated request. Failed/timed-out calls are not cached globally.
 */
const createSkillExecutors = ({ models, forecastService, clock = () => new Date(), toObjectId } = {}) => {
  let readModels = models;
  let forecast = forecastService;
  const forecastPromises = new Map();
  const getModels = () => readModels ||= require('../models');
  const objectId = value => toObjectId ? toObjectId(value) : new (require('mongoose').Types.ObjectId)(value);
  const asOf = () => clock().toISOString();
  const aggregate = (model, pipeline, invocation) => {
    invocation.signal.throwIfAborted();
    // Bound server-side work as well as the request-level wall-clock deadline.
    return model.aggregate(pipeline).option({ maxTimeMS: invocation.skill.timeoutMs }).exec();
  };
  const paged = async (model, stages, projection, sort, invocation, useOffset = false) => {
    const offset = invocation.args.offset || 0;
    const rows = await aggregate(model, [...stages, { $facet: {
      data: [{ $sort: sort }, ...(useOffset && offset ? [{ $skip: offset }] : []),
        { $limit: invocation.args.limit ?? invocation.skill.maxRecords }, { $project: projection }],
      count: [{ $count: 'total' }]
    } }], invocation);
    return { rows: rows[0]?.data || [], total: rows[0]?.count[0]?.total || 0 };
  };
  const financialRows = async (match, invocation) => aggregate(getModels().Transaction, [
    { $match: match },
    { $group: { _id: { type: '$type', currency: '$currency' }, count: { $sum: 1 },
      amount: { $sum: '$totalAmount' },
      units: { $sum: { $sum: '$products.quantity' } } } },
    { $sort: { '_id.type': 1, '_id.currency': 1 } }
  ], invocation);
  // Native transaction currencies stay separate. No FX conversion or profit claim.
  const financialDto = (rows, type) => {
    const selected = rows.filter(row => row._id.type === type);
    return {
      completedTransactionsCount: selected.reduce((sum, row) => sum + row.count, 0),
      totalUnits: selected.reduce((sum, row) => sum + row.units, 0),
      amountsByCurrency: selected.map(row => ({ currency: row._id.currency, amount: row.amount,
        label: type === 'sale' ? 'Ventas completadas' : 'Compras completadas' }))
    };
  };
  const readForecast = async invocation => {
    invocation.signal.throwIfAborted();
    const { args, context } = invocation;
    const key = `${context.businessId}\0${args.productId || 'batch'}`;
    if (!forecastPromises.has(key)) {
      forecast ||= createAgentForecastService();
      const pending = Promise.resolve().then(() => forecast.getDemandForecast({
        businessId: context.businessId, ...(args.productId ? { productId: args.productId } : {})
      }));
      forecastPromises.set(key, pending);
      pending.catch(() => forecastPromises.delete(key));
    }
    let result;
    const mlCallStartedAt = performance.now();
    try { result = await forecastPromises.get(key); } catch (error) {
      const mlCallDurationMs = performance.now() - mlCallStartedAt;
      if (error.code === 'PRODUCT_NOT_FOUND') throw new AgentError('AGENT_RESOURCE_NOT_FOUND');
      if (error.code === 'ML_NOT_READY') return { status: 'ML_NOT_READY' };
      if (error.code === 'AGENT_SKILL_TIMEOUT') {
        const safeError = new AgentError('AGENT_SKILL_TIMEOUT');
        safeError.diagnostic = Object.freeze({ internalCause: 'AGENT_SKILL_TIMEOUT', mlCallDurationMs });
        throw safeError;
      }
      const internalCause = error.code === 'ML_SERVICE_UNAVAILABLE' ? 'ML_SERVICE_UNAVAILABLE' : 'AGENT_EXECUTION_ERROR';
      const safeError = new AgentError(internalCause === 'ML_SERVICE_UNAVAILABLE'
        ? 'ML_SERVICE_UNAVAILABLE' : 'AGENT_SKILL_EXECUTION_FAILED');
      safeError.diagnostic = Object.freeze({ internalCause, mlCallDurationMs });
      throw safeError;
    }
    return result;
  };
  const forecastResult = (result, invocation, candidates = false) => {
    if (result.status === 'ML_NOT_READY') return {
      status: 'ML_NOT_READY', data: [], metadata: {
        asOf: asOf(), returnedCount: 0, totalMatches: 0, truncated: false,
        reason: 'Historial o configuración insuficiente para el replay ML'
      }
    };
    if (result.status !== 'READY' || !Array.isArray(result.products)
      || result.products.length > 60) throw new AgentError('AGENT_SKILL_EXECUTION_FAILED');
    const mapped = result.products.map(row => ({
      productId: row.productId, sku: row.sku, name: row.name, mlStatus: row.mlStatus,
      category: row.category ?? null, department: row.department ?? null,
      predictedDemand7d: row.mlStatus === 'READY' ? row.predictedDemand7d : null,
      stockAtAnchor: row.stockAtAnchor, salesLast7Days: row.salesLast7Days,
      safetyStock: row.mlStatus === 'READY' ? row.safetyStock : null,
      recommendedQty: row.mlStatus === 'READY' ? row.recommendedQty : null,
      inventoryStatus: row.inventoryStatus, anchor: result.anchorOperationalDate
    }));
    const selected = candidates ? mapped.filter(row => row.mlStatus === 'READY' && row.recommendedQty > 0)
      .sort((a, b) => b.recommendedQty - a.recommendedQty || a.productId.localeCompare(b.productId)) : mapped;
    const limit = invocation.args.limit ?? invocation.skill.maxRecords;
    return listResult(selected.slice(0, limit), selected.length, {
      asOf: result.anchorOperationalDate, anchor: result.anchorOperationalDate,
      interpretation: 'historical_replay',
      model: result.model ? { name: result.model.name, version: result.model.version,
        horizonDays: result.model.horizonDays } : undefined
    });
  };

  const loadCommercialRows = async invocation => {
    const batch = forecastResult(await readForecast({ ...invocation, args: {} }),
      { ...invocation, args: {}, skill: { ...invocation.skill, maxRecords: 60 } });
    if (batch.status === 'ML_NOT_READY') return batch;
    const { Product, Contact } = getModels();
    const skus = batch.data.map(row => row.sku).filter(Boolean);
    const products = await Product.find({ businessId: invocation.context.businessId, isActive: true, sku: { $in: skus } })
      .select('_id businessId sku name currency supplierPrices preferredSupplierId isActive')
      .maxTimeMS(invocation.skill.timeoutMs).lean().exec();
    const supplierIds = [...new Set(products.flatMap(row => (row.supplierPrices || []).map(offer => String(offer.supplierId)))
      .concat(products.map(row => row.preferredSupplierId && String(row.preferredSupplierId)).filter(Boolean)))];
    const validIds = supplierIds.filter(value => /^[a-f\d]{24}$/i.test(value)).map(objectId);
    const suppliers = validIds.length ? await Contact.find({ businessId: invocation.context.businessId,
      type: 'vendor', isActive: true, _id: { $in: validIds } }).select('_id businessId name type isActive')
      .maxTimeMS(invocation.skill.timeoutMs).lean().exec() : [];
    let supplierDirectory = suppliers;
    if (invocation.args.supplierRef) {
      supplierDirectory = await Contact.find({ businessId: invocation.context.businessId, type: 'vendor', isActive: true })
        .select('_id businessId name type isActive').limit(500).maxTimeMS(invocation.skill.timeoutMs).lean().exec();
    }
    const productBySku = new Map(products.map(row => [row.sku, row]));
    const rows = batch.data.map(row => {
      const product = productBySku.get(row.sku);
      return { ...row, ...(product ? { productId: String(product._id), currency: product.currency,
        supplierPrices: product.supplierPrices, preferredSupplierId: product.preferredSupplierId,
        businessId: product.businessId } : {}),
      productMissing: !product };
    });
    const { selectOffer } = require('./replenishmentPlanning');
    return { status: 'READY', rows, suppliers, supplierDirectory, metadata: batch.metadata };
  };

  const commercialProducts = async (invocation, productRef, department, productRefs) => {
    const loaded = await loadCommercialRows(invocation);
    if (loaded.status === 'ML_NOT_READY') return loaded;
    let rows = loaded.rows;
    if (department) rows = rows.filter(row => String(row.department || '').toLowerCase() === department.toLowerCase());
    if (productRefs) rows = rows.filter(row => productRefs.includes(row.sku));
    if (productRef) {
      const ranked = require('../automations/entityResolution').rankEntities(rows.map(row => ({ ...row,
        _id: row.productId || row.sku })), productRef);
      if (!ranked.value) return { status: 'CLARIFICATION', rows: [], suggestions: (ranked.candidates || []).slice(0, 5),
        metadata: { ...loaded.metadata, returnedCount: 0, totalMatches: ranked.pagination?.totalMatches || 0,
          clarificationQuestion: ranked.candidates?.length
            ? `Encontré varios productos parecidos a «${productRef}». Indica el SKU exacto.`
            : `No encontré «${productRef}» en el forecast de este negocio. Indica un SKU exacto.` } };
      rows = [rows.find(row => row.sku === ranked.value.sku)];
    }
    if (rows.some(row => row.mlStatus === 'READY' && (!Number.isSafeInteger(row.recommendedQty)
      || row.recommendedQty < 0 || !Number.isFinite(row.predictedDemand7d) || row.predictedDemand7d < 0
      || !Number.isFinite(row.stockAtAnchor) || row.stockAtAnchor < 0))) throw new AgentError('AGENT_SKILL_EXECUTION_FAILED');
    const { selectOffer, resolveSupplier } = require('./replenishmentPlanning');
    return { status: 'READY', rows: rows.map(row => {
      if (row.productMissing) return { ...row, exclusionReason: 'PRODUCT_NOT_CONFIGURED' };
      let supplierRef = invocation.args.supplierRef;
      let supplierMatch;
      if (supplierRef) {
        const availableOffers = row.offers || selectOffer(row, loaded.suppliers).offers;
        const resolution = resolveSupplier(supplierRef, availableOffers, loaded.supplierDirectory || loaded.suppliers);
        if (resolution.status !== 'MATCH') {
          const candidates = (resolution.status === 'AMBIGUOUS' || resolution.status === 'AMBIGUOUS_SUPPLIER'
            ? resolution.candidates : resolution.status === 'NO_OFFER' || resolution.status === 'NOT_FOUND' ? availableOffers : resolution.candidates)
            .slice(0, 20);
          const suggestions = candidates.slice(0, 5).map(offer => ({
            label: offer.supplierName || offer.name,
            message: offer.supplierName || offer.name,
            ...(offer.unitCost !== undefined ? { detail: `${offer.unitCost.toFixed(2)} PEN por unidad` } : {})
          }));
          const clarificationQuestion = resolution.status === 'NO_OFFER'
            ? `Encontré ${resolution.supplier.name}, pero no tiene una oferta configurada para ${row.sku}.${suggestions.length ? ' Estas son las ofertas disponibles:' : ''}`
            : resolution.status === 'AMBIGUOUS' || resolution.status === 'AMBIGUOUS_SUPPLIER'
              ? `No estoy seguro de cuál proveedor quisiste decir con «${supplierRef}». Elige una opción:`
              : `No encontré un proveedor suficientemente parecido a «${supplierRef}» para ${row.sku}.${suggestions.length ? ' Puedes elegir una oferta disponible:' : ' Puedes pedirme que muestre los proveedores disponibles para este producto.'}`;
          const resumeArgs = Object.fromEntries(Object.entries(invocation.args).filter(([key]) => key !== 'supplierRef'));
          return { ...row, supplierResolution: { status: resolution.status, supplierRef,
            skillId: invocation.skill.id, args: resumeArgs,
            query: supplierRef, offset: 0, candidates: candidates.map(offer => ({ id: String(offer.supplierId || offer._id),
              name: offer.supplierName || offer.name,
              ...(offer.unitCost !== undefined ? { detail: `${offer.unitCost.toFixed(2)} PEN por unidad` } : {}) })) },
          clarificationQuestion, suggestions };
        }
        supplierRef = resolution.offer.supplierId;
        supplierMatch = { requested: /^[a-f\d]{24}$/i.test(invocation.args.supplierRef) ? null : invocation.args.supplierRef,
          resolved: resolution.offer.supplierName,
          confidence: resolution.confidence };
      }
      const selected = selectOffer(row, loaded.suppliers, supplierRef);
      return { ...row, selected: selected.selected, offers: selected.offers,
        selectionRule: supplierMatch ? 'USER_SPECIFIED' : selected.selectionRule, supplierMatch,
        exclusionReason: row.currency !== 'PEN' ? 'UNSUPPORTED_CURRENCY'
          : selected.offers.length ? selected.selectionRule === 'USER_SPECIFIED_UNAVAILABLE' ? 'SUPPLIER_OFFER_UNAVAILABLE' : null
            : 'NO_USABLE_OFFER' };
    }), suppliers: loaded.suppliers, metadata: loaded.metadata };
  };

  return Object.freeze({
    async list_stock_alert_rules(invocation) {
      const { Product } = getModels();
      const Rule = getModels().StockAlertRule || require('../models/StockAlertRule');
      const { businessId } = invocation.context;
      const metadata = { asOf: asOf(), evidenceLabel: 'Reglas de alerta de stock configuradas',
        ...(invocation.args.sku ? { sku: invocation.args.sku } : {}) };
      const match = { businessId, enabled: true };
      if (invocation.args.sku) {
        const product = await Product.findOne({ businessId, sku: invocation.args.sku })
          .select('_id').maxTimeMS(invocation.skill.timeoutMs).lean().exec();
        if (!product) return listResult([], 0, metadata);
        match.productId = product._id;
      }
      // Join within the same tenant as well: malformed foreign references must not leak product labels.
      const result = await paged(Rule, [{ $match: match }, { $lookup: {
        from: Product.collection.name, let: { productId: '$productId' }, pipeline: [
          { $match: { $expr: { $and: [{ $eq: ['$_id', '$$productId'] }, { $eq: ['$businessId', businessId] }] } } },
          { $project: { _id: 0, sku: 1, name: 1 } }
        ], as: 'product'
      } }, { $unwind: '$product' }],
      { _id: 0, sku: '$product.sku', name: '$product.name', operator: 1, threshold: 1, enabled: 1 },
      { 'product.sku': 1, operator: 1, threshold: 1, _id: 1 }, invocation);
      return listResult(result.rows, result.total, metadata);
    },
    async list_inventory_alerts(invocation) {
      const { Product } = getModels();
      const Alert = getModels().InventoryAlert || require('../models/InventoryAlert');
      const { businessId } = invocation.context;
      const { sku, status, source } = invocation.args;
      const metadata = { asOf: asOf(), evidenceLabel: 'Alertas de inventario generadas',
        ...(sku ? { sku } : {}), ...(source ? { source } : {}), ...(status ? { status } : {}) };
      const match = { businessId, ...(status ? { status } : {}), ...(source ? { source } : {}) };
      if (sku) {
        const product = await Product.findOne({ businessId, sku }).select('_id')
          .maxTimeMS(invocation.skill.timeoutMs).lean().exec();
        if (!product) return listResult([], 0, metadata);
        match.productId = product._id;
      }
      const limit = invocation.args.limit ?? invocation.skill.maxRecords;
      const [events, totalMatches] = await Promise.all([
        Alert.find(match).select('productId status source condition previousStock newStock createdAt')
          .sort({ createdAt: -1, _id: -1 }).limit(limit).maxTimeMS(invocation.skill.timeoutMs).lean().exec(),
        Alert.countDocuments(match).maxTimeMS(invocation.skill.timeoutMs).exec()
      ]);
      const productIds = [...new Set(events.filter(row => row.productId).map(row => String(row.productId)))].map(objectId);
      const products = productIds.length ? await Product.find({ businessId, _id: { $in: productIds } })
        .select('_id sku name').maxTimeMS(invocation.skill.timeoutMs).lean().exec() : [];
      const productById = new Map(products.map(row => [String(row._id), row]));
      const data = events.map(event => {
        const product = event.productId ? productById.get(String(event.productId)) : null;
        return { sku: product?.sku ?? null, productName: product?.name ?? null,
          status: event.status, source: event.source === 'stock_alert_rule' ? 'stock_alert_rule' : 'automatic',
          ...(event.source === 'stock_alert_rule' && event.condition ? { condition: {
            operator: event.condition.operator, threshold: event.condition.threshold
          } } : {}),
          ...(Number.isSafeInteger(event.previousStock) ? { previousStock: event.previousStock } : {}),
          ...(Number.isSafeInteger(event.newStock) ? { newStock: event.newStock } : {}),
          ...(event.createdAt instanceof Date ? { createdAt: event.createdAt.toISOString() } : {}) };
      });
      return listResult(data, totalMatches, metadata);
    },
    async get_supplier_products(invocation) {
      const { Contact, Product } = getModels();
      const { businessId } = invocation.context;
      const supplierFilter = { businessId, type: 'vendor', isActive: true };
      const directory = await Contact.find(supplierFilter).select('_id businessId name type isActive')
        .limit(500).maxTimeMS(invocation.skill.timeoutMs).lean().exec();
      const vendors = [...new Map(directory.map(row => [String(row._id),
        { supplierId: String(row._id), supplierName: row.name, name: row.name }])).values()];
      const { resolveSupplier, MAX_SUPPLIER_CANDIDATES } = require('./replenishmentPlanning');
      const resolved = resolveSupplier(invocation.args.supplierRef, vendors, vendors, MAX_SUPPLIER_CANDIDATES);
      if (resolved.status !== 'MATCH') {
        const candidates = (resolved.status === 'AMBIGUOUS' || resolved.status === 'AMBIGUOUS_SUPPLIER'
          ? resolved.candidates : []).slice(0, MAX_SUPPLIER_CANDIDATES)
          .map(row => ({ id: row.supplierId, name: row.supplierName || row.name }));
        const suggestions = candidates.slice(0, 5).map(row => ({ label: row.name, message: row.name }));
        const clarificationQuestion = candidates.length
          ? `Encontré varios proveedores que podrían coincidir con «${invocation.args.supplierRef}». Elige uno y te mostraré sus productos:`
          : `No encontré un proveedor suficientemente parecido a «${invocation.args.supplierRef}». Prueba con otra parte del nombre o el nombre completo.`;
        return { status: 'CLARIFICATION', data: [], metadata: { returnedCount: suggestions.length,
          totalMatches: candidates.length, suggestions, clarificationQuestion,
          ...(candidates.length > 5 ? { suggestionsPagination: { query: invocation.args.supplierRef, offset: 0, limit: 5,
            totalMatches: candidates.length, hasMore: true, hasPrevious: false } } : {}),
          ...(candidates.length ? { supplierResolution: { candidateType: 'supplier', pageSize: 5, totalMatches: candidates.length,
            ...(resolved.totalMatches > candidates.length ? { truncatedMatches: true } : {}),
            originalIntent: invocation.skill.id, skillId: invocation.skill.id,
            args: Object.fromEntries(Object.entries(invocation.args).filter(([key]) => key !== 'supplierRef')),
            query: invocation.args.supplierRef, offset: 0, candidates } } : {}) } };
      }

      const supplierId = resolved.offer.supplierId;
      const supplierName = resolved.offer.supplierName;
      if (invocation.args.productRef) {
        const product = await Product.findOne({ businessId, sku: invocation.args.productRef.trim() })
          .select('_id businessId sku name currency supplierPrices preferredSupplierId isActive')
          .maxTimeMS(invocation.skill.timeoutMs).lean().exec();
        if (!product) return { status: 'NO_DATA', data: { supplierName, productRef: invocation.args.productRef, product: null },
          metadata: { returnedCount: 0, totalMatches: 0, asOf: asOf(), evidenceLabel: `Producto consultado con ${supplierName}` } };
        const offer = (product.supplierPrices || []).find(row => String(row.supplierId) === supplierId
          && Number.isFinite(row.purchasePrice) && row.purchasePrice > 0);
        return { status: 'READY', data: { supplierId, supplierName, totalProducts: offer ? 1 : 0,
          product: { sku: product.sku ?? null, productName: product.name, active: product.isActive === true,
            hasOffer: Boolean(offer), ...(offer ? { purchasePrice: offer.purchasePrice, currency: product.currency,
              preferredForProduct: String(product.preferredSupplierId || '') === supplierId } : {}) } },
        metadata: { returnedCount: 1, totalMatches: 1, asOf: asOf(), supplierName,
          evidenceLabel: `Oferta configurada de ${supplierName} para ${product.sku}` } };
      }

      const offerMatch = { businessId, supplierPrices: { $elemMatch: { supplierId: objectId(supplierId),
        purchasePrice: { $type: 'number', $gt: 0 } } } };
      const totalProducts = await Product.countDocuments(offerMatch).maxTimeMS(invocation.skill.timeoutMs).exec();
      const offset = invocation.args.offset || 0, limit = invocation.args.limit || 5;
      const products = await Product.find(offerMatch).select('_id businessId sku name currency supplierPrices preferredSupplierId isActive')
        .sort({ sku: 1, _id: 1 }).skip(offset).limit(limit).maxTimeMS(invocation.skill.timeoutMs).lean().exec();
      const items = products.flatMap(product => {
        const offer = (product.supplierPrices || []).find(row => String(row.supplierId) === supplierId
          && Number.isFinite(row.purchasePrice) && row.purchasePrice > 0);
        return offer ? [{ sku: product.sku ?? null, productName: product.name, purchasePrice: offer.purchasePrice,
          currency: product.currency, preferredForProduct: String(product.preferredSupplierId || '') === supplierId,
          active: product.isActive === true }] : [];
      });
      return { status: items.length ? 'READY' : 'NO_DATA', data: { supplierId, supplierName, totalProducts, items,
        pagination: { offset, limit, total: totalProducts, returnedCount: items.length, hasMore: offset + limit < totalProducts,
          hasPrevious: offset > 0 } }, metadata: { returnedCount: items.length, totalMatches: totalProducts, offset, limit,
        truncated: offset + items.length < totalProducts, asOf: asOf(), supplierName,
        evidenceLabel: `Ofertas configuradas de ${supplierName} en el catálogo` } };
    },
    async search_products(invocation) {
      const { args, context } = invocation;
      const literal = new RegExp(escapeLiteral(args.query.trim()), 'i');
      const match = { businessId: context.businessId, isActive: true, $or: [{ name: literal }, { sku: literal }] };
      if (args.category) match.category = args.category.trim();
      const result = await paged(getModels().Product, [{ $match: match }], productFields, { name: 1, _id: 1 }, invocation);
      return listResult(result.rows.map(productDto), result.total, { asOf: asOf() });
    },
    async get_product_details(invocation) {
      const { args, context, signal, skill } = invocation;
      signal.throwIfAborted();
      if (args.productIds) {
        const ids = args.productIds.split(',').map(value => value.trim());
        if (ids.length < 1 || ids.length > 5 || ids.some(value => !/^[a-f\d]{24}$/i.test(value))) {
          throw new AgentError('AGENT_INVALID_SKILL_ARGS');
        }
        const rows = await getModels().Product.find({ businessId: context.businessId,
          _id: { $in: ids.map(objectId) } }).select({ ...productFields, price: 1, currency: 1, isActive: 1 })
          .limit(5).maxTimeMS(skill.timeoutMs).lean().exec();
        const byId = new Map(rows.map(row => [String(row._id).toLowerCase(), row]));
        const ordered = ids.map(value => byId.get(value.toLowerCase())).filter(Boolean);
        return listResult(ordered.map(row => ({ ...productDto(row), price: row.price, currency: row.currency, isActive: row.isActive })), ordered.length,
          { asOf: asOf(), requestedCount: ids.length, missingCount: ids.length - ordered.length,
            evidenceLabel: 'Detalles actuales de productos de la lista previa' });
      }
      const row = await getModels().Product.findOne({ businessId: context.businessId,
        ...(args.productId ? { _id: objectId(args.productId) } : { sku: args.sku.trim() }) })
        .select({ ...productFields, price: 1, currency: 1, isActive: 1 }).maxTimeMS(skill.timeoutMs).lean().exec();
      if (!row) throw new AgentError('AGENT_RESOURCE_NOT_FOUND');
      return { status: 'READY', data: { ...productDto(row), price: row.price, currency: row.currency, isActive: row.isActive },
        metadata: { asOf: asOf(), returnedCount: 1 } };
    },
    async get_low_stock_products(invocation) {
      const result = await paged(getModels().Product, [
        { $match: { businessId: invocation.context.businessId, isActive: true,
          $expr: { $lte: ['$stock', { $ifNull: ['$minStockLevel', 0] }] } } },
        { $set: { shortage: { $subtract: [{ $ifNull: ['$minStockLevel', 0] }, '$stock'] } } }
      ], { ...productFields, shortage: 1 }, { shortage: -1, _id: 1 }, invocation, true);
      return listResult(result.rows.map(row => ({ ...productDto(row), shortage: row.shortage })), result.total,
        { asOf: asOf(), offset: invocation.args.offset || 0, limit: invocation.args.limit ?? invocation.skill.maxRecords });
    },
    async get_recent_transactions(invocation) {
      const { args, context } = invocation;
      const match = { businessId: context.businessId };
      for (const key of ['type', 'status']) if (args[key]) match[key] = args[key];
      if (args.startDate) match.date = dateFilter(args);
      const result = await paged(getModels().Transaction, [{ $match: match }], {
        _id: 1, type: 1, status: 1, date: 1, totalAmount: 1, currency: 1,
        itemCount: { $size: '$products' }
      }, { date: -1, _id: -1 }, invocation);
      return listResult(result.rows.map(row => ({ id: String(row._id), type: row.type, status: row.status,
        date: row.date.toISOString(), total: row.totalAmount, currency: row.currency, itemCount: row.itemCount })),
      result.total, { asOf: asOf(), ...(args.startDate ? { period: { startDate: args.startDate, endDate: args.endDate } } : {}) });
    },
    async get_sales_summary(invocation) {
      const rows = await financialRows({ businessId: invocation.context.businessId, type: 'sale', status: 'completed',
        date: dateFilter(invocation.args) }, invocation);
      const totals = financialDto(rows, 'sale');
      return { status: totals.completedTransactionsCount ? 'READY' : 'NO_DATA', data: {
        completedSalesCount: totals.completedTransactionsCount, totalUnitsSold: totals.totalUnits,
        amountsByCurrency: totals.amountsByCurrency
      }, metadata: { asOf: asOf(), period: { startDate: invocation.args.startDate, endDate: invocation.args.endDate },
        amountBasis: 'transaction_total_native_currency', returnedCount: 1 } };
    },
    async get_top_selling_products(invocation) {
      const models = getModels();
      const hasPeriod = Boolean(invocation.args.startDate);
      const limit = invocation.args.limit ?? invocation.skill.maxRecords;
      const rows = await aggregate(models.Transaction, [
        { $match: { businessId: invocation.context.businessId, type: 'sale', status: 'completed',
          ...(hasPeriod ? { date: dateFilter(invocation.args) } : {}) } },
        { $facet: {
          ranking: [{ $unwind: '$products' },
            { $group: { _id: '$products.productId', unitsSold: { $sum: '$products.quantity' }, historicalName: { $first: '$products.productName' } } },
            { $sort: { unitsSold: -1, _id: 1 } },
            { $limit: limit }, { $project: { _id: 1, unitsSold: 1, historicalName: 1 } }],
          totalProducts: [{ $unwind: '$products' },
            { $group: { _id: '$products.productId' } }, { $count: 'total' }],
          dateRange: [{ $group: { _id: null, minDate: { $min: '$date' }, maxDate: { $max: '$date' } } }]
        } }
      ], invocation);
      const ranking = rows[0]?.ranking || [];
      const dateRange = rows[0]?.dateRange?.[0];
      const totalMatches = rows[0]?.totalProducts?.[0]?.total || 0;
      // One bounded lookup for the top-N, including inactive historical products.
      invocation.signal.throwIfAborted();
      const ids = ranking.map(row => row._id);
      const products = ids.length ? await models.Product.find({ businessId: invocation.context.businessId, _id: { $in: ids } })
        .select('_id sku name').limit(invocation.skill.maxRecords).maxTimeMS(invocation.skill.timeoutMs).lean().exec() : [];
      const byId = new Map(products.map(row => [String(row._id), row]));
      const isValidDate = value => value instanceof Date && Number.isFinite(value.getTime());
      const hasDateRange = isValidDate(dateRange?.minDate) && isValidDate(dateRange?.maxDate);
      const periodLabel = hasPeriod ? `${invocation.args.startDate} a ${invocation.args.endDate}`
        : `Todo el historial disponible${hasDateRange
          ? ` (${dateRange.minDate.toISOString().slice(0, 10)} a ${dateRange.maxDate.toISOString().slice(0, 10)})` : ''}`;
      return listResult(ranking.map(row => ({ productId: String(row._id), sku: byId.get(String(row._id))?.sku ?? null,
        name: byId.get(String(row._id))?.name ?? row.historicalName, unitsSold: row.unitsSold })), totalMatches,
      { asOf: asOf(), periodLabel, evidenceLabel: `Productos más vendidos · ${periodLabel}`,
        ...(hasPeriod ? { period: { startDate: invocation.args.startDate, endDate: invocation.args.endDate } } : {}) });
    },
    async get_product_sales_summary(invocation) {
      invocation.signal.throwIfAborted();
      const { args, context, skill } = invocation;
      const product = await getModels().Product.findOne({ businessId: context.businessId,
        ...(args.productId ? { _id: objectId(args.productId) } : { sku: args.sku.trim() }) })
        .select(productFields).maxTimeMS(skill.timeoutMs).lean().exec();
      if (!product) throw new AgentError('AGENT_RESOURCE_NOT_FOUND');
      const rows = await aggregate(getModels().Transaction, [
        { $match: { businessId: context.businessId, type: 'sale', status: 'completed', date: dateFilter(args) } },
        { $unwind: '$products' }, { $match: { 'products.productId': product._id } },
        { $group: { _id: '$currency', units: { $sum: '$products.quantity' }, amount: { $sum: '$products.total' } } }
      ], invocation);
      return { status: rows.length ? 'READY' : 'NO_DATA', data: { product: productDto(product),
        totalUnitsSold: rows.reduce((sum, row) => sum + row.units, 0),
        amountsByCurrency: rows.map(row => ({ currency: row._id, amount: row.amount, label: 'Importe de líneas vendidas' })) },
      metadata: { asOf: asOf(), period: { startDate: args.startDate, endDate: args.endDate },
        amountBasis: 'completed_product_line_total_native_currency', returnedCount: 1 } };
    },
    async get_business_summary(invocation) {
      const { Product, Transaction } = getModels();
      let anchor = clock();
      if (invocation.args.period === 'latest') {
        const latest = await Transaction.findOne({ businessId: invocation.context.businessId, status: 'completed' })
          .select('date').sort({ date: -1, _id: -1 }).maxTimeMS(invocation.skill.timeoutMs).lean().exec();
        if (latest) anchor = latest.date;
      }
      const start = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
      const end = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 1));
      const period = { startDate: start.toISOString().slice(0, 10), endDate: new Date(end.getTime() - 86400000).toISOString().slice(0, 10) };
      const [counts, finances] = await Promise.all([
        aggregate(Product, [ { $match: { businessId: invocation.context.businessId, isActive: true } },
          { $group: { _id: null, activeProducts: { $sum: 1 }, lowStockProducts: { $sum: {
            $cond: [{ $lte: ['$stock', { $ifNull: ['$minStockLevel', 0] }] }, 1, 0]
          } } } } ], invocation),
        financialRows({ businessId: invocation.context.businessId, status: 'completed', date: { $gte: start, $lt: end } }, invocation)
      ]);
      return { status: 'READY', data: { activeProducts: counts[0]?.activeProducts || 0,
        lowStockProducts: counts[0]?.lowStockProducts || 0,
        completedTransactionsCount: finances.reduce((sum, row) => sum + row.count, 0),
        sales: financialDto(finances, 'sale'), purchases: financialDto(finances, 'purchase') },
      metadata: { asOf: asOf(), period, periodMode: invocation.args.period ?? 'current',
        amountBasis: 'transaction_total_native_currency', inventoryBasis: 'current_active_products', returnedCount: 1 } };
    },
    async analyze_demand_forecast(invocation) {
      const batch = forecastResult(await readForecast({ ...invocation, args: {} }),
        { ...invocation, args: {}, skill: { ...invocation.skill, maxRecords: 60 } });
      if (batch.status === 'ML_NOT_READY') return batch;
      const configuration = Object.values(require('../config/mlScenarios.json')).find(row => row.businessId === invocation.context.businessId);
      return require('./forecastAnalytics').analyzeForecast(batch, invocation.args, configuration?.scenarioId);
    },
    async get_replenishment_cost(invocation) {
      const { buildBudgetPlan, fromCents } = require('./replenishmentPlanning');
      const loaded = await commercialProducts(invocation, invocation.args.mode === 'single' ? invocation.args.productRef : undefined,
        invocation.args.department);
      if (loaded.status === 'ML_NOT_READY' || loaded.status === 'CLARIFICATION') return {
        status: loaded.status, data: loaded.suggestions || [], metadata: { ...loaded.metadata, returnedCount: loaded.metadata.returnedCount }
      };
      const rows = loaded.rows;
      const eligible = rows.filter(row => row.mlStatus === 'READY' && row.recommendedQty > 0);
      const excluded = eligible.filter(row => !row.selected);
      const costed = eligible.filter(row => row.selected);
      const notReady = rows.filter(row => row.mlStatus !== 'READY');
      const subtotalCents = costed.reduce((sum, row) => sum + row.recommendedQty * row.selected.unitCostCents, 0);
      if (!Number.isSafeInteger(subtotalCents)) throw new AgentError('AGENT_SKILL_EXECUTION_FAILED');
      const pricingAsOf = asOf(), scenarioId = Object.values(require('../config/mlScenarios.json'))
        .find(row => row.businessId === invocation.context.businessId)?.scenarioId || null;
      const mapLine = row => ({ sku: row.sku, productName: row.name, recommendedQty: row.recommendedQty,
        selectedSupplier: row.selected?.supplierName || null, selectionRule: row.selectionRule || 'NO_USABLE_OFFER',
        supplierMatch: row.supplierMatch || null,
        unitCost: row.selected?.unitCost ?? null, currency: row.currency || null,
        replenishmentCost: row.selected ? fromCents(row.recommendedQty * row.selected.unitCostCents) : null,
        inventoryStatus: row.inventoryStatus, predictedDemand7d: row.predictedDemand7d,
        stockAtAnchor: row.stockAtAnchor, mlStatus: row.mlStatus });
      if (invocation.args.mode === 'single') {
        const row = rows[0];
        if (!row) return { status: 'NO_DATA', data: {}, metadata: { ...loaded.metadata, returnedCount: 0 } };
        if (row.mlStatus !== 'READY') return { status: 'ML_NOT_READY', data: [], metadata: { ...loaded.metadata,
          returnedCount: 0, reason: row.mlStatus } };
        if (row.supplierResolution) return { status: 'CLARIFICATION', data: [], metadata: { ...loaded.metadata,
          returnedCount: row.supplierResolution.candidates.length, suggestions: row.suggestions,
          ...(row.supplierResolution.candidates.length > 5 ? { suggestionsPagination: { query: row.supplierResolution.query,
            offset: row.supplierResolution.offset, limit: 5, totalMatches: row.supplierResolution.candidates.length,
            hasMore: row.supplierResolution.offset + 5 < row.supplierResolution.candidates.length,
            hasPrevious: row.supplierResolution.offset > 0 } } : {}),
          clarificationQuestion: row.clarificationQuestion, supplierResolution: row.supplierResolution } };
        const line = mapLine(row);
        return { status: 'READY', data: { scenarioId, anchor: loaded.metadata.anchor, pricingAsOf,
          ...line, currency: line.currency || 'PEN' }, metadata: { ...loaded.metadata, returnedCount: 1,
          evidenceLabel: `Costo de reposición · ${scenarioId || 'escenario histórico'} · ${loaded.metadata.anchor} · ${row.sku} · ${line.selectionRule} · precios consultados ${pricingAsOf}` } };
      }
      const limit = invocation.args.limit || 20, offset = invocation.args.offset || 0;
      const lines = costed.map(mapLine).slice(offset, offset + limit);
      return { status: 'READY', data: { scenarioId, anchor: loaded.metadata.anchor, pricingAsOf,
        consideredProducts: rows.length, costedProducts: costed.length, excludedProducts: excluded.length + notReady.length,
        nonReadyProducts: notReady.length,
        recommendedUnits: eligible.reduce((sum, row) => sum + row.recommendedQty, 0),
        knownCostSubtotal: fromCents(subtotalCents), currency: 'PEN', coverageProducts: { costed: costed.length, eligible: eligible.length },
        exclusionsByReason: [...notReady.map(row => row.mlStatus), ...excluded.map(row => row.exclusionReason || 'NO_USABLE_OFFER')]
          .reduce((out, reason) => { const key = notReady.some(row => row.mlStatus === reason) ? `FORECAST_${reason}` : reason;
            out[key] = (out[key] || 0) + 1; return out; }, {}), items: lines }, metadata: { ...loaded.metadata, totalMatches: costed.length,
        returnedCount: lines.length, offset, limit, truncated: offset + limit < costed.length,
        evidenceLabel: `Costo conocido de reposición · ${scenarioId || 'escenario histórico'} · ${loaded.metadata.anchor} · PEN · ${pricingAsOf}` } };
    },
    async plan_replenishment_budget(invocation) {
      const { buildBudgetPlan, selectOffer } = require('./replenishmentPlanning');
      const loaded = await commercialProducts(invocation, undefined, invocation.args.department);
      if (loaded.status === 'ML_NOT_READY') return { status: loaded.status, data: [], metadata: { ...loaded.metadata, returnedCount: 0 } };
      const rows = loaded.rows.map(row => {
        const offer = row.selected ? row : { ...row, ...selectOffer(row, loaded.suppliers) };
        return { ...offer, exclusionReason: row.exclusionReason || offer.exclusionReason };
      });
      const plan = buildBudgetPlan({ rows, budget: invocation.args.budget,
        limit: invocation.args.limit || 20, offset: invocation.args.offset || 0 });
      const pricingAsOf = asOf(), scenarioId = Object.values(require('../config/mlScenarios.json'))
        .find(row => row.businessId === invocation.context.businessId)?.scenarioId || null;
      const data = { scenarioId, anchor: loaded.metadata.anchor, pricingAsOf, currency: 'PEN', ...plan,
        coverageProducts: { costed: plan.costedProducts, eligible: loaded.rows.filter(row => row.mlStatus === 'READY' && row.recommendedQty > 0).length } };
      return { status: 'READY', data, metadata: { ...loaded.metadata,
        totalMatches: plan.pagination.total, returnedCount: plan.pagination.returnedCount, offset: plan.pagination.offset,
        limit: plan.pagination.limit, truncated: plan.pagination.truncated,
        evidenceLabel: `Plan de presupuesto · ${scenarioId || 'escenario histórico'} · ${loaded.metadata.anchor} · PEN · ${pricingAsOf}` } };
    },
    async compare_supplier_costs(invocation) {
      if (invocation.args.productRefs !== undefined) {
        const productRefs = invocation.args.productRefs.split('|');
        if (invocation.args.supplierRef !== undefined || productRefs.length < 1 || productRefs.length > 5
          || productRefs.some(ref => !/^[\w.-]{1,100}$/.test(ref))
          || new Set(productRefs).size !== productRefs.length) throw new AgentError('AGENT_INVALID_SKILL_ARGS');
        const loaded = await commercialProducts(invocation, undefined, undefined, productRefs);
        if (loaded.status === 'ML_NOT_READY') return { status: loaded.status, data: [], metadata: { ...loaded.metadata, returnedCount: 0 } };
        const { selectOffer } = require('./replenishmentPlanning');
        const data = loaded.rows.map(row => {
          const selected = selectOffer(row, loaded.suppliers);
          return { sku: row.sku, productName: row.name, currency: row.currency || null,
            recommendedQty: row.mlStatus === 'READY' ? row.recommendedQty : null,
            offers: selected.offers.map(offer => ({ supplier: offer.supplierName,
              unitCost: offer.unitCost, currency: row.currency, preferred: offer.preferred })) };
        });
        const pricingAsOf = asOf();
        return { status: data.length ? 'READY' : 'NO_DATA', data, metadata: { ...loaded.metadata,
          returnedCount: data.length, totalMatches: productRefs.length, pricingAsOf,
          evidenceLabel: `Ofertas configuradas para ${data.length} productos de la lista · ${loaded.metadata.anchor || 'ancla no disponible'} · ${pricingAsOf}` } };
      }
      const loaded = await commercialProducts(invocation, invocation.args.productRef);
      if (loaded.status === 'ML_NOT_READY' || loaded.status === 'CLARIFICATION') return {
        status: loaded.status, data: loaded.suggestions || [], metadata: { ...loaded.metadata, returnedCount: loaded.metadata.returnedCount }
      };
      const row = loaded.rows[0];
      if (!row || row.productMissing) return { status: 'NO_DATA', data: [], metadata: { ...loaded.metadata, returnedCount: 0 } };
      if (row.supplierResolution) return { status: 'CLARIFICATION', data: [], metadata: { ...loaded.metadata,
        returnedCount: row.supplierResolution.candidates.length, suggestions: row.suggestions,
        ...(row.supplierResolution.candidates.length > 5 ? { suggestionsPagination: { query: row.supplierResolution.query,
          offset: row.supplierResolution.offset, limit: 5, totalMatches: row.supplierResolution.candidates.length,
          hasMore: row.supplierResolution.offset + 5 < row.supplierResolution.candidates.length,
          hasPrevious: row.supplierResolution.offset > 0 } } : {}),
        clarificationQuestion: row.clarificationQuestion, supplierResolution: row.supplierResolution } };
      const selected = row;
      const offers = [...selected.offers].sort((a, b) => Number(b.supplierId === selected.selected?.supplierId)
        - Number(a.supplierId === selected.selected?.supplierId) || a.unitCostCents - b.unitCostCents
        || String(a.supplierName).localeCompare(String(b.supplierName))).slice(0, invocation.skill.maxRecords);
      const pricingAsOf = asOf(), scenarioId = Object.values(require('../config/mlScenarios.json'))
        .find(config => config.businessId === invocation.context.businessId)?.scenarioId || null;
      return { status: offers.length ? 'READY' : 'NO_DATA', data: offers.map(offer => ({ sku: row.sku,
        productName: row.name, supplier: offer.supplierName, unitCost: offer.unitCost, currency: row.currency,
        preferred: offer.preferred, selected: offer.supplierId === selected.selected?.supplierId })), metadata: { ...loaded.metadata,
        returnedCount: offers.length, totalMatches: selected.offers.length,
        pricingAsOf, evidenceLabel: `Ofertas de ${row.sku} · ${scenarioId || 'escenario histórico'} · ancla ${loaded.metadata.anchor} · PEN · ${pricingAsOf}`,
        selectedSupplier: selected.selected?.supplierName || null, selectionRule: selected.selectionRule } };
    },
    async get_demand_forecast(invocation) { return forecastResult(await readForecast(invocation), invocation); },
    async get_replenishment_candidates(invocation) { return forecastResult(await readForecast(invocation), invocation, true); }
  });
};

module.exports = { createSkillExecutors, createAgentForecastService };
