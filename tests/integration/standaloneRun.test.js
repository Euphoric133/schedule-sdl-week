/**
 * 单文件版本运行测试：直接执行 dist/standalone.html 里的内联脚本，验证它真的能启动。
 *
 * 为什么值得做：
 * 语法正确 ≠ 能跑起来。模块注册表、导入解构、初始化顺序任何一处有问题，
 * 双击文件时才会暴露。这里用一个最小 DOM 打桩，把内联脚本真正执行一遍并断言：
 * 应用外壳被渲染、六个导航入口存在、初始状态写入存储。
 *
 * 局限：不验证 CSS 布局与真实点击（那由 docs/ACCEPTANCE.md 的人工步骤覆盖）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const projectRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const DIST_FILE = join(projectRoot, 'dist', 'standalone.html');

/** 最小 DOM 打桩（与 tests/integration/ui-smoke.test.js 保持同一套行为） */
class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.dataset = {};
    this.listeners = new Map();
    this.classList = {
      set: new Set(),
      add: (...names) => {
        for (const name of names) if (name) this.classList.set.add(name);
        this._className = [...this.classList.set].join(' ');
      },
      contains: (name) => this.classList.set.has(name),
    };
    this.style = {
      setProperty(name, value) {
        this[name] = value;
      },
      getPropertyValue(name) {
        return this[name] ?? '';
      },
    };
    this._text = '';
    this.value = '';
    this.checked = false;
  }

  get className() {
    return this._className ?? '';
  }
  set className(value) {
    this._className = String(value);
    this.classList.set = new Set(String(value).split(/\s+/).filter(Boolean));
  }

  get textContent() {
    return this._text;
  }
  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }
  set innerHTML(value) {
    this._innerHTML = String(value);
  }
  get innerHTML() {
    return this._innerHTML ?? '';
  }
  get firstChild() {
    return this.children[0] ?? null;
  }

  appendChild(child) {
    if (!child) return child;
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    return child;
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  setAttribute(name, value) {
    this.attributes.set(name, value);
    if (name === 'class') this.className = value;
    if (name === 'id') this.id = value;
    if (name === 'value') this.value = value;
    if (name === 'disabled') this.disabled = true;
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  removeEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    const idx = list.indexOf(handler);
    if (idx >= 0) list.splice(idx, 1);
  }
  focus() {}
  click() {}
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
  scrollIntoView() {}
  querySelectorAll() {
    return [];
  }
  querySelector() {
    return null;
  }
  all() {
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  byClass(name) {
    return this.all().filter((node) => node.classList.contains(name));
  }
}

function createSandbox() {
  const appHost = new FakeElement('div');
  appHost.id = 'app';
  const toastHost = new FakeElement('div');
  toastHost.id = 'toast-host';
  const body = new FakeElement('body');
  body.appendChild(appHost);
  body.appendChild(toastHost);

  const storageMap = new Map();
  const location = { hash: '' };

  const document = {
    documentElement: new FakeElement('html'),
    body,
    getElementById: (id) => (id === 'app' ? appHost : id === 'toast-host' ? toastHost : null),
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (text) => {
      const node = new FakeElement('#text');
      node.textContent = text;
      return node;
    },
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };

  const sandbox = {
    document,
    window: { location, addEventListener() {}, removeEventListener() {} },
    location,
    localStorage: {
      getItem: (key) => (storageMap.has(key) ? storageMap.get(key) : null),
      setItem: (key, value) => storageMap.set(key, String(value)),
      removeItem: (key) => storageMap.delete(key),
      clear: () => storageMap.clear(),
    },
    requestAnimationFrame: (cb) => {
      if (typeof cb === 'function') cb(0);
      return 1;
    },
    getComputedStyle: () => ({ getPropertyValue: () => '56px' }),
    setTimeout: (cb) => {
      if (typeof cb === 'function') cb();
      return 0;
    },
    clearTimeout: () => {},
    console,
    Node: FakeElement,
    URL,
    URLSearchParams,
    Blob: class {},
    Date,
    Math,
    JSON,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.addEventListener = () => {};
  sandbox.removeEventListener = () => {};

  return { sandbox, appHost, storageMap };
}

test('单文件版本：内联脚本能在最小 DOM 环境中启动并渲染应用外壳', async () => {
  const html = await readFile(DIST_FILE, 'utf8');
  const start = html.indexOf('<script>') + '<script>'.length;
  const end = html.lastIndexOf('</script>');
  const scriptBody = html.slice(start, end);
  assert.ok(scriptBody.length > 1000, '内联脚本不应为空');

  const { sandbox, appHost, storageMap } = createSandbox();
  const context = vm.createContext(sandbox);

  // 执行内联脚本：任何模块注册表/导入解构/初始化顺序的问题都会在这里暴露
  assert.doesNotThrow(() => {
    vm.runInContext(scriptBody, context, { filename: 'standalone.html' });
  }, '内联脚本必须能无异常执行');

  const shell = appHost.children[0];
  assert.ok(shell, '应渲染出应用外壳');
  assert.ok(shell.classList.contains('app'), `外壳应带 .app 类，实际：${shell.className}`);
  assert.ok(shell.byClass('app-nav__link').length >= 6, '侧边导航应包含全部六个页面入口');
  assert.ok(shell.byClass('app-main').length === 1, '应渲染主内容区');

  const stored = storageMap.get('studyPlanner:v1:state');
  assert.ok(stored, '首次启动应把初始状态写入 localStorage');
  const parsed = JSON.parse(stored);
  assert.equal(parsed.schemaVersion, 1);
  assert.deepEqual(parsed.tasks, [], '初始状态不得包含虚构任务');
});
