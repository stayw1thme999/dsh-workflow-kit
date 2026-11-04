#!/usr/bin/env node
// 交工单：必须带证据。
import { loadConfig } from '../lib/config.mjs';
import { createStore } from '../lib/store.mjs';

const id = process.argv[2];
const evidence = process.argv.slice(3).join(' ');
if (!id || !evidence) { console.error('用法：node bin/wo-submit.mjs <工单id> "<证据>"'); process.exit(2); }
if (evidence.trim().length < 10) { console.error('证据太短，写清路径/输出原文'); process.exit(2); }

const store = createStore(loadConfig(process.cwd()));
const wo = store.updateWorkOrder(id, { status: 'done', evidence, finishedAt: new Date().toISOString() });
store.channel('done', wo.owner || 'unknown', `交工单 ${id}：${evidence}`, { ref: id });
console.log(`已交：${id}`);