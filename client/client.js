// dsh-session-color 前端半侧（浏览器）
//
// 由 dsh-client-modules 通过 /plugins 提供，注册成一条 client row。
// 纯 CJS factory，不用 React/JSX；导出 { name, inject, apply }。
//
// 两条渲染路径（同一份数据、同一套样式）：
//   A. 官方菜单（DSH >= 0.2.2-rc.1）：ctx.contextMenus.register(...)
//      服务名 "contextMenus"，由 @deepseek-ai/dsh-client-ui-context-menu 提供。
//   B. 自绘菜单（DSH <= 0.2.1 没有 contextMenus 服务）：
//      直接监听会话行的 contextmenu，自建浮层。
//   判据是运行时的 ctx.get('contextMenus')，而不是版本号字符串——
//   0.2.1-rc.5 里该服务不存在，若把它写进 inject，整条 row 会永远
//   "pending (waiting for service: contextMenus)"，进而让 web boot 直接失败
//   （crash-*-web-boot.log: "1 entry did not activate"），把整个 profile 拖进恢复模式。
//
// 契约（源码查证）：
//   - 会话行 DOM 自带 data-row-key="session:<id>"
//       dsh-client-ui-workspace/lib/client.js:2276
//   - ctx.connection.rpc.call(channel, endpoint, payload)
//       返回 full.result = { ok:true, value } / { ok:false, error }。
//       dsh-client-connection/lib/client.browser.js:1212 / :1288-1298
//   - ctx.get(name) 返回服务实现或 undefined，无需 inject
//       @deepseek-ai/cordis/lib/index.js:763

// 注册 id 必须等于 npm 包名：dsh-client-modules 按包名找 factory，
// 对不上就「loaded without registering」+ 重拉一次 → duplicate registration。
// 2026-11-19 包改名 @muutot/dsh-session-color 后这里要跟着改（裸名 id 只在数据键里保留）。
window.__ModuleLoader__.load({
  id: '@muutot/dsh-session-color',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;

    const RPC_CHANNEL = '/dsh-session-color';
    const ENDPOINTS = { list: 'colors.list', set: 'colors.set' };
    const STYLE_ID = 'dsh-session-color-style';
    const MENU_STYLE_ID = 'dsh-session-color-menu-style';
    const MENU_ID = 'dsh-session-color-menu';
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
    // 只 inject 真正必需的服务；contextMenus 走运行时探测，缺失时不阻塞激活。
    const inject = ['connection'];

    const BY_KEY = Object.fromEntries(PALETTE.map((p) => [p.key, p]));

    const MENU_CSS = `
.dsc-menu{position:fixed;z-index:2147483000;min-width:148px;padding:6px;border-radius:10px;
  box-sizing:border-box;font:13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;
  box-shadow:0 10px 30px rgba(0,0,0,.20),0 2px 6px rgba(0,0,0,.12);
  border:1px solid rgba(127,127,127,.28);user-select:none;animation:dsc-in .09s ease-out}
@keyframes dsc-in{from{opacity:0;transform:translateY(-2px)}to{opacity:1;transform:none}}
.dsc-menu.dsc-light{background:#fff;color:#1f2329}
.dsc-menu.dsc-dark{background:#22252a;color:#e9ebee;border-color:rgba(255,255,255,.14)}
.dsc-item{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;cursor:default;white-space:nowrap}
.dsc-item:hover{background:rgba(127,127,127,.16)}
.dsc-menu.dsc-dark .dsc-item:hover{background:rgba(255,255,255,.10)}
.dsc-sw{width:13px;height:13px;border-radius:3px;flex:none;border:1px solid rgba(127,127,127,.45)}
.dsc-label{flex:1 1 auto}
.dsc-check{width:12px;flex:none;text-align:center;opacity:.9;font-size:12px}
.dsc-sep{height:1px;margin:4px 4px;background:rgba(127,127,127,.25)}
.dsc-menu.dsc-dark .dsc-sep{background:rgba(255,255,255,.14)}
`;

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

    function buildCss(colors) {
      const dark = isDark();
      const lines = [];
      for (const [id, key] of Object.entries(colors)) {
        const entry = BY_KEY[key];
        if (!entry) continue;
        const bg = dark ? entry.dark : entry.color;
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

    function ensureMenuStyle() {
      let style = document.getElementById(MENU_STYLE_ID);
      if (!style) {
        style = document.createElement('style');
        style.id = MENU_STYLE_ID;
        style.setAttribute('data-plugin-css', 'dsh-session-color-menu');
        style.textContent = MENU_CSS;
        document.head.appendChild(style);
      }
      return style;
    }

    /**
     * 自绘右键菜单：0.2.1 及更早没有 contextMenus 服务时的退路。
     * 只认 [data-row-key="session:<id>"] 的行，不猜类名。
     * @returns disposer，移除监听、浮层与样式。
     */
    function installDomMenu(state, setColor) {
      ensureMenuStyle();
      let menu = null;

      const close = () => {
        if (menu && menu.parentNode) menu.parentNode.removeChild(menu);
        menu = null;
      };

      const item = (label, swatchColor, active, onClick) => {
        const row = document.createElement('div');
        row.className = 'dsc-item';
        row.setAttribute('role', 'menuitem');

        if (swatchColor) {
          const sw = document.createElement('span');
          sw.className = 'dsc-sw';
          sw.style.background = swatchColor;
          row.appendChild(sw);
        }

        const text = document.createElement('span');
        text.className = 'dsc-label';
        text.textContent = label;
        row.appendChild(text);

        const check = document.createElement('span');
        check.className = 'dsc-check';
        check.textContent = active ? '✓' : '';
        row.appendChild(check);

        row.addEventListener('mousedown', (event) => event.stopPropagation());
        row.addEventListener('click', (event) => {
          event.stopPropagation();
          event.preventDefault();
          close();
          onClick();
        });
        return row;
      };

      const open = (sessionId, x, y) => {
        close();
        const dark = isDark();
        const current = state.colors[sessionId];

        const box = document.createElement('div');
        box.id = MENU_ID;
        box.className = `dsc-menu ${dark ? 'dsc-dark' : 'dsc-light'}`;
        box.setAttribute('role', 'menu');

        for (const p of PALETTE) {
          box.appendChild(item(p.label, dark ? p.dark : p.color, current === p.key, () => {
            setColor(sessionId, p.key);
          }));
        }

        const sep = document.createElement('div');
        sep.className = 'dsc-sep';
        box.appendChild(sep);
        box.appendChild(item('清除颜色', null, current === undefined, () => {
          setColor(sessionId, null);
        }));

        // 先挂到 body 再量尺寸，避免读到 0 宽高。
        box.style.left = '0px';
        box.style.top = '0px';
        document.body.appendChild(box);
        menu = box;

        const rect = box.getBoundingClientRect();
        const margin = 8;
        const left = Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin));
        const top = Math.max(margin, Math.min(y, window.innerHeight - rect.height - margin));
        box.style.left = `${left}px`;
        box.style.top = `${top}px`;
      };

      const onContextMenu = (event) => {
        const target = event.target;
        const row = target && typeof target.closest === 'function'
          ? target.closest(`[${ROW_ATTR}]`) : null;
        if (!row) return;
        const key = row.getAttribute(ROW_ATTR) || '';
        if (!key.startsWith('session:')) return;
        event.preventDefault();
        event.stopPropagation();
        open(key.slice('session:'.length), event.clientX, event.clientY);
      };

      const onMouseDown = (event) => {
        if (menu && !menu.contains(event.target)) close();
      };
      const onKeyDown = (event) => {
        if (event.key === 'Escape') close();
      };
      const onViewportChange = () => close();

      document.addEventListener('contextmenu', onContextMenu, true);
      document.addEventListener('mousedown', onMouseDown, true);
      document.addEventListener('keydown', onKeyDown, true);
      window.addEventListener('resize', onViewportChange);
      window.addEventListener('blur', onViewportChange);
      window.addEventListener('scroll', onViewportChange, true);

      return () => {
        close();
        document.removeEventListener('contextmenu', onContextMenu, true);
        document.removeEventListener('mousedown', onMouseDown, true);
        document.removeEventListener('keydown', onKeyDown, true);
        window.removeEventListener('resize', onViewportChange);
        window.removeEventListener('blur', onViewportChange);
        window.removeEventListener('scroll', onViewportChange, true);
        const style = document.getElementById(MENU_STYLE_ID);
        if (style && style.parentNode) style.parentNode.removeChild(style);
      };
    }

    function apply(ctx) {
      const state = { colors: {} };
      let disposed = false;
      const style = ensureStyle();

      const render = () => {
        if (!disposed) style.textContent = buildCss(state.colors);
      };

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

      // 菜单：有官方服务走官方，没有就自绘。ctx.get 不需要 inject，缺失返回 undefined。
      const menus = typeof ctx.get === 'function' ? ctx.get('contextMenus') : undefined;
      if (menus && typeof menus.register === 'function') {
        ctx.effect(() => menus.register({
          id: 'dsh-session-color.pick',
          target: 'session',
          order: 500,
          resolve: ({ sessionId }) => {
            const current = state.colors[sessionId];
            const children = PALETTE.map((p) => ({
              id: p.key,
              label: `${current === p.key ? '✓ ' : ''}${p.label}`,
              run: () => setColor(sessionId, p.key),
            }));
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
      } else {
        console.info('[dsh-session-color] contextMenus 服务不可用，使用自绘右键菜单');
        ctx.effect(() => installDomMenu(state, setColor), 'dsh-session-color: dom context menu');
      }

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
        if (themeObserver) themeObserver.disconnect();
        for (const id of [STYLE_ID, MENU_STYLE_ID, MENU_ID]) {
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
