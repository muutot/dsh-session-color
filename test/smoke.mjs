// 前端半侧冒烟测试：mock 环境验证官方菜单 / CSS / RPC 信封 / 深浅主题。
// 硬规则：只走官方 contextMenus，不测也不允许任何自绘浮层退路。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'client', 'client.js'), 'utf8');

/** 在给定 sandbox 里执行插件源码并返回导出的模块。 */
function loadModule(sandbox, getRegistration) {
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  const registration = getRegistration ? getRegistration() : sandbox.window.registration;
  if (!registration || registration.id !== '@muutot/dsh-session-color') throw new Error('module did not register');
  // 源码现在 require('react') + require('react/jsx-runtime') 注册官方 icon 组件，
  // 给最小 stub 让 factory 能执行（测试不真的渲染组件）。
  const jsxStub = (tag, props) => ({ tag, props });
  const stubRequire = (id) => {
    if (id === 'react') return { createElement: jsxStub, useState: () => [undefined, () => {}] };
    if (id === 'react/jsx-runtime') return { jsx: jsxStub, jsxs: jsxStub, Fragment: Symbol('Fragment') };
    return {};
  };
  const mod = registration.factory(stubRequire);
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
    contextMenus: menus,
    slots: {
      inject: (name, factory) => { const d = factory(); return typeof d === 'function' ? d : () => {}; },
      register: (info, component) => () => {},
    },
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
    body: { hasAttribute: (k) => Object.prototype.hasOwnProperty.call(bodyAttrs, k), className: '', appendChild() {}, removeChild() {} },
    getElementById: () => styleEl,
    createElement: () => fakeInput(),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  function fakeInput() {
    return {
      type: '', value: '', style: {}, attrs: {},
      setAttribute(k, v) { this.attrs[k] = v; },
      addEventListener() {}, removeEventListener() {}, click() {},
      parentNode: null,
    };
  }

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

  // 官方菜单 + slots 是硬依赖；inject 必须声明，且不得有任何自绘退路。
  if (JSON.stringify(mod.inject) !== JSON.stringify(['connection', 'contextMenus', 'slots'])) {
    throw new Error('inject must be ["connection","contextMenus","slots"], got ' + JSON.stringify(mod.inject));
  }
  if (/installDomMenu|dsc-menu|MENU_CSS|dsc-item/.test(source)) {
    throw new Error('self-drawn menu code must not exist in client.js');
  }

  mod.apply(fakeCtx);
  await Promise.resolve();
  await Promise.resolve();

  if (!registration || typeof registration.resolve !== 'function') throw new Error('context menu not registered');
  const actions = registration.resolve({ sessionId: 'abc123' });
  if (actions.length !== 1 || actions[0].children.length !== 11) {
    throw new Error('menu shape wrong: ' + JSON.stringify(actions));
  }
  // 9 预设 + 1 自定义，都带官方 icon:{key,src}（SVG data URI 色块）；清除项无 icon。
  for (let i = 0; i < 10; i++) {
    const icon = actions[0].children[i].icon;
    if (!icon || typeof icon.key !== 'string' || !icon.key.startsWith('dsh-session-color.swatch.')) {
      throw new Error('color action missing official icon key: ' + i);
    }
    if (!icon.src || !icon.src.startsWith('data:image/svg+xml')) {
      throw new Error('color action missing swatch src: ' + i);
    }
  }
  const customItem = actions[0].children[9];
  if (customItem.id !== 'custom' || !customItem.label.includes('自定义颜色')) {
    throw new Error('custom color action missing: ' + JSON.stringify(customItem));
  }
  if (actions[0].children[10].id !== 'clear' || actions[0].children[10].icon !== undefined) {
    throw new Error('clear action should be last with no icon');
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

  // 自定义色：深浅两主题都用用户选的同一个 hex（所见即所得）。
  fakeCtx.connection.rpc.call = async (channel, endpoint, payload) => {
    rpcCalls.push({ channel, endpoint, payload });
    return { ok: true, value: { colors: { abc123: 'custom:#1a2b3c' } } };
  };
  actions[0].children[0].run();
  await Promise.resolve(); await Promise.resolve();
  if (!styleEl.textContent.includes('background-color:#1a2b3c')) throw new Error('custom color CSS missing');
  bodyAttrs['data-ds-dark-theme'] = '';
  actions[0].children[0].run();
  await Promise.resolve(); await Promise.resolve();
  if (!styleEl.textContent.includes('background-color:#1a2b3c')) throw new Error('custom color changed with theme');
  delete bodyAttrs['data-ds-dark-theme'];

  console.log('SMOKE OK (official contextMenus path)');
  console.log('  css:', styleEl.textContent.replace(/\n/g, ' '));
  console.log('  effects:', effects.map((e) => e.label).join(', '));
}

//#region 自绘取色面板：点「确定」才落盘，取消/Esc/非法值不落盘（Muu 2026-11-22）
{
  let registration = null;
  const rpcCalls = [];
  const effects = [];
  const rpcValue = { colors: {} };
  const menus = { register: (input) => { registration = input; return () => {}; } };

  // 能记录子元素与事件处理器的最小 DOM。
  function el(tag) {
    const node = {
      tag, children: [], style: {}, attrs: {}, value: '', textContent: '',
      parentNode: null, listeners: {},
      get id() { return this.attrs.id; },
      set id(v) { this.attrs.id = v; },
      setAttribute(k, v) { this.attrs[k] = v; },
      appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
      removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; },
      addEventListener(t, h) { (this.listeners[t] ||= []).push(h); },
      removeEventListener(t, h) { this.listeners[t] = (this.listeners[t] || []).filter((x) => x !== h); },
      dispatch(t, e = {}) { for (const h of [...(this.listeners[t] || [])]) h(e); },
      contains(x) { return x === this || this.children.some((c) => c.contains && c.contains(x)); },
      focus() {}, select() {},
    };
    return node;
  }

  const body = el('body');
  const docListeners = {};
  const byId = new Map();
  const fakeDocument = {
    documentElement: { getAttribute: () => '', className: '' },
    head: { appendChild(c) { if (c.id) byId.set(c.id, c); } },
    body: {
      hasAttribute: () => false, className: '',
      appendChild(c) { body.appendChild(c); }, removeChild(c) { body.removeChild(c); },
    },
    getElementById: (id) => byId.get(id) || null,
    createElement: (tag) => el(tag),
    addEventListener: (t, h) => { (docListeners[t] ||= []).push(h); },
    removeEventListener: (t, h) => { docListeners[t] = (docListeners[t] || []).filter((x) => x !== h); },
  };
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (r) => { registration = r; } },
      innerWidth: 1280, innerHeight: 800,
    },
    document: fakeDocument,
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout: (fn) => { /* 面板测试不跑延时监听挂载 */ return 0; },
    clearTimeout: () => {},
    Request: class {}, URL, Object, JSON, console,
  };
  const jsxStub = (tag, props) => ({ tag, props });
  const stubRequire = (id) => {
    if (id === 'react') return { createElement: jsxStub, useState: () => [undefined, () => {}] };
    if (id === 'react/jsx-runtime') return { jsx: jsxStub, jsxs: jsxStub, Fragment: Symbol('F') };
    return {};
  };
  const mod = registration ? null : null;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  const m = registration.factory(stubRequire);
  const fakeCtx = {
    connection: { rpc: { call: async (ch, ep, payload) => {
      rpcCalls.push({ ep, payload });
      if (ep === 'colors.list') return { ok: true, value: rpcValue };
      if (ep === 'colors.set') {
        if (payload.key === null) delete rpcValue.colors[payload.sessionId];
        else rpcValue.colors[payload.sessionId] = payload.key;
        return { ok: true, value: rpcValue };
      }
    } } },
    contextMenus: menus,
    slots: { inject: (n, f) => { const d = f(); return () => {}; }, register: () => () => {} },
    effect: (fn) => { const c = fn(); effects.push(c); return () => { if (typeof c === 'function') c(); }; },
  };
  m.apply(fakeCtx);
  const actions = registration.resolve({ sessionId: 's1' });
  const custom = actions[0].children[9];

  // 先模拟右键会话行：面板应锚定这个右键坐标，而不是菜单项坐标。
  for (const h of docListeners.contextmenu || []) h({ clientX: 321, clientY: 456 });

  // 打开面板：应创建一个浮层，且此时不落盘。
  const before = rpcCalls.length;
  custom.run();
  const panel = body.children.find((c) => c.attrs.id === 'dsh-session-color-picker');
  if (!panel) throw new Error('picker panel not created');
  if (rpcCalls.length !== before) throw new Error('opening picker must not write color');
  if (panel.style.left !== '321px' || panel.style.top !== '456px') {
    throw new Error('picker must anchor at right-click position, got ' + panel.style.left + ',' + panel.style.top);
  }

  // 面板内要有原生取色器控件（type=color），点它可打开系统色盘。
  const row = panel.children[1];
  const colorInput = row.children[0];
  const hexInput = row.children[1];
  if (colorInput.type !== 'color') throw new Error('picker panel must contain a native color input');
  // 系统色盘选色 → 同步到 hex 框 + 实时预览到会话行（不落盘）。
  colorInput.value = '#0a0b0c';
  colorInput.dispatch('change');
  if (hexInput.value !== '#0a0b0c') throw new Error('color picker change must sync hex input');
  const previewStyle = byId.get('dsh-session-color-preview');
  if (!previewStyle || !previewStyle.textContent.includes('background-color:#0a0b0c')) {
    throw new Error('color picker change must preview on session row');
  }
  if (rpcCalls.some((c) => c.ep === 'colors.set')) throw new Error('preview must not persist');

  const btns = panel.children[2];
  const [cancelBtn, okBtn] = btns.children;

  // 非法值点确定 → 不落盘、面板还在。
  hexInput.value = 'nope';
  okBtn.dispatch('click');
  if (rpcCalls.some((c) => c.ep === 'colors.set')) throw new Error('invalid hex must not commit');
  if (!body.children.includes(panel)) throw new Error('invalid hex should keep panel open');

  // 合法值点确定 → 落盘 custom:#abcdef，面板关闭。
  hexInput.value = '#abcdef';
  hexInput.dispatch('input');
  okBtn.dispatch('click');
  const set = rpcCalls.find((c) => c.ep === 'colors.set');
  if (!set || set.payload.key !== 'custom:#abcdef') throw new Error('confirm must commit custom color');
  if (body.children.includes(panel)) throw new Error('panel should close after confirm');

  // 取消路径：重新打开，输入合法值但点取消 → 不新增落盘。
  const beforeCancel = rpcCalls.filter((c) => c.ep === 'colors.set').length;
  custom.run();
  const panel2 = body.children.find((c) => c.attrs.id === 'dsh-session-color-picker');
  const hex2 = panel2.children[1].children[1];
  const cancel2 = panel2.children[2].children[0];
  hex2.value = '#123456';
  hex2.dispatch('input');
  cancel2.dispatch('click');
  if (rpcCalls.filter((c) => c.ep === 'colors.set').length !== beforeCancel) {
    throw new Error('cancel must not commit');
  }
  // 取消后实时预览必须清掉，会话行恢复原色。
  if (byId.get('dsh-session-color-preview').textContent !== '') {
    throw new Error('cancel must clear live preview');
  }

  console.log('SMOKE OK (custom picker: preview live, confirm commits, cancel/invalid do not)');
}

