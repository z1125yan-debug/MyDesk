// P32 稳智对齐 P3 #17：折叠侧栏按钮钉测
//
// 覆盖：
//   1. store 里 sidebarCollapsed 初始为 false
//   2. toggleSidebar 切换 sidebarCollapsed
//   3. Sidebar 组件引用了 PanelLeftClose 图标（折叠按钮存在）
//   4. Sidebar 组件调用了 toggleSidebar

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// 读源码（Sidebar.tsx 和 store.ts）
function readSrc(relPath: string): string {
  const p = path.join(process.cwd(), relPath);
  return fs.readFileSync(p, "utf-8");
}

// ─── store 层 ─────────────────────────────────────────────────────────────

test("store.sidebarCollapsed 初始为 false", () => {
  const store = readSrc("src/lib/desk/store.ts");
  assert.match(store, /sidebarCollapsed: false/, "初始状态 sidebarCollapsed = false");
});

test("store.toggleSidebar 切换 sidebarCollapsed", () => {
  const store = readSrc("src/lib/desk/store.ts");
  assert.match(store, /toggleSidebar: \(\) => set\(\(s\) => \(\{ sidebarCollapsed: !s\.sidebarCollapsed \}\)\)/, "toggleSidebar 切换 sidebarCollapsed");
});

test("store.persist partialize 包含 sidebarCollapsed", () => {
  const store = readSrc("src/lib/desk/store.ts");
  assert.match(store, /sidebarCollapsed: s\.sidebarCollapsed/, "partialize 包含 sidebarCollapsed");
});

// ─── Sidebar 组件 ─────────────────────────────────────────────────────────

test("Sidebar 导入 PanelLeftClose 图标", () => {
  const src = readSrc("src/components/desk/Sidebar.tsx");
  assert.match(src, /PanelLeftClose/, "导入 PanelLeftClose 图标");
});

test("Sidebar 调用了 toggleSidebar", () => {
  const src = readSrc("src/components/desk/Sidebar.tsx");
  assert.match(src, /const toggleSidebar = useDesk\(\(s\) => s\.toggleSidebar\)/, "调用 useDesk((s) => s.toggleSidebar)");
  assert.match(src, /onClick=\{toggleSidebar\}/, "折叠按钮 onClick 绑定 toggleSidebar");
});

test("Sidebar 有折叠按钮（title='折叠侧栏'）", () => {
  const src = readSrc("src/components/desk/Sidebar.tsx");
  assert.match(src, /title="折叠侧栏"/, "折叠按钮有 title 文案");
});

test("Sidebar 品牌区是 flex justify-between（左品牌右按钮）", () => {
  const src = readSrc("src/components/desk/Sidebar.tsx");
  assert.match(src, /flex items-center justify-between/, "品牌区是 flex justify-between");
});

// ─── TopBar 也有折叠按钮（原有） ─────────────────────────────────────────

test("TopBar 也有折叠按钮（原有，P32 不改）", () => {
  const src = readSrc("src/components/desk/TopBar.tsx");
  assert.match(src, /PanelLeftClose/, "TopBar 也有 PanelLeftClose 图标");
  assert.match(src, /onClick=\{toggleSidebar\}/, "TopBar 折叠按钮 onClick 绑定 toggleSidebar");
});

// ─── AppShell 控制侧栏显示 ────────────────────────────────────────────────

test("AppShell 用 collapsed 控制侧栏显示", () => {
  const src = readSrc("src/components/desk/AppShell.tsx");
  assert.match(src, /const collapsed = useDesk\(\(s\) => s\.sidebarCollapsed\)/, "AppShell 读 sidebarCollapsed");
  assert.match(src, /!collapsed && <Sidebar \/>/, "collapsed 时不渲染 Sidebar");
});
