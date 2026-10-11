// Reference syntax only: never authorizes a write or supplies tenant identity.
const supplierLanguage = value => String(value).replace(/\b(?:proveedro|prov)(?=\s)/gi, 'proveedor');
const contextualSupplier = value => /^(?:(?:ese|este)(?: mismo)?(?: proveedor)?|(?:el )?mismo(?: proveedor)?|(?:el )?anterior(?: proveedor)?)$/i
  .test(supplierLanguage(value).trim());
module.exports = { supplierLanguage, contextualSupplier };
