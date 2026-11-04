#!/usr/bin/env node
// 自取工单：只取分给本接收方或无归属、且依赖已完成的。
import { loadConfig } from '../lib/config.mjs';
import { createStore } from '../lib/store.mjs';

const window = process.argv[2] || process.env.DSH_WINDOW;
if (!window) { console.error('用法：node bin/wo-take.mjs <接收方名>'); process.exit(2); }

const store = createStore(loadConfig(process.cwd()));
try {
  const wo = store.takeWorkOrder(window);
  if (!wo) { console.log(`「${window}」没有可领工单`); process.exit(4); }
  store.channel('info', window, `接工单 ${wo.id}：${wo.title}`);
  console.log(`已接：${wo.id}  ${wo.priority}  ${wo.title}`);
  console.log(`依赖：${(wo.dependsOn || []).join(', ') || '无'}`);
} catch (e) {
  console.error(e.message);
  process.exit(6);
}