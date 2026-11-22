// dsh-session-color 前端半侧（浏览器）
//
// 由 dsh-client-modules 通过 /plugins 提供，注册成一条 client row。
// 纯 CJS factory，不用 React/JSX；导出 { name, inject, apply }。
//
// 菜单只走一条路：DSH 官方 contextMenus 服务（ctx.contextMenus.register）。
// 不提供任何自绘浮层/覆盖层退路——用户硬规则：UI 一律用宿主官方扩展点。
//
// 颜色项的色块走官方 contextMenu.icon 扩展点（keyed slot）：
//   动作带 icon:{ key, src }，注册一个 icon 组件把 src 渲染成 14x14 的 <img>。
//   与 open-in-app 的应用图标同一官方机制（ContextMenuApplicationIcon），
//   不是自绘浮层。src 用 data: URI 的纯色 SVG，深浅主题各一份。
//
// 契约（源码查证）：
//   - 会话行 DOM 自带 data-row-key="session:<id>"
//       dsh-client-ui-workspace/lib/client.js:2276
//   - ctx.connection.rpc.call(channel, endpoint, payload)
//       返回 full.result = { ok:true, value } / { ok:false, error }。
//       dsh-client-connection/lib/client.browser.js:1212 / :1288-1298
//   - ctx.contextMenus.register(...)
//       dsh-client-ui-context-menu/README.zh.md:32-38
//       会话注册范例 dsh-client-ui-workspace/lib/client.js:133122。
//   - 官方服务由 dsh-client-ui-context-menu 以 ctx.provide('contextMenus', ...) 暴露
//       （dsh-client-ui-context-menu/lib/client.js ~41324）；本插件在 inject 里
//       声明该服务包，保证加载顺序，服务就绪后才激活本行。

// 注册 id 必须等于 npm 包名：dsh-client-modules 按包名找 factory，
// 对不上就「loaded without registering」+ 重拉一次 → duplicate registration。
// 2026-11-19 包改名 @muutot/dsh-session-color 后这里要跟着改（裸名 id 只在数据键里保留）。
window.__ModuleLoader__.load({
  id: '@muutot/dsh-session-color',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;

    // baseline 模块：官方插件都直接 require，无需在 manifest 里声明。
    const React = require('react');
    const jsxRuntime = require('react/jsx-runtime');

    const RPC_CHANNEL = '/dsh-session-color';
    const ENDPOINTS = { list: 'colors.list', set: 'colors.set' };
    const STYLE_ID = 'dsh-session-color-style';
    const ROW_ATTR = 'data-row-key';

    // 与 shared/contract.mjs 保持一致。
    const PALETTE = [
      { key: 'red', label: '红', color: '#fde2e2', dark: '#5c2b2b' },
      { key: 'orange', label: '橙', color: '#fdebd0', dark: '#5c3a1f' },
      { key: 'yellow', label: '黄', color: '#fbf3c4', dark: '#56491e' },
      { key: 'green', label: '绿', color: '#d9f2dd', dark: '#22472b' },
      { key: 'cyan', label: '青', color: '#d3eef2', dark: '#1f4a51' },
      { key: 'blue', label: '蓝', color: '#dbe8fb', dark: '#263c5c' },
      { key: 'purple', label: '紫', color: '#ece0f7', dark: '#3f2b57' },
      { key: 'pink', label: '粉', color: '#fbe0ef', dark: '#572a45' },
      { key: 'gray', label: '灰', color: '#e8eaed', dark: '#3a3d42' },
    ];

    const name = 'dsh-session-color';
    // 官方菜单服务 + slots 都是硬依赖：inject 后由 Cordis 保证服务就绪才激活本行。
    const inject = ['connection', 'contextMenus', 'slots'];

    const BY_KEY = Object.fromEntries(PALETTE.map((p) => [p.key, p]));

    // 自定义色：存储形如 custom:#aabbcc，与 shared/contract.mjs 一致。
    // 自定义色深浅主题都用用户选的同一个 hex（所见即所得）。
    const CUSTOM_KEY_PREFIX = 'custom:';
    const HEX_RE = /^#[0-9a-fA-F]{6}$/;

    // 右键锚点：contextmenu 事件触发时记录，作为自定义面板的定位基准。
    // 面板要出现在「当初右键会话行」的位置，而不是后来点菜单项的位置。
    let menuAnchor = { x: 0, y: 0 };

    // 官方 contextMenu.icon 的 key 前缀；每个色块一个稳定 key。
    const ICON_KEY_PREFIX = 'dsh-session-color.swatch.';

    /** 生成 14x14 纯色圆角色块的 data: SVG（深浅主题各一份）。 */
    function swatchSrc(hex) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14"><rect x="0.5" y="0.5" width="13" height="13" rx="3" fill="${hex}" stroke="rgba(127,127,127,.45)"/></svg>`;
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    }

    /**
     * 注册到官方 keyed slot 'contextMenu.icon' 的色块组件。
     * 官方把动作的 icon 元数据（{ key, src }）作为 props.icon 传进来。
     * 用 <img src> 显示，与 open-in-app 的 ContextMenuApplicationIcon 同一机制。
     */
    function SwatchIcon({ icon }) {
      return icon && icon.src
        ? jsxRuntime.jsx('img', { src: icon.src, width: 14, height: 14, alt: '', draggable: false })
        : null;
    }

    // 当前打开的取色面板（同时只开一个）。
    let activePicker = null;
    // 由 apply 注入的「清实时预览」函数（预览样式在 apply 作用域里管理）。
    let clearPickerPreview = () => {};

    function closePicker() {
      if (!activePicker) return;
      const { panel, onKey, onOutside, onClose } = activePicker;
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onOutside, true);
      if (panel.parentNode) panel.parentNode.removeChild(panel);
      activePicker = null;
      if (onClose) onClose(); // 清掉实时预览样式（确定/取消/Esc 都会走这里）。
    }

    /**
     * 自绘取色面板（Muu 2026-11-22 明确授权破例：原生取色器位置被浏览器锁死左上角，
     * 无法改；contextMenu.content 的 session key 又被 workspace 占用，官方无取色组件）。
     *
     * 定位：锚定 menuAnchor（当初右键会话行的位置），贴近右键处弹出。
     * 取色器：面板内嵌原生 <input type="color"> 作色盘——点它弹出的系统色盘位置
     *   由浏览器定（无所谓），但选完的颜色同步进 hex 框，用户在面板内完成取色。
     * 确认口径：只有点面板里的「确定」才 onPick 落盘；点取消/外部/Esc 都不落盘——
     * 彻底解决「随便点一下就确认」。
     */
    function openCustomPicker(currentHex, onPick, onPreview) {
      closePicker();
      const initial = HEX_RE.test(currentHex || '') ? currentHex : '#dbe8fb';
      const dark = isDark();
      const panel = document.createElement('div');
      panel.id = 'dsh-session-color-picker';
      Object.assign(panel.style, {
        position: 'fixed',
        left: `${Math.max(8, Math.min(menuAnchor.x, window.innerWidth - 236))}px`,
        top: `${Math.max(8, Math.min(menuAnchor.y, window.innerHeight - 168))}px`,
        zIndex: '2147483001',
        background: dark ? '#22252a' : '#ffffff',
        color: dark ? '#e9ebee' : '#1f2329',
        border: '1px solid rgba(127,127,127,.35)',
        borderRadius: '10px',
        boxShadow: '0 10px 30px rgba(0,0,0,.25)',
        padding: '12px',
        width: '228px',
        boxSizing: 'border-box',
        font: '13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif',
        userSelect: 'none',
      });

      const hint = document.createElement('div');
      hint.textContent = '自定义背景色（输入 #RRGGBB）';
      hint.style.cssText = 'opacity:.75;margin-bottom:8px;font-size:12px';
      panel.appendChild(hint);

      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;align-items:center';
      // 原生取色器控件：点它打开系统色盘，选完同步到 hex 框（面板是主 UI，色盘只是取色手段）。
      const colorInput = document.createElement('input');
      colorInput.type = 'color';
      colorInput.value = initial;
      colorInput.title = '点此打开取色器';
      Object.assign(colorInput.style, {
        width: '30px', height: '28px', flex: 'none', padding: '0',
        border: '1px solid rgba(127,127,127,.45)', borderRadius: '6px',
        background: 'transparent', cursor: 'pointer',
      });
      const preview = colorInput; // 预览即取色控件本身，随 hex 同步。
      const hexInput = document.createElement('input');
      hexInput.type = 'text';
      hexInput.value = initial;
      hexInput.maxLength = 7;
      hexInput.setAttribute('aria-label', '颜色十六进制值');
      Object.assign(hexInput.style, {
        flex: '1', minWidth: '0', padding: '5px 7px', borderRadius: '6px',
        border: '1px solid rgba(127,127,127,.4)',
        background: dark ? '#2a2d33' : '#fafafa',
        color: dark ? '#e9ebee' : '#1f2329',
        font: '13px ui-monospace,SFMono-Regular,Consolas,monospace',
      });
      const syncFromInput = () => {
        const v = hexInput.value.trim();
        if (HEX_RE.test(v)) {
          colorInput.value = v;
          hexInput.style.borderColor = 'rgba(127,127,127,.4)';
          if (onPreview) onPreview(v); // 实时预览到会话行（不落盘）。
          return v;
        }
        hexInput.style.borderColor = '#e55';
        return null;
      };
      hexInput.addEventListener('input', syncFromInput);
      // 系统色盘拖动/选完 → 同步到 hex 框并实时预览会话行（落盘仍只在点「确定」）。
      colorInput.addEventListener('input', () => { hexInput.value = colorInput.value; syncFromInput(); });
      colorInput.addEventListener('change', () => { hexInput.value = colorInput.value; syncFromInput(); });
      row.appendChild(preview);
      row.appendChild(hexInput);
      panel.appendChild(row);

      // 按钮行：取消 / 确定。只有「确定」落盘。
      const btns = document.createElement('div');
      btns.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:10px';
      const mkBtn = (text, primary) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = text;
        Object.assign(b.style, {
          padding: '4px 12px', borderRadius: '6px', cursor: 'default',
          border: primary ? 'none' : '1px solid rgba(127,127,127,.4)',
          background: primary ? '#3a7afe' : (dark ? '#2a2d33' : '#fafafa'),
          color: primary ? '#fff' : (dark ? '#e9ebee' : '#1f2329'),
          font: '13px system-ui,sans-serif',
        });
        return b;
      };
      const cancel = mkBtn('取消', false);
      const ok = mkBtn('确定', true);
      cancel.addEventListener('click', closePicker);
      ok.addEventListener('click', () => {
        const picked = syncFromInput();
        if (!picked) return;
        closePicker();
        onPick(picked);
      });
      btns.appendChild(cancel);
      btns.appendChild(ok);
      panel.appendChild(btns);

      document.body.appendChild(panel);
      hexInput.focus();
      hexInput.select();

      // 点面板外 / Esc 关闭，均不落盘。
      const onKey = (e) => { if (e.key === 'Escape') closePicker(); };
      const onOutside = (e) => { if (!panel.contains(e.target)) closePicker(); };
      activePicker = { panel, onKey, onOutside, onClose: clearPickerPreview };
      // 延迟挂监听，避免打开这一次点击立即触发 onOutside 关闭。
      setTimeout(() => {
        if (activePicker && activePicker.panel === panel) {
          document.addEventListener('keydown', onKey, true);
          document.addEventListener('pointerdown', onOutside, true);
        }
      }, 0);
    }

    /**
     * 当前是否深色主题。
     * DSH 官方标记是 body[data-ds-dark-theme]（dsh-client-ui-theme/lib/client.js
     * 的 CSS 全用这个选择器）。**不要用 prefers-color-scheme 兜底**：
     * DSH 主题由自身设置决定，不跟随系统；Windows 深色 + DSH 浅色时会误判。
     */
    function isDark() {
      const body = document.body;
      if (body && body.hasAttribute('data-ds-dark-theme')) return true;
      if (body && /dark/i.test(body.className || '')) return true;

      const el = document.documentElement;
      const attr = el.getAttribute('data-theme')
        || el.getAttribute('data-color-scheme')
        || el.getAttribute('theme') || '';
      if (attr) return /dark|night/i.test(attr);
      return /dark/i.test(el.className || '');
    }

    /** 把会话 id 安全转义成 CSS 属性选择器里的字符串字面量。 */
    function cssEscape(value) {
      return String(value).replace(/[\0-\x1f\x7f"\\]/g, (ch) => {
        const code = ch.charCodeAt(0).toString(16).padStart(2, '0');
        return `\\${code} `;
      });
    }

    /** key → 背景色值；预设按深浅取色，自定义色两主题同值。 */
    function bgFor(key) {
      if (typeof key !== 'string') return null;
      if (key.startsWith(CUSTOM_KEY_PREFIX)) {
        const hex = key.slice(CUSTOM_KEY_PREFIX.length);
        return HEX_RE.test(hex) ? hex : null;
      }
      const entry = BY_KEY[key];
      if (!entry) return null;
      return isDark() ? entry.dark : entry.color;
    }

    function buildCss(colors) {
      const lines = [];
      for (const [id, key] of Object.entries(colors)) {
        const bg = bgFor(key);
        if (!bg) continue;
        lines.push(`[${ROW_ATTR}="session:${cssEscape(id)}"]{background-color:${bg} !important;}`);
      }
      return lines.join('\n');
    }

    function ensureStyle() {
      let style = document.getElementById(STYLE_ID);
      if (!style) {
        style = document.createElement('style');
        style.id = STYLE_ID;
        style.setAttribute('data-plugin-css', 'dsh-session-color');
        document.head.appendChild(style);
      }
      return style;
    }

    function apply(ctx) {
      const state = { colors: {} };
      let disposed = false;
      const style = ensureStyle();

      // 记录右键锚点：菜单项 run() 拿不到事件对象，用 capture 阶段的 contextmenu
      // 记下当初右键的位置，供自定义面板定位在「右键处」而非菜单项处。
      ctx.effect(() => {
        const onContextMenu = (e) => {
          if (typeof e.clientX === 'number' && typeof e.clientY === 'number') {
            menuAnchor = { x: e.clientX, y: e.clientY };
          }
        };
        document.addEventListener('contextmenu', onContextMenu, true);
        return () => document.removeEventListener('contextmenu', onContextMenu, true);
      }, 'dsh-session-color: contextmenu anchor');

      const render = () => {
        if (!disposed) style.textContent = buildCss(state.colors);
      };

      // 实时预览：系统取色器拖动改色时，把颜色临时写到会话行（不改 state、不落盘）。
      // 用独立 <style> 且排在正式样式之后，!important 保证预览覆盖当前已落盘颜色。
      const PREVIEW_STYLE_ID = 'dsh-session-color-preview';
      function getPreviewStyle() {
        let el = document.getElementById(PREVIEW_STYLE_ID);
        if (!el) {
          el = document.createElement('style');
          el.id = PREVIEW_STYLE_ID;
          el.setAttribute('data-plugin-css', 'dsh-session-color-preview');
          document.head.appendChild(el);
        }
        return el;
      }
      const setPreview = (sessionId, hex) => {
        if (disposed) return;
        getPreviewStyle().textContent = HEX_RE.test(hex || '')
          ? `[${ROW_ATTR}="session:${cssEscape(sessionId)}"]{background-color:${hex} !important;}`
          : '';
      };
      const clearPreview = () => {
        const el = document.getElementById(PREVIEW_STYLE_ID);
        if (el) el.textContent = '';
      };
      clearPickerPreview = clearPreview;

      // 主题切换时重算深浅色（DSH 改 body[data-ds-dark-theme]）。
      const onThemeChange = () => render();
      const themeObserver = (typeof MutationObserver === 'function')
        ? new MutationObserver(onThemeChange) : null;
      if (themeObserver) {
        themeObserver.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['data-theme', 'data-color-scheme', 'theme', 'class'],
        });
        if (document.body) {
          themeObserver.observe(document.body, {
            attributes: true,
            attributeFilter: ['data-ds-dark-theme', 'class'],
          });
        }
      }

      const rpcCall = (endpoint, payload) =>
        ctx.connection.rpc.call(RPC_CHANNEL, endpoint, payload);

      /**
       * connection.rpc.call() 返回 full.result（{ ok:true, value } / { ok:false, error }）。
       * 成功返回业务值；失败抛错交给调用方的 .catch() 回滚。
       */
      const unwrap = (result) => {
        if (!result || typeof result !== 'object') throw new Error('invalid rpc result');
        if (result.ok === true) return result.value;
        if (result.ok === false) {
          const message = result.error && result.error.message ? result.error.message : 'rpc failed';
          throw new Error(message);
        }
        if (result.colors && typeof result.colors === 'object') return result;
        throw new Error('invalid rpc result');
      };

      // 启动时拉取一次全量映射；失败不阻塞插件，仅留空。
      ctx.effect(() => {
        let alive = true;
        rpcCall(ENDPOINTS.list, {})
          .then((result) => {
            if (!alive || disposed) return;
            const value = unwrap(result);
            if (value && value.colors && typeof value.colors === 'object') {
              state.colors = value.colors;
              render();
              console.info('[dsh-session-color] loaded', Object.keys(state.colors).length, 'color(s)', 'dark=', isDark());
            }
          })
          .catch((error) => {
            console.warn('[dsh-session-color] load colors failed:', error && error.message ? error.message : error);
          });
        return () => { alive = false; };
      }, 'dsh-session-color: load colors');

      const setColor = (sessionId, key) => {
        // 乐观更新：先本地渲染，再落盘；失败则回滚。
        const previous = state.colors[sessionId];
        if (key === null) delete state.colors[sessionId];
        else state.colors[sessionId] = key;
        render();
        rpcCall(ENDPOINTS.set, { sessionId, key })
          .then((result) => {
            if (disposed) return;
            const value = unwrap(result);
            if (value && value.colors && typeof value.colors === 'object') {
              state.colors = value.colors;
              render();
            }
          })
          .catch(() => {
            if (disposed) return;
            if (previous === undefined) delete state.colors[sessionId];
            else state.colors[sessionId] = previous;
            render();
          });
      };

      // 色块图标：注册到官方 keyed slot，供菜单动作的 icon:{key,src} 取用。
      ctx.effect(() => ctx.slots.inject('contextMenu.icon', () =>
        ctx.slots.register({ name: 'contextMenu.icon', key: ICON_KEY_PREFIX + 'preset' }, SwatchIcon)
      ), 'dsh-session-color: menu icon');

      // 唯一的菜单路径：官方 contextMenus。inject 已保证服务就绪，不做存在性探测，
      // 也没有任何自绘退路。
      ctx.effect(() => ctx.contextMenus.register({
        id: 'dsh-session-color.pick',
        target: 'session',
        order: 500,
        resolve: ({ sessionId }) => {
          const current = state.colors[sessionId];
          const dark = isDark();
          const children = PALETTE.map((p) => ({
            id: p.key,
            label: `${current === p.key ? '✓ ' : ''}${p.label}`,
            // 官方菜单 icon：key 指向上面注册的 slot 条目，src 决定色块颜色。
            icon: { key: ICON_KEY_PREFIX + 'preset', src: swatchSrc(dark ? p.dark : p.color) },
            run: () => setColor(sessionId, p.key),
          }));
          // 当前若为自定义色，勾选项且取色器以该色为初值。
          const customHex = (typeof current === 'string' && current.startsWith(CUSTOM_KEY_PREFIX))
            ? current.slice(CUSTOM_KEY_PREFIX.length) : null;
          const rainbow = 'data:image/svg+xml;charset=utf-8,'
            + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f66"/><stop offset=".5" stop-color="#6c6"/><stop offset="1" stop-color="#68f"/></linearGradient></defs><rect x="0.5" y="0.5" width="13" height="13" rx="3" fill="url(#g)"/></svg>');
          children.push({
            id: 'custom',
            label: `${customHex ? '✓ ' : ''}自定义颜色…`,
            icon: { key: ICON_KEY_PREFIX + 'preset', src: rainbow },
            run: () => openCustomPicker(
              customHex,
              (hex) => setColor(sessionId, CUSTOM_KEY_PREFIX + hex),
              (hex) => setPreview(sessionId, hex),
            ),
          });
          children.push({
            id: 'clear',
            label: `${current === undefined ? '✓ ' : ''}清除颜色`,
            separatorBefore: true,
            run: () => setColor(sessionId, null),
          });
          return [{
            id: 'background',
            label: '会话背景色',
            separatorBefore: true,
            children,
          }];
        },
      }), 'dsh-session-color: context menu');

      // 会话列表异步渲染时重刷样式。
      ctx.effect(() => {
        const observer = (typeof MutationObserver === 'function')
          ? new MutationObserver(() => render()) : null;
        if (observer) observer.observe(document.body, { childList: true, subtree: true });
        return () => { if (observer) observer.disconnect(); };
      }, 'dsh-session-color: row observer');

      // 插件停用时回收 <style> 与监听器。
      ctx.effect(() => () => {
        disposed = true;
        closePicker();
        if (themeObserver) themeObserver.disconnect();
        for (const id of [STYLE_ID, PREVIEW_STYLE_ID]) {
          const el = document.getElementById(id);
          if (el && el.parentNode) el.parentNode.removeChild(el);
        }
      }, 'dsh-session-color: cleanup');

      render();
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = name;
    Object.defineProperty(exports, '__esModule', { value: true });
    return module.exports;
  },
});
