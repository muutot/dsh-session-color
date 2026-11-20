# dsh-session-color

Set a custom background color for **individual conversation rows** in the DSH
workspace sidebar.

Right-click a session row → **会话背景色** (Session background color) → pick a
preset color, or "清除颜色" (Clear). The choice is persisted on the host, so it
survives restarts and is shared across browsers connecting to the same DSH.

## Where colors live

`$DSH_HOME/dsh-session-color/colors.json` (default `~/.dsh/dsh-session-color/colors.json`):

```json
{ "01J...": "green", "01K...": "red" }
```

Pure display state — never enters model context or session logs. Delete the file
to reset everything.

## Implementation

- Host half (`lib/index.js`): registers the `/dsh-session-color` RPC channel and
  reads/writes `colors.json`.
- Client half (`client/client.js`): contributes a `target: 'session'` context
  menu with a color submenu, injects a `<style>` keyed by
  `[data-row-key="session:<id>"]`, and calls the RPC.
- `package.json` declares `dsh.bundle.patch` and `dsh.client` (platform `web`).

The client bundle is plain CJS with no JSX, so there is no build step. See
[README.zh.md](README.zh.md) for the full source-level rationale (DSH 0.2.2-rc.1
extension points, RPC envelope contract, theme detection, and the `rpc.handle`
compatibility note).

## Develop

```bash
node test/smoke.mjs
node test/host.mjs
node --check lib/index.js && node --check client/client.js
```
