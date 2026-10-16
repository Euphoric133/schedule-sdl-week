/**
 * 界面启动冒烟测试（无浏览器、无第三方依赖）。
 *
 * 为什么需要：领域层与服务层的测试再全，也挡不住"界面在启动时就报错"这种低级但致命的问题。
 * 这里用一个**最小 DOM 打桩**（只实现代码真正用到的那几个 API）让 `src/main.js` 的浏览器分支执行起来，
 * 从而验证：模块导入无循环依赖错误、六条路由都能渲染、渲染过程不抛异常、时间轴表头正确生成。
 *
 * 局限（必须说明）：打桩 DOM 不能验证 CSS 布局、真实点击与焦点行为。
 * 那部分由 docs/ACCEPTANCE.md 的人工步骤覆盖。若将来引入 jsdom，可把本文件替换为真实 DOM 测试。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));

/* ------------------------------------------------------------------ *
 * 最小 DOM / BOM 打桩
 * ------------------------------------------------------------------ */

class FakeClassList {
  constructor(owner) {
    this.owner = owner;
    this.set = new Set();
  }
  add(...names) {
    for (const name of names) {
      if (!name) continue;
      this.set.add(name);
      this.owner._className = [...this.set].join(' ');
    }
  }
  contains(name) {
    return this.set.has(name);
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.style = {
      setProperty(name, value) {
        this[name] = value;
      },
      getPropertyValue(name) {
        return this[name] ?? '';
      },
      removeProperty(name) {
        delete this[name];
        return '';
      },
    };
    this.dataset = {};
    this.listeners = new Map();
    this._className = '';
    this._text = '';
    this.classList = new FakeClassList(this);
    this.value = '';
    this.checked = false;
    this.open = false;
  }

  get className() {
    return this._className;
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
    this.children = [];
    this._text = '';
    this._innerHTML = String(value);
  }
  get innerHTML() {
    return this._innerHTML ?? '';
  }

  get firstChild() {
    return this.children[0] ?? null;
  }

  appendChild(child) {
    if (child === null || child === undefined) return child;
    if (child.__isFragment) {
      for (const node of child.children) this.appendChild(node);
      return child;
    }
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
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
  hasAttribute(name) {
    return this.attributes.has(name);
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  removeEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    const index = list.indexOf(handler);
    if (index >= 0) list.splice(index, 1);
  }

  /** 触发事件（测试用，便于验证交互不抛异常） */
  dispatch(type, event = {}) {
    for (const handler of this.listeners.get(type) ?? []) handler({ target: this, preventDefault() {}, ...event });
  }

  focus() {
    this.focused = true;
  }

  click() {
    this.dispatch('click', {});
  }

  showModal() {
    this.open = true;
    this.dispatch('show', {});
  }

  close() {
    this.open = false;
    this.dispatch('close', {});
  }

  /** 递归收集所有后代，便于断言渲染结果 */
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

  /** 按 class 查找后代 */
  byClass(className) {
    return this.all().filter((node) => node.classList.contains(className));
  }

  scrollIntoView() {}

  querySelectorAll(selector) {
    const name = selector.replace(/^\./, '');
    return this.byClass(name);
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

function installFakeDom() {
  const body = new FakeElement('body');
  const documentElement = new FakeElement('html');
  const toastHost = new FakeElement('div');
  toastHost.id = 'toast-host';
  const appHost = new FakeElement('div');
  appHost.id = 'app';
  body.appendChild(appHost);
  body.appendChild(toastHost);

  const document = {
    documentElement,
    body,
    getElementById: (id) => body.all().find((node) => node.id === id) ?? (id === 'app' ? appHost : id === 'toast-host' ? toastHost : null),
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

  const storageMap = new Map();
  const localStorage = {
    getItem: (key) => (storageMap.has(key) ? storageMap.get(key) : null),
    setItem: (key, value) => storageMap.set(key, String(value)),
    removeItem: (key) => storageMap.delete(key),
    clear: () => storageMap.clear(),
  };

  const location = { hash: '' };
  const window = {
    location,
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: (cb) => {
      if (typeof cb === 'function') cb(0);
      return 1;
    },
  };

  // router.js 使用 globalThis.addEventListener 监听 hash 变化
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
  // dom.js 用 `child instanceof Node` 区分文本节点与元素，因此需要把打桩元素注册为 Node
  globalThis.Node = FakeElement;
  globalThis.document = document;
  globalThis.window = window;
  globalThis.location = location;
  globalThis.localStorage = localStorage;
  globalThis.requestAnimationFrame = window.requestAnimationFrame;
  globalThis.getComputedStyle = () => ({
    getPropertyValue: (name) => (name === '--timeline-hour-height' ? '56px' : ''),
  });

  return { document, body, appHost, toastHost, localStorage, location, window };
}

/* ------------------------------------------------------------------ *
 * 测试
 * ------------------------------------------------------------------ */

test('界面启动：加载 src/main.js 能渲染外壳，并逐条渲染六个页面而不抛异常', async () => {
  const dom = installFakeDom();
  const mainUrl = pathToFileURL(join(projectRoot, 'src', 'main.js')).href;

  // main.js 在检测到 document 与 #app 时会自动 boot()，并把实例挂到 globalThis.__APP__
  await import(mainUrl);
  const module = globalThis.__APP__;
  assert.ok(module?.shell, '启动后应暴露 shell 实例（globalThis.__APP__）');

  const appShell = dom.appHost.children[0];
  assert.ok(appShell, '应渲染出应用外壳');
  assert.ok(appShell.classList.contains('app'), `外壳应带 .app 类，实际：${appShell.className}`);
  assert.ok(appShell.byClass('app-nav__link').length >= 9, '侧边导航应包含全部九个页面入口');
  assert.ok(appShell.byClass('app-topbar').length === 1, '应渲染顶栏');
  assert.ok(appShell.byClass('app-main').length === 1, '应渲染主内容区');

  // 数据被写入本地存储（首次启动会落盘空状态）
  const stored = dom.localStorage.getItem('studyPlanner:v1:state');
  assert.ok(stored, '首次启动应把初始状态写入 localStorage');
  const parsed = JSON.parse(stored);
  assert.deepEqual(parsed.tasks, [], '初始状态不得包含任何虚构任务');
  assert.equal(parsed.schemaVersion, 1);

  // 逐条路由渲染（覆盖六个页面 + 未知路由 + 带参数的 week 路由）
  const routes = [
    '#/today',
    '#/week',
    '#/week?offset=1',
    '#/day',
    '#/day?date=2025-10-18',
    '#/tasks',
    '#/activities',
    '#/preview',
    '#/versions',
    '#/settings',
    '#/focus',
    '#/unknown-page',
  ];
  for (const hash of routes) {
    dom.location.hash = hash;
    assert.doesNotThrow(() => module.shell.render(), `渲染 ${hash} 时不应抛异常`);
    const main = dom.appHost.children[0].byClass('app-main')[0];
    assert.ok(main.children.length > 0, `${hash} 应渲染出内容`);
  }

  // 未知路由必须给出明确提示，而不是空白页
  dom.location.hash = '#/definitely-not-a-page';
  module.shell.render();
  const main = dom.appHost.children[0].byClass('app-main')[0];
  assert.ok(main.all().some((node) => /页面不存在/.test(node.textContent)), '未知路由应提示"页面不存在"');

  // 环境清理：避免影响同一进程中的其它测试文件
  delete globalThis.Node;
  delete globalThis.Node;
  delete globalThis.addEventListener;
  delete globalThis.removeEventListener;
  delete globalThis.document;
  delete globalThis.window;
  delete globalThis.location;
  delete globalThis.localStorage;
  delete globalThis.requestAnimationFrame;
  delete globalThis.getComputedStyle;
});

test('界面渲染：七天计划页生成 7 个日期表头与 18 个整点刻度', async () => {
  const dom = installFakeDom();
  // 直接调用 boot()：不依赖模块缓存，让每个测试互相独立
  const { boot } = await import(pathToFileURL(join(projectRoot, 'src', 'main.js')).href);
  const instance = boot({ root: dom.appHost });
  const module = instance;

  dom.location.hash = '#/week';
  module.shell.render();

  const main = dom.appHost.children[0].byClass('app-main')[0];
  const dayHeads = main.byClass('timeline__day-head');
  const hours = main.byClass('timeline__hour');

  assert.equal(dayHeads.length, 7, '时间轴应有 7 个日期表头（今天 + 之后 6 天）');
  assert.equal(hours.length, 18, '06:00–24:00 应有 18 个整点刻度');
  assert.equal(hours[0].textContent, '06:00', '第一个刻度应为 06:00');
  assert.equal(hours[hours.length - 1].textContent, '23:00', '最后一个刻度应为 23:00');

  delete globalThis.Node;
  delete globalThis.addEventListener;
  delete globalThis.removeEventListener;
  delete globalThis.document;
  delete globalThis.window;
  delete globalThis.location;
  delete globalThis.localStorage;
  delete globalThis.requestAnimationFrame;
  delete globalThis.getComputedStyle;
});

test('界面渲染：有待确认候选计划时，预览页显示差异明细与确认按钮', async () => {
  const dom = installFakeDom();
  const { boot } = await import(pathToFileURL(join(projectRoot, 'src', 'main.js')).href);
  const instance = boot({ root: dom.appHost });

  // 通过服务层真实生成一份候选计划（等价于用户点了"生成七天计划"）
  const created = instance.services.taskService.addTask({
    title: '线性代数作业',
    subject: '数学',
    plannedMinutes: 90,
    deadlineDate: '2025-10-20',
    deadlineTime: '23:00',
    importance: 4,
    difficulty: 4,
    procrastination: 3,
    splittable: true,
    minChunkMinutes: 30,
    maxChunkMinutes: 60,
    dependsOn: [],
    note: '',
  });
  assert.equal(created.ok, true, created.issues?.map((i) => i.message).join('; '));

  const preview = instance.services.planService.requestPreview({ now: instance.services.now(), changeSummary: '生成第一份计划' });
  assert.equal(preview.ok, true, preview.issues?.map((i) => i.message).join('; '));

  dom.location.hash = '#/preview';
  instance.shell.render();

  const main = dom.appHost.children[0].byClass('app-main')[0];
  const texts = main.all().map((node) => node.textContent).join('\n');

  assert.match(texts, /候选计划/, '应显示候选计划卡片');
  assert.match(texts, /新增时段/, '差异里应显示新增时段');
  assert.match(texts, /每日学习量/, '应显示每日指标变化');
  assert.match(texts, /截止风险评估|可按期完成|时间较紧/, '应显示风险评估');
  assert.ok(
    main.all().some((node) => node.textContent === '确认应用'),
    '应提供"确认应用"按钮',
  );
  assert.ok(
    main.all().some((node) => node.textContent === '放弃修改'),
    '应提供"放弃修改"按钮',
  );

  delete globalThis.Node;
  delete globalThis.addEventListener;
  delete globalThis.removeEventListener;
  delete globalThis.document;
  delete globalThis.window;
  delete globalThis.location;
  delete globalThis.localStorage;
  delete globalThis.requestAnimationFrame;
  delete globalThis.getComputedStyle;
});

test('界面渲染：工作台在进行中会显示计时与"结束本段"操作（阶段 4 计时分支）', async () => {
  const dom = installFakeDom();
  const { boot } = await import(pathToFileURL(join(projectRoot, 'src', 'main.js')).href);
  const instance = boot({ root: dom.appHost });

  instance.services.taskService.addTask({
    title: '线性代数作业',
    subject: '数学',
    plannedMinutes: 90,
    deadlineDate: '2025-10-20',
    deadlineTime: '23:00',
    importance: 4,
    difficulty: 4,
    procrastination: 3,
    splittable: true,
    minChunkMinutes: 30,
    maxChunkMinutes: 60,
    dependsOn: [],
    note: '',
  });
  const preview = instance.services.planService.requestPreview({ now: instance.services.now(), changeSummary: '生成计划' });
  assert.equal(preview.ok, true, preview.issues?.map((i) => i.message).join('; '));
  assert.equal(instance.services.planService.applyPreview().ok, true);

  const session = instance.app.getState().sessions.find((item) => item.state === 'flexible');
  assert.ok(session, '应有一个待进行的时段');
  assert.equal(instance.services.focusService.start(session.id).ok, true);

  dom.location.hash = '#/focus';
  instance.shell.render();

  const main = dom.appHost.children[0].byClass('app-main')[0];
  const texts = main.all().map((node) => node.textContent).join('\n');
  assert.match(texts, /正在专注/, '进行中应显示"正在专注"');
  assert.match(texts, /剩余时间/, '应显示剩余时间');
  assert.ok(main.all().some((node) => node.textContent === '暂停'), '应提供暂停按钮');
  assert.ok(main.all().some((node) => node.textContent === '结束本段…'), '应提供结束按钮');
  assert.match(texts, /已锁定/, '进行中的时段会被自动锁定');

  // 暂停后状态文案变化
  assert.equal(instance.services.focusService.pause(session.id, { elapsedMinutes: 12 }).ok, true);
  instance.shell.render();
  const pausedMain = dom.appHost.children[0].byClass('app-main')[0];
  const pausedTexts = pausedMain.all().map((node) => node.textContent).join('\n');
  assert.match(pausedTexts, /已暂停/, '暂停后应显示已暂停');
  assert.ok(pausedMain.all().some((node) => node.textContent === '继续计时'), '暂停后应提供继续计时');

  delete globalThis.Node;
  delete globalThis.addEventListener;
  delete globalThis.removeEventListener;
  delete globalThis.document;
  delete globalThis.window;
  delete globalThis.location;
  delete globalThis.localStorage;
  delete globalThis.requestAnimationFrame;
  delete globalThis.getComputedStyle;
});

test('界面渲染：空数据时每个页面都显示空状态而不是崩溃或假数据', async () => {
  const dom = installFakeDom();
  const { boot } = await import(pathToFileURL(join(projectRoot, 'src', 'main.js')).href);
  const module = boot({ root: dom.appHost });

  for (const hash of ['#/today', '#/tasks', '#/focus', '#/preview']) {
    dom.location.hash = hash;
    module.shell.render();
    const main = dom.appHost.children[0].byClass('app-main')[0];
    const hasState = main.byClass('state').length > 0 || main.all().some((node) => /还没有|暂无|没有/.test(node.textContent));
    assert.ok(hasState, `${hash} 在空数据时应给出明确的空状态说明`);
  }

  // 偏好设置页在阶段 3 提供图形化编辑区（可学习时间 / 排程参数 / 权重）
  dom.location.hash = '#/settings';
  module.shell.render();
  const settingsMain = dom.appHost.children[0].byClass('app-main')[0];
  const settingsText = settingsMain.all().map((node) => node.textContent).join('\n');
  assert.match(settingsText, /可学习时间（按星期）/, '应提供可学习时间的图形化编辑');
  assert.match(settingsText, /排程参数/, '应提供排程参数的图形化编辑');
  assert.match(settingsText, /优先级权重/, '应提供权重编辑');
  assert.match(settingsText, /高级：设置 JSON 编辑/, 'JSON 编辑降级为高级入口');
  assert.match(settingsText, /数据与备份/, '应显示存储与备份信息');
  assert.match(settingsText, /清理历史记录/, '应提供清理历史入口');
  assert.match(settingsText, /受保护的记录/, '清理面板必须说明哪些记录受保护');

  // 每日视图应显示当天容量与时间轴
  dom.location.hash = '#/day';
  module.shell.render();
  const dayMain = dom.appHost.children[0].byClass('app-main')[0];
  assert.ok(dayMain.byClass('timeline__hour').length === 18, '每日视图也应有 18 个整点刻度');
  assert.ok(
    dayMain.all().some((node) => /当日容量与安排/.test(node.textContent)),
    '每日视图应展示当天容量',
  );

  delete globalThis.Node;
  delete globalThis.addEventListener;
  delete globalThis.removeEventListener;
  delete globalThis.document;
  delete globalThis.window;
  delete globalThis.location;
  delete globalThis.localStorage;
  delete globalThis.requestAnimationFrame;
  delete globalThis.getComputedStyle;
});
