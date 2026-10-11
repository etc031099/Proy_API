const test = require('node:test');
const assert = require('node:assert/strict');
const { Product, Transaction, Contact } = require('../src/models');
const { getContacts, getCustomers, getVendors } = require('../src/controllers/contactController');
const { getProducts } = require('../src/controllers/productController');
const { getTransactions } = require('../src/controllers/transactionController');

const captureModel = (model, records, total) => {
  const originalFind = Object.getOwnPropertyDescriptor(model, 'find');
  const originalCount = Object.getOwnPropertyDescriptor(model, 'countDocuments');
  const observed = {};
  model.find = (filter) => {
    observed.findFilter = filter;
    const query = {
      sort(value) { observed.sort = value; return this; },
      skip(value) { observed.skip = value; return this; },
      limit(value) { observed.limit = value; return this; },
      populate() { return this; },
      then(resolve, reject) { return Promise.resolve(records).then(resolve, reject); }
    };
    return query;
  };
  model.countDocuments = async (filter) => {
    observed.countFilter = filter;
    return total;
  };
  return {
    observed,
    restore() {
      if (originalFind) Object.defineProperty(model, 'find', originalFind);
      else delete model.find;
      if (originalCount) Object.defineProperty(model, 'countDocuments', originalCount);
      else delete model.countDocuments;
    }
  };
};

const callController = (handler, query, businessId) => new Promise((resolve, reject) => {
  handler(
    { query, businessId },
    { json: resolve },
    reject
  );
});

for (const [handler, key, type] of [[getContacts, 'contacts', null], [getCustomers, 'customers', 'customer'], [getVendors, 'vendors', 'vendor']]) {
  test(`P2C.1 ${key} pages, counts, filters, clamps and escapes literal search within tenant`, async () => {
    const mock = captureModel(Contact, [{ name: 'Same name', _id: '2' }], 43);
    try {
      const result = await callController(handler, { page: 2, limit: 20, search: 'a.*', ...(type ? {} : { type: 'vendor' }) }, 'tenant-a');
      assert.deepEqual(result.data.pagination, { current: 2, limit: 20, total: 43, pages: 3 });
      assert.equal(mock.observed.skip, 20); assert.equal(mock.observed.limit, 20);
      assert.deepEqual(mock.observed.sort, { name: 1, _id: 1 });
      assert.deepEqual(mock.observed.findFilter, mock.observed.countFilter);
      assert.equal(mock.observed.findFilter.businessId, 'tenant-a');
      assert.equal(mock.observed.findFilter.type, type || 'vendor');
      assert.equal(mock.observed.findFilter.$or[0].name.$regex, 'a\\.\\*');
      const clamped = await callController(handler, { page: 10, limit: 20 }, 'tenant-b');
      assert.equal(clamped.data.pagination.current, 3); assert.equal(mock.observed.findFilter.businessId, 'tenant-b');
      await assert.rejects(callController(handler, { limit: 101 }, 'tenant-a'), /Invalid pagination/);
      await assert.rejects(callController(handler, { page: 0 }, 'tenant-a'), /Invalid pagination/);
    } finally { mock.restore(); }
  });
}
test('P2C.1 product selector supplier offer filter and stable sorting apply before paging', async () => {
  const mock = captureModel(Product, [], 42);
  try {
    await callController(getProducts, { page: 2, limit: 20, search: 'milk(', supplierId: 'a'.repeat(24) }, 'tenant-a');
    assert.deepEqual(mock.observed.sort, { createdAt: -1, _id: -1 });
    assert.equal(mock.observed.findFilter.supplierPrices.$elemMatch.supplierId, 'a'.repeat(24));
    assert.equal(mock.observed.findFilter.$or[0].name.$regex, 'milk\\(');
    assert.deepEqual(mock.observed.findFilter, mock.observed.countFilter); assert.equal(mock.observed.skip, 20);
  } finally { mock.restore(); }
});
test('P2C.1 inventory page retains complete filtered aggregate statistics without full product download', async () => {
  const mock = captureModel(Product, [{ sku: 'PAGE-2' }], 43);
  const original = Product.aggregate; let pipeline;
  Product.aggregate = async value => { pipeline = value; return [{ _id: { category: 'food', currency: 'PEN' }, count: 43, totalStock: 90, value: 180, low: 3, out: 2 }]; };
  try {
    const report = await require('../src/services/paginatedInventoryReport')({ businessId: 'tenant-a', query: { page: 2, limit: 20, search: 'foo.', category: 'food', lowStock: 'true' } }, async () => 1, 'PEN');
    assert.equal(report.products.length, 1); assert.deepEqual(report.pagination, { current: 2, limit: 20, total: 43, pages: 3 });
    assert.equal(report.statistics.totalProducts, 43); assert.equal(report.statistics.totalValue, 180);
    assert.equal(report.statistics.lowStockCount, 3); assert.equal(mock.observed.skip, 20);
    assert.deepEqual(pipeline[0].$match, mock.observed.countFilter);
    assert.equal(pipeline[0].$match.businessId, 'tenant-a'); assert.equal(pipeline[0].$match.$or[0].name.$regex, 'foo\\.');
    assert.deepEqual(mock.observed.sort, { name: 1, _id: 1 });
  } finally { Product.aggregate = original; mock.restore(); }
});

test('transaction list paginates and counts the same tenant/filter/search set', async () => {
  const mock = captureModel(Transaction, [{ _id: 'page-two-transaction' }], 21);
  try {
    const result = await callController(getTransactions, {
      page: 2,
      limit: 10,
      search: 'milk',
      type: 'sale',
      status: 'completed',
      startDate: '2026-01-01'
    }, 'tenant-a');

    assert.equal(mock.observed.skip, 10);
    assert.equal(mock.observed.limit, 10);
    assert.equal(mock.observed.findFilter.businessId, 'tenant-a');
    assert.equal(mock.observed.countFilter.businessId, 'tenant-a');
    assert.equal(mock.observed.countFilter.type, 'sale');
    assert.equal(mock.observed.countFilter.status, 'completed');
    assert.equal(mock.observed.countFilter.date.$gte.toISOString(), '2026-01-01T00:00:00.000Z');
    assert.equal(mock.observed.countFilter.$and[0].$or[0].customerName.source, 'milk');
    assert.equal(result.data.pagination.current, 2);
    assert.equal(result.data.pagination.limit, 10);
    assert.equal(result.data.pagination.total, 21);
    assert.equal(result.data.pagination.pages, 3);
  } finally {
    mock.restore();
  }
});

test('product list reaches later pages and scopes its total to the tenant and active filters', async () => {
  const mock = captureModel(Product, [{ _id: 'page-two-product' }], 21);
  try {
    const result = await callController(getProducts, {
      page: 2,
      limit: 10,
      search: 'milk',
      category: 'food',
      minStock: 2
    }, 'tenant-a');

    assert.equal(mock.observed.skip, 10);
    assert.equal(mock.observed.limit, 10);
    assert.equal(mock.observed.findFilter.businessId, 'tenant-a');
    assert.equal(mock.observed.countFilter.businessId, 'tenant-a');
    assert.equal(mock.observed.countFilter.category.$regex, 'food');
    assert.equal(mock.observed.countFilter.stock.$gte, 2);
    assert.equal(result.data.products[0]._id, 'page-two-product');
    assert.deepEqual(result.data.pagination, { current: 2, pages: 3, total: 21, limit: 10 });
  } finally {
    mock.restore();
  }
});

test('both lists clamp out-of-range pages and represent empty lists safely', async () => {
  const productMock = captureModel(Product, [], 0);
  try {
    const empty = await callController(getProducts, { page: 8, limit: 10 }, 'tenant-a');
    assert.equal(productMock.observed.skip, 0);
    assert.deepEqual(empty.data.pagination, { current: 1, pages: 0, total: 0, limit: 10 });
  } finally {
    productMock.restore();
  }

  for (const total of [10, 11]) {
    const boundaryMock = captureModel(Product, [], total);
    try {
      const result = await callController(getProducts, { page: 1, limit: 10 }, 'tenant-a');
      assert.equal(result.data.pagination.pages, total === 10 ? 1 : 2);
    } finally {
      boundaryMock.restore();
    }
  }

  const shortenedMock = captureModel(Product, [], 20);
  try {
    const afterDeletion = await callController(getProducts, { page: 3, limit: 10 }, 'tenant-a');
    assert.equal(shortenedMock.observed.skip, 10);
    assert.equal(afterDeletion.data.pagination.current, 2);
    assert.equal(afterDeletion.data.pagination.pages, 2);
  } finally {
    shortenedMock.restore();
  }

  const transactionMock = captureModel(Transaction, [{ _id: 'last-page' }], 21);
  try {
    const lastPage = await callController(getTransactions, { page: 8, limit: 10 }, 'tenant-a');
    assert.equal(transactionMock.observed.skip, 20);
    assert.equal(lastPage.data.pagination.current, 3);
    assert.equal(lastPage.data.pagination.pages, 3);
  } finally {
    transactionMock.restore();
  }
});
