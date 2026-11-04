#!/usr/bin/env node
// 建工单：node bin/wo-add.mjs <id> "<标题>" [--window w] [--depends a,b] [--priority P1]
import { loadConfig } from '../lib/config.mjs';
import { createStore } from '../lib/store.mjs';

const args = process.argv.slice(2);
const opt = (n, d = null) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const [id, title] = args.filter((a) => !a.startsWith('--'));
if (!id || !title) { console.error('用法：node bin/wo-add.mjs <id> "<标题>" [--window w] [--depends a,b]'); process.exit(2); }

const store = createStore(loadConfig(process.cwd()));
store.addWorkOrder({
  id,
  title,
  window: opt('--window', ''),
  priority: opt('--priority', 'P2'),
  dependsOn: (opt('--depends', '') || '').split(',').map((s) => s.trim()).filter(Boolean),
});
console.log(`已建：${id}  ${title}`);