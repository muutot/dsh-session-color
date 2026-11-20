// 宿主半侧与前端半侧共享的常量。
// 前端 bundle 是 CJS factory，会把本文件连同 client 一起打进同一个 client.js。

/** RPC channel（必须以 / 开头，且不能是保留的 /api）。 */
export const RPC_CHANNEL = '/dsh-session-color';

export const ENDPOINTS = Object.freeze({
  list: 'colors.list',
  set: 'colors.set',
});

/** 预设色板。key 用于持久化与菜单项 id，label 为中文显示名。 */
export const PALETTE = Object.freeze([
  { key: 'red', label: '红', color: '#fde2e2', dark: '#5c2b2b' },
  { key: 'orange', label: '橙', color: '#fdebd0', dark: '#5c3a1f' },
  { key: 'yellow', label: '黄', color: '#fbf3c4', dark: '#56491e' },
  { key: 'green', label: '绿', color: '#d9f2dd', dark: '#22472b' },
  { key: 'cyan', label: '青', color: '#d3eef2', dark: '#1f4a51' },
  { key: 'blue', label: '蓝', color: '#dbe8fb', dark: '#263c5c' },
  { key: 'purple', label: '紫', color: '#ece0f7', dark: '#3f2b57' },
  { key: 'pink', label: '粉', color: '#fbe0ef', dark: '#572a45' },
  { key: 'gray', label: '灰', color: '#e8eaed', dark: '#3a3d42' },
]);
