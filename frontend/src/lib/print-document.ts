export interface PrintField {
  label: string;
  value: unknown;
}

export interface PrintDocumentData {
  title: string;
  summary?: unknown;
  metadata?: PrintField[];
  headers: unknown[];
  rows: unknown[][];
  footer?: PrintField[];
}

interface PrintWindow {
  document: Document;
  opener: Window | null;
  focus: () => void;
  print: () => void;
}

type OpenPrintWindow = (url?: string | URL, target?: string, features?: string) => PrintWindow | null;

const PRINT_STYLES = `
  body{font-family:Arial,sans-serif;padding:28px;color:#111;max-width:1060px;margin:auto}
  h1{font-size:22px;margin-bottom:8px}p{color:#555}.metadata{margin-bottom:20px}
  .metadata div,.footer div{margin:4px 0}.label{font-weight:700;color:#111}
  table{border-collapse:collapse;width:100%;font-size:12px;margin-top:20px}
  th,td{border:1px solid #ccc;padding:7px;text-align:left;vertical-align:top}
  th{background:#f1f5f9}.footer{margin-top:20px;text-align:right;font-size:16px}
`;

const appendTextElement = (
  document: Document,
  parent: Node,
  tagName: string,
  value: unknown,
  className?: string,
) => {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  element.textContent = String(value ?? '');
  parent.appendChild(element);
  return element;
};

const appendFields = (
  document: Document,
  parent: Node,
  fields: PrintField[],
  className: string,
) => {
  const container = document.createElement('div');
  container.className = className;

  for (const field of fields) {
    const row = document.createElement('div');
    const label = appendTextElement(document, row, 'span', `${field.label}: `, 'label');
    label.after(document.createTextNode(String(field.value ?? '')));
    container.appendChild(row);
  }

  parent.appendChild(container);
};

export const populatePrintDocument = (document: Document, data: PrintDocumentData) => {
  const html = document.documentElement || document.createElement('html');
  const head = document.head || document.createElement('head');
  const body = document.body || document.createElement('body');
  head.replaceChildren();
  body.replaceChildren();
  const title = appendTextElement(document, head, 'title', data.title);
  const style = document.createElement('style');
  style.textContent = PRINT_STYLES;
  title.after(style);

  appendTextElement(document, body, 'h1', data.title);
  if (data.summary !== undefined && data.summary !== null && data.summary !== '') {
    appendTextElement(document, body, 'p', data.summary);
  }
  if (data.metadata?.length) {
    appendFields(document, body, data.metadata, 'metadata');
  }

  const table = document.createElement('table');
  const tableHead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const header of data.headers) {
    appendTextElement(document, headerRow, 'th', header);
  }
  tableHead.appendChild(headerRow);
  table.appendChild(tableHead);

  const tableBody = document.createElement('tbody');
  for (const values of data.rows) {
    const row = document.createElement('tr');
    for (const value of values) {
      appendTextElement(document, row, 'td', value);
    }
    tableBody.appendChild(row);
  }
  table.appendChild(tableBody);
  body.appendChild(table);

  if (data.footer?.length) {
    appendFields(document, body, data.footer, 'footer');
  }

  if (!head.parentNode) html.appendChild(head);
  if (!body.parentNode) html.appendChild(body);
  if (!html.parentNode) document.appendChild(html);
};

export const openPrintDocument = (
  data: PrintDocumentData,
  size = 'width=900,height=900',
  openWindow: OpenPrintWindow = (...arguments_) => window.open(...arguments_),
) => {
  const printWindow = openWindow('', '_blank', size);
  if (!printWindow) return false;

  // The popup stays same-origin for printing, but cannot navigate its opener.
  printWindow.opener = null;
  populatePrintDocument(printWindow.document, data);
  printWindow.document.close();
  printWindow.focus();
  printWindow.print();
  return true;
};
