/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  openPrintDocument,
  populatePrintDocument
} = require('../../src/lib/print-document.ts');

const escapeText = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

class FakeNode {
  constructor(tagName, text = '') {
    this.tagName = tagName;
    this.parentNode = null;
    this.children = [];
    this.className = '';
    this.ownText = text;
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  append(...children) {
    children.forEach((child) => this.appendChild(child));
  }

  replaceChildren(...children) {
    this.children = [];
    this.append(...children);
  }

  after(child) {
    const index = this.parentNode.children.indexOf(this);
    child.parentNode = this.parentNode;
    this.parentNode.children.splice(index + 1, 0, child);
  }

  set textContent(value) {
    this.children = [];
    this.ownText = String(value ?? '');
  }

  get textContent() {
    return this.ownText + this.children.map((child) => child.textContent).join('');
  }

  serialize() {
    if (this.tagName === '#text') return escapeText(this.ownText);
    const classAttribute = this.className ? ` class="${escapeText(this.className)}"` : '';
    return `<${this.tagName}${classAttribute}>${escapeText(this.ownText)}${this.children.map((child) => child.serialize()).join('')}</${this.tagName}>`;
  }
}

class FakeDocument extends FakeNode {
  constructor() {
    super('#document');
    this.closed = false;
    this.documentElement = new FakeNode('html');
    this.head = new FakeNode('head');
    this.body = new FakeNode('body');
    this.documentElement.append(this.head, this.body);
    this.appendChild(this.documentElement);
  }

  createElement(tagName) {
    return new FakeNode(tagName.toLowerCase());
  }

  createTextNode(value) {
    return new FakeNode('#text', String(value));
  }

  close() {
    this.closed = true;
  }

  serialize() {
    return this.children.map((child) => child.serialize()).join('');
  }

  tags() {
    const tags = [];
    const visit = (node) => {
      if (node.tagName !== '#document' && node.tagName !== '#text') tags.push(node.tagName);
      node.children.forEach(visit);
    };
    visit(this);
    return tags;
  }
}

const PAYLOADS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '"><svg/onload=alert(1)>'
];

test('transaction print treats product, contact and category payloads as literal text', () => {
  const document = new FakeDocument();
  populatePrintDocument(document, {
    title: 'Receipt',
    metadata: [{ label: 'Customer', value: PAYLOADS[1] }],
    headers: ['Product', 'Category'],
    rows: [[PAYLOADS[0], PAYLOADS[2]]]
  });

  assert.match(document.textContent, /<script>alert\(1\)<\/script>/);
  assert.match(document.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.match(document.textContent, /<svg\/onload=alert\(1\)>/);
  assert.equal(document.tags().includes('script'), false);
  assert.equal(document.tags().includes('img'), false);
  assert.equal(document.tags().includes('svg'), false);
});

test('report title, summary, headers and cells are emitted as escaped text nodes', () => {
  const document = new FakeDocument();
  populatePrintDocument(document, {
    title: PAYLOADS[0],
    summary: PAYLOADS[1],
    headers: [PAYLOADS[2]],
    rows: [[PAYLOADS[0]]]
  });

  const serialized = document.serialize();
  assert.match(serialized, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(serialized, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(serialized, /<script>|<img|<svg/i);
});

test('printing remains functional and severs the popup opener', () => {
  const document = new FakeDocument();
  let focused = false;
  let printed = false;
  const popup = {
    document,
    opener: {},
    focus: () => { focused = true; },
    print: () => { printed = true; }
  };

  const opened = openPrintDocument({
    title: 'Receipt',
    headers: ['Product'],
    rows: [['Safe product']]
  }, 'width=800,height=900', () => popup);

  assert.equal(opened, true);
  assert.equal(popup.opener, null);
  assert.equal(document.closed, true);
  assert.equal(focused, true);
  assert.equal(printed, true);
});

test('blocked popups fail safely without attempting to print', () => {
  assert.equal(openPrintDocument({ title: 'Receipt', headers: [], rows: [] }, undefined, () => null), false);
});

test('frontend source no longer contains raw HTML injection sinks', () => {
  const sourceRoot = path.resolve(__dirname, '../../src');
  const files = [];
  const collect = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const item = path.join(directory, entry.name);
      if (entry.isDirectory()) collect(item);
      else if (/\.(?:js|jsx|ts|tsx)$/.test(entry.name)) files.push(item);
    }
  };
  collect(sourceRoot);
  const source = files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');

  assert.doesNotMatch(source, /document\.(?:write|writeln)\s*\(/);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/);
  assert.doesNotMatch(source, /\.(?:innerHTML|outerHTML)\s*=/);
  assert.doesNotMatch(source, /insertAdjacentHTML\s*\(/);
  assert.doesNotMatch(source, /\beval\s*\(|new Function\s*\(/);
});
