#!/usr/bin/env node
// 看本接收方的队列：queued / doing。
import { loadConfig } from '../lib/config.mjs';
import { createStore } from '../lib/store.mjs';

const i = Math.max(process.argv.indexOf('--receiver'), process.argv.indexOf('--window'));
const window = i >= 0 ? process.argv[i + 1] : process.env.DSH_WINDOW;
if (!window) { console.error('用法：node bin/list.mjs --receiver <接收方名>'); process.exit(2); }

const store = createStore(loadConfig(process.cwd()));
const data = store.readTasks(window);
const doing = data.items.filter((t) => t.status === 'doing');
const queued = data.items.filter((t) => t.status === 'queued');
console.log(`「${window}」进行中 ${doing.length} / 待办 ${queued.length}`);
for (const t of [...doing, ...queued]) console.log(`  ${t.status === 'doing' ? '🔄' : '⏳'} ${t.id}  ${t.priority}  ${t.title}`);
process.exit(doing.length + queued.length ? 0 : 4);