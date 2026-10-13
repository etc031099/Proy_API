'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { commercialPresentationKey, loadDefinitions, validateDefinitions } = require('../../scripts/validate-minimarket-v3-definitions');

function validDefinitions() {
  return structuredClone(loadDefinitions());
}

describe('M6.2 canonical Minimarket Pasco V3 definitions', () => {
  it('accepts the canonical catalog and expected entity counts', () => {
    const result = validateDefinitions(validDefinitions());
    assert.equal(result.valid, true, result.errors.join('\n'));
    assert.deepEqual(result.counts, {
      Products: 80,
      Categories: 10,
      Subcategories: 42,
      Suppliers: 10,
      Customers: 40,
      'Supplier offers': 103,
      'Demand profiles': 8,
      'Customer profiles': 6,
      'Association profiles': 5,
    });
  });

  it('rejects duplicate SKUs', () => {
    const definitions = validDefinitions();
    definitions.products.catalog[1].sku = definitions.products.catalog[0].sku;
    assert.match(validateDefinitions(definitions).errors.join('\n'), /SKU duplicado/);
  });

  it('rejects duplicate exact commercial presentations even when SKU differs', () => {
    const definitions = validDefinitions();
    definitions.products.catalog[1].brand = definitions.products.catalog[0].brand;
    definitions.products.catalog[1].name = definitions.products.catalog[0].name;
    definitions.products.catalog[1].presentation = definitions.products.catalog[0].presentation;
    definitions.products.catalog[1].sizeValue = definitions.products.catalog[0].sizeValue;
    definitions.products.catalog[1].sizeUnit = definitions.products.catalog[0].sizeUnit;
    definitions.products.catalog[1].unit = definitions.products.catalog[0].unit;
    definitions.products.catalog[1].containedUnits = definitions.products.catalog[0].containedUnits;
    assert.match(validateDefinitions(definitions).errors.join('\n'), /presentación comercial duplicada/);
  });

  it('treats different package sizes as distinct SKU identities', () => {
    const definitions = validDefinitions();
    const cokeVariants = definitions.products.catalog.filter((product) => product.brand === 'Inca Kola' && product.name.includes('Original'));
    assert.ok(cokeVariants.length >= 2);
    assert.notEqual(commercialPresentationKey(cokeVariants[0]), commercialPresentationKey(cokeVariants[1]));
  });

  it('rejects missing category references', () => {
    const definitions = validDefinitions();
    definitions.products.catalog[0].categoryCode = 'MISSING';
    assert.match(validateDefinitions(definitions).errors.join('\n'), /categoría inexistente/);
  });

  it('rejects missing supplier references and preferred supplier offers', () => {
    const definitions = validDefinitions();
    definitions.products.catalog[0].preferredSupplierCode = 'SUP-99';
    assert.match(validateDefinitions(definitions).errors.join('\n'), /proveedor preferido inexistente/);
    assert.match(validateDefinitions(definitions).errors.join('\n'), /oferta referencia proveedor inexistente/);
  });

  it('rejects purchase costs that are not below demo sale prices', () => {
    const definitions = validDefinitions();
    definitions.products.catalog[0].purchaseCostDemo = definitions.products.catalog[0].salePriceDemo;
    assert.match(validateDefinitions(definitions).errors.join('\n'), /costo no menor que precio de venta/);
  });

  it('rejects invalid date range length and a broken simulation date', () => {
    const definitions = validDefinitions();
    definitions.scenario.historyStart = '2025-10-14';
    const errors = validateDefinitions(definitions).errors.join('\n');
    assert.match(errors, /rango histórico debe contener 365 días/);
    assert.match(errors, /simulation-config no coincide/);
  });

  it('rejects unknown demand profile references', () => {
    const definitions = validDefinitions();
    definitions.products.catalog[0].demandProfileKey = 'UNKNOWN';
    assert.match(validateDefinitions(definitions).errors.join('\n'), /demandProfile inexistente/);
  });

  it('rejects a product with no preferred active supplier', () => {
    const definitions = validDefinitions();
    const preferred = definitions.products.catalog[0].preferredSupplierCode;
    definitions.suppliers.suppliers.find((supplier) => supplier.supplierCode === preferred).active = false;
    const errors = validateDefinitions(definitions).errors.join('\n');
    assert.match(errors, /producto debe tener exactamente una oferta preferida activa/);
  });
});
