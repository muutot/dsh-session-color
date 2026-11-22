# dsh-session-color

给 DSH 左侧「工作区」会话列表里的**单条对话**换背景色。

## 用法

在会话行上点右键 → **会话背景色** → 选一个预设色（或「清除颜色」）。
每个颜色项前有一个小色块（走 DSH 官方 `contextMenu.icon` 扩展点渲染，非自绘）。
选中即生效，颜色写入主机的配置文件，重启 DSH、换浏览器访问都还在。

## 颜色存哪

`$DSH_HOME/dsh-session-color/colors.json`（默认 `~/.dsh/dsh-session-color/colors.json`）：

```json
{ "01J...": "green", "01K...": "red" }
```

纯展示状态，不进模型上下文，不写会话日志。想全部清掉，删这个文件即可。

## 兼容性（仅官方菜单）

**只支持 DSH ≥ 0.2.2-rc.1**（提供 `contextMenus` 服务的版本）。
菜单一律走官方 `ctx.contextMenus.register({ target: 'session' })`，
**不提供任何自绘浮层/覆盖层退路**——这是硬性 UI 规则：
UI 扩展只用宿主官方扩展点，不自己画浮层模拟宿主菜单。

- 前端 `inject = ['connection', 'contextMenus', 'slots']`，三者是硬依赖，
  由 Cordis 保证服务就绪后才激活本行；不做存在性探测、不留退路。
- `package.json` 的 `dsh.client.inject` 同时列
  `@deepseek-ai/dsh-client-connection`、`@deepseek-ai/dsh-client-ui-context-menu`、
  `@deepseek-ai/dsh-client-ui-slots`，保证浏览器模块加载顺序（依赖包先于本插件）。
- 色块：颜色动作带 `icon: { key, src }`（src 是纯色 SVG 的 data URI，深浅各一份），
  并 `ctx.slots.inject('contextMenu.icon', ...)` 注册一个把 src 渲染成 14×14 `<img>` 的
  组件——与 open-in-app 应用图标同一官方机制，不是自绘浮层。
  `require('react')` / `require('react/jsx-runtime')` 是 baseline 模块，无需 manifest 声明。

> **历史坑（0.2.x 兼容年代踩过，现已不适用）**：早期为兼容没有该服务的 0.2.1，
> 曾用 `ctx.get('contextMenus')` 运行时探测 + 自绘浮层退路；在 rc.5 上该探测
> 误判成「无服务」，结果右键直接弹自绘色板而不是官方菜单里的二级选项。
> 现已按硬规则砍掉全部自绘代码，只走官方菜单，故不再兼容 0.2.1。

## 实现要点

| 层 | 文件 | 职责 |
|---|---|---|
| 宿主半侧 | `lib/index.js` | 注册 `/dsh-session-color` RPC channel，读写 `colors.json` |
| 共享契约 | `shared/contract.mjs` | RPC 端点、色板常量 |
| 前端半侧 | `client/client.js` | 会话右键菜单、按会话 id 注入 `<style>`、调 RPC |
| 清单 | `package.json` | `dsh.bundle.patch` + `dsh.client` 声明 |
| 加载配置 | `cordis.patch.yml` | 单条 Loader 条目 |

关键扩展点（DSH 0.2.2-rc.1 / 0.2.1-rc.5 源码查证）：

- 会话行 DOM 自带 `data-row-key="session:<id>"`（0.2.1-rc.5：
  `dsh-client-ui-workspace/lib/client.js:2276`）。
  CSS 用属性选择器命中，不依赖会随构建变化的 CSS Modules 哈希类名。
- 会话右键菜单：一律用
  `ctx.contextMenus.register({ target: 'session', ... })`
  （`dsh-client-ui-context-menu/README.zh.md:32-38`），菜单项支持 `children` 子菜单；
  无自绘退路。
- 浏览器端 RPC `ctx.connection.rpc.call(channel, endpoint, payload)`
  （`dsh-client-connection/lib/client.browser.js:1212`）。

### 两个已修的运行时坑

1. **RPC 信封**：`parseConnectionResponse`（`dsh-client-connection/lib/client.browser.js:1288-1298`）
   强制 `result = { ok:true, value }`，返回裸业务对象会让前端解析抛错 → 乐观更新回滚
   → 「选完闪一下就消失」。宿主必须包信封，前端 `unwrap()` 取 `.value`。
2. **主题判断**：DSH 深色标记是 `body[data-ds-dark-theme]`（theme 包 CSS 全用它）。
   不要用 `prefers-color-scheme` 兜底——Windows 深色 + DSH 浅色会误用深色变体。

### 为什么不用 `ctx.connection.rpc.handle`

`rpc.handle` 内部执行 `owner.effect(() => owner.webServer.register(route))`
（`dsh-client-connection/lib/index.js:871`），而 connection 插件自身
`inject = ["credentials"]`（同文件 `:1013`），在受限 Context 上访问
`owner.webServer` 会触发 "cannot get property without inject"。
因此本插件直接 inject `webServer` 并自行注册路由，用与官方 `/api` 路由相同的
`connection.requestRejection(req)` 做认证栅栏（同文件 `:1049`）。

## 开发

```bash
node test/smoke.mjs              # 前端：官方菜单 / CSS / RPC 信封 / 深浅主题（并断言无自绘代码）
node test/host.mjs               # 宿主：读写落盘 / 输入校验 / 信封 / 404
node --check lib/index.js && node --check client/client.js
```

> `test/host.mjs` 需在插件根目录运行。

前端是纯 CJS、无 JSX，不需要构建步骤；改完 `client/client.js` 后刷新页面
（或由 HMR 重建）即可生效。宿主改完用 `plugin_manager set_plugin` 对该插件
disable → enable 重载 fiber，不用重启应用。
