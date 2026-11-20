// 前端半侧冒烟测试：mock 环境验证两条菜单路径 / CSS / RPC 信封 / 深浅主题。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'client', 'client.js'), 'utf8');

/** 造一个最小 DOM，够自绘菜单跑起来；记录 document 上的监听器供手动派发。 */
function makeDom() {
  const byId = new Map();
  const documentListeners = new Map();

  class El {
    constructor(tag) {
      this.tagName = tag;
      this.children = [];
      this.style = {};
      this.attrs = {};
      this.className = '';
      this.textContent = '';
      this.parentNode = null;
      this.listeners = {};
    }
    set id(value) { this.attrs.id = value; byId.set(value, this); }
    get id() { return this.attrs.id; }
    setAttribute(name, value) {
      this.attrs[name] = value;
      if (name === 'id') byId.set(value, this);
    }
    getAttribute(name) { return this.attrs[name] ?? null; }
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name); }
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      if (child.attrs && child.attrs.id) byId.set(child.attrs.id, child);
      return child;
    }
    removeChild(child) {
      this.children = this.children.filter((item) => item !== child);
      child.parentNode = null;
      if (child.attrs && child.attrs.id) byId.delete(child.attrs.id);
      return child;
    }
    addEventListener(type, handler) {
      if (!this.listeners[type]) this.listeners[type] = [];
      this.listeners[type].push(handler);
    }
    removeEventListener(type, handler) {
      if (!this.listeners[type]) return;
      this.listeners[type] = this.listeners[type].filter((item) => item !== handler);
    }
    dispatch(type, event = {}) {
      for (const handler of this.listeners[type] || []) handler(event);
    }
    contains(target) {
      return target === this || this.children.includes(target);
    }
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 148, bottom: 300, width: 148, height: 300 };
    }
    closest(selector) {
      return selector === '[data-row-key]' && this.attrs['data-row-key'] ? this : null;
    }
  }

  const head = new El('head');
  const body = new El('body');
  const documentElement = new El('html');
  documentElement.getAttribute = () => '';

  const document = {
    documentElement,
    head,
    body,
    createElement: (tag) => new El(tag),
    getElementById: (id) => byId.get(id) ?? null,
    addEventListener: (type, handler) => { documentListeners.set(type, handler); },
    removeEventListener: (type) => { documentListeners.delete(type); },
  };

  const windowListeners = new Map();
  const window = {
    __ModuleLoader__: { load: (registration) => { window.registration = registration; } },
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener: (type, handler) => { windowListeners.set(type, handler); },
    removeEventListener: (type) => { windowListeners.delete(type); },
  };

  return { El, document, window, byId, documentListeners, windowListeners };
}

/** 在给定 sandbox 里执行插件源码并返回导出的模块。 */
function loadModule(sandbox, getRegistration) {
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  const registration = getRegistration ? getRegistration() : sandbox.window.registration;
  if (!registration || registration.id !== 'dsh-session-color') throw new Error('module did not register');
  const mod = registration.factory(() => ({}));
  if (typeof mod.apply !== 'function') throw new Error('apply not exported');
  if (mod.name !== 'dsh-session-color') throw new Error('name mismatch');
  return mod;
}

//#region 路径 A：有官方 contextMenus 服务
{
  let registration = null;
  const rpcCalls = [];
  const effects = [];

  const menus = {
    register: (input) => { registration = input; return () => { registration = null; }; },
  };

  const fakeCtx = {
    connection: {
      rpc: {
        call: async (channel, endpoint, payload) => {
          rpcCalls.push({ channel, endpoint, payload });
          if (endpoint === 'colors.list') {
            return { ok: true, value: { colors: { abc123: 'green' } } };
          }
          if (endpoint === 'colors.set') {
            return {
              ok: true,
              value: { colors: { ...(payload.key === null ? {} : { [payload.sessionId]: payload.key }) } },
            };
          }
          throw new Error('unexpected endpoint');
        },
      },
    },
    get: (name) => (name === 'contextMenus' ? menus : undefined),
    effect: (fn, label) => {
      const cleanup = fn();
      effects.push({ label, cleanup });
      return () => { if (typeof cleanup === 'function') cleanup(); };
    },
  };

  const documentElementAttrs = { 'data-theme': 'light' };
  const bodyAttrs = {};
  const styleEl = { textContent: '', setAttribute() {}, id: 'dsh-session-color-style' };
  const fakeDocument = {
    documentElement: { getAttribute: (k) => documentElementAttrs[k] ?? '', className: '', appendChild() {} },
    head: { appendChild() {} },
    body: { hasAttribute: (k) => Object.prototype.hasOwnProperty.call(bodyAttrs, k), className: '' },
    getElementById: () => styleEl,
    createElement: () => styleEl,
  };

  const sandbox = {
    window: {
      __ModuleLoader__: { load: (r) => { registration = r; } },
      matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    },
    document: fakeDocument,
    MutationObserver: class { observe() {} disconnect() {} },
    Request: class {},
    URL, Object, JSON, console,
  };

  const mod = loadModule(sandbox, () => registration);

  mod.apply(fakeCtx);
  await Promise.resolve();
  await Promise.resolve();

  if (!registration || typeof registration.resolve !== 'function') throw new Error('context menu not registered');
  const actions = registration.resolve({ sessionId: 'abc123' });
  if (actions.length !== 1 || actions[0].children.length !== 10) {
    throw new Error('menu shape wrong: ' + JSON.stringify(actions));
  }
  if (rpcCalls.length === 0 || rpcCalls[0].endpoint !== 'colors.list') throw new Error('list RPC not called');
  if (!styleEl.textContent.includes('session:abc123')) throw new Error('CSS not generated');
  // 浅色主题必须用浅色值，不能因为系统深色偏好误用深色变体。
  if (!styleEl.textContent.includes('#d9f2dd') || styleEl.textContent.includes('#22472b')) {
    throw new Error('light theme used wrong green: ' + styleEl.textContent);
  }

  // 点一个颜色 → 乐观更新 + set RPC
  actions[0].children[0].run();
  await Promise.resolve();
  await Promise.resolve();
  if (!rpcCalls.some((c) => c.endpoint === 'colors.set' && c.payload.key === 'red')) throw new Error('set RPC not called');
  if (!styleEl.textContent.includes('#fde2e2')) throw new Error('color not applied');

  // 失败信封必须回滚（「闪一下就消失」的回归保护）。
  fakeCtx.connection.rpc.call = async (channel, endpoint, payload) => {
    rpcCalls.push({ channel, endpoint, payload });
    return { ok: false, error: { code: 'bad-request', message: 'boom', details: { issues: [] } } };
  };
  const before = styleEl.textContent;
  actions[0].children[1].run();
  const optimistic = styleEl.textContent;
  if (optimistic === before || !optimistic.includes('#fdebd0')) throw new Error('optimistic orange not rendered');
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  if (styleEl.textContent !== before) throw new Error('failed rpc did not roll back: ' + styleEl.textContent);

  // 深色标记是 body[data-ds-dark-theme]，切主题要用对应色值。
  fakeCtx.connection.rpc.call = async (channel, endpoint, payload) => {
    rpcCalls.push({ channel, endpoint, payload });
    return { ok: true, value: { colors: { abc123: 'green' } } };
  };
  bodyAttrs['data-ds-dark-theme'] = '';
  actions[0].children[3].run();
  await Promise.resolve(); await Promise.resolve();
  if (!styleEl.textContent.includes('#22472b')) throw new Error('dark theme did not use dark green');
  delete bodyAttrs['data-ds-dark-theme'];
  actions[0].children[3].run();
  await Promise.resolve(); await Promise.resolve();
  if (!styleEl.textContent.includes('#d9f2dd')) throw new Error('did not switch back to light green');

  console.log('SMOKE OK (official contextMenus path)');
  console.log('  css:', styleEl.textContent.replace(/\n/g, ' '));
  console.log('  effects:', effects.map((e) => e.label).join(', '));
}

//#region 路径 B：0.2.1-rc.5 无 contextMenus → 自绘菜单
{
  const { El, document, window, byId, documentListeners } = makeDom();
  const rpcCalls = [];

  const sandbox = {
    window,
    document,
    MutationObserver: class { observe() {} disconnect() {} },
    Request: class {},
    URL, Object, JSON, console,
  };

  const mod = loadModule(sandbox);
  // 关键前提：inject 里绝不能再写 contextMenus，否则整条 row 永远 pending。
  if (JSON.stringify(mod.inject) !== JSON.stringify(['connection'])) {
    throw new Error('inject must be ["connection"], got ' + JSON.stringify(mod.inject));
  }

  const ctx = {
    connection: {
      rpc: {
        call: async (channel, endpoint, payload) => {
          rpcCalls.push({ channel, endpoint, payload });
          if (endpoint === 'colors.list') return { ok: true, value: { colors: { s1: 'green' } } };
          return { ok: true, value: { colors: { ...(payload.key === null ? {} : { [payload.sessionId]: payload.key }) } } };
        },
      },
    },
    // 0.2.1 没有该服务：ctx.get 返回 undefined
    get: () => undefined,
    effect: (fn) => { const cleanup = fn(); return () => { if (typeof cleanup === 'function') cleanup(); }; },
  };

  mod.apply(ctx);
  await Promise.resolve();
  await Promise.resolve();

  const row = new El('div');
  row.setAttribute('data-row-key', 'session:s1');
  const onContextMenu = documentListeners.get('contextmenu');
  if (typeof onContextMenu !== 'function') throw new Error('fallback did not listen for contextmenu');

  let prevented = false;
  onContextMenu({
    target: row,
    clientX: 140,
    clientY: 410,
    preventDefault: () => { prevented = true; },
    stopPropagation: () => {},
  });

  if (!prevented) throw new Error('fallback did not preventDefault on session row');
  const menu = byId.get('dsh-session-color-menu');
  if (!menu) throw new Error('fallback menu element missing');
  const items = menu.children.filter((child) => child.className.includes('dsc-item'));
  if (items.length !== 10) throw new Error('fallback menu item count wrong: ' + items.length);
  if (menu.className.includes('dsc-light') === false) throw new Error('fallback menu theme class missing');

  // 点「蓝」（第 6 项）→ set RPC + 颜色生效
  const blue = items[5];
  if (blue.children[1].textContent !== '蓝') throw new Error('palette order changed: ' + blue.children[1].textContent);
  blue.dispatch('click', {
    stopPropagation: () => {},
    preventDefault: () => {},
  });
  await Promise.resolve();
  await Promise.resolve();
  if (!rpcCalls.some((c) => c.endpoint === 'colors.set' && c.payload.key === 'blue')) {
    throw new Error('fallback set RPC not called');
  }
  if (byId.get('dsh-session-color-menu')) throw new Error('menu not closed after pick');

  console.log('SMOKE OK (fallback DOM menu path)');
}
