#!/usr/bin/env node
// 收自己接收方的信：取一封，打印原文，移到 _done。
import { loadConfig } from '../lib/config.mjs';
import { createStore } from '../lib/store.mjs';

const i = Math.max(process.argv.indexOf('--receiver'), process.argv.indexOf('--window'));
const window = i >= 0 ? process.argv[i + 1] : process.env.DSH_WINDOW;
if (!window) { console.error('用法：node bin/take.mjs --receiver <接收方名>'); process.exit(2); }

const cfg = loadConfig(process.cwd());
const store = createStore(cfg);
const mail = store.takeMailbox(window);
if (!mail) { console.log(`「${window}」没有新信`); process.exit(4); }
store.channel('info', window, `收信 ${mail.name}`);
console.log(mail.body);