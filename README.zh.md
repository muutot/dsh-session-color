# dsh-session-color

给 DSH 左侧「工作区」会话列表里的**单条对话**换背景色。

## 用法

在会话行上点右键 → **会话背景色** → 选一个预设色（或「清除颜色」）。
选中即生效，颜色写入主机的配置文件，重启 DSH、换浏览器访问都还在。

## 颜色存哪

`$DSH_HOME/dsh-session-color/colors.json`（默认 `~/.dsh/dsh-session-color/colors.json`）：

```json
{ "01J...": "green", "01K...": "red" }
```

纯展示状态，不进模型上下文，不写会话日志。想全部清掉，删这个文件即可。

## 兼容性（0.2.0 起）

同一份代码跑两个版本的 DSH：

| DSH 版本 | 菜单实现 |
|---|---|
| ≥ 0.2.2-rc.1 | 官方 `ctx.contextMenus.register({ target: 'session' })` |
| ≤ 0.2.1-rc.5 | 自带浮层：监听会话行 `contextmenu`，自绘色板 |

判据是**运行时** `ctx.get('contextMenus')` 是否存在（`cordis/lib/index.js:763`
读服务不需要 inject），不是版本号字符串。

> **坑（0.1.x → 0.2.1 升级时踩过）**：`inject` 里绝对不能出现 `contextMenus`。
> 0.2.1 没有这个服务，写进去整条 client row 会永远
> `pending (waiting for service: contextMenus)`，Web 启动审计判为致命错误
> （`crash-*-web-boot.log`：`web boot: 1 entry did not activate`），
> 桌面端随后走「禁用全部插件」恢复，把所有插件和 `cordis.patch.yml` 一起清掉。
> 同理，`package.json` 的 `dsh.client.inject` 里也不能列
> `@deepseek-ai/dsh-client-ui-context-menu`（0.2.1 里根本没有这个包）。

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
- 会话右键菜单：有 `contextMenus` 服务时用
  `ctx.contextMenus.register({ target: 'session', ... })`
  （`dsh-client-ui-context-menu/README.zh.md:32-38`），菜单项支持 `children` 子菜单；
  没有时退化为自绘浮层。
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
node test/smoke.mjs              # 前端：官方菜单 + 自绘菜单两条路径 / CSS / RPC 信封 / 深浅主题
node test/host.mjs               # 宿主：读写落盘 / 输入校验 / 信封 / 404
node --check lib/index.js && node --check client/client.js
```

> `test/host.mjs` 需在插件根目录运行。

前端是纯 CJS、无 JSX，不需要构建步骤；改完 `client/client.js` 后刷新页面
（或由 HMR 重建）即可生效。宿主改完用 `plugin_manager set_plugin` 对该插件
disable → enable 重载 fiber，不用重启应用。
