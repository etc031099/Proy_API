const test = require('node:test');
const assert = require('node:assert/strict');
const { Product, Transaction } = require('../src/models');
const { getProducts } = require('../src/controllers/productController');
const { getTransactions } = require('../src/controllers/transactionController');

const captureModel = (model, records, total) => {
  const originalFind = Object.getOwnPropertyDescriptor(model, 'find');
  const originalCount = Object.getOwnPropertyDescriptor(model, 'countDocuments');
  const observed = {};
  model.find = (filter) => {
    observed.findFilter = filter;
    const query = {
      sort() { return this; },
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
