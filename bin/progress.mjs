#!/usr/bin/env node
// 报进度：写进频道。
import { loadConfig } from '../lib/config.mjs';
import { createStore } from '../lib/store.mjs';

const args = process.argv.slice(2);
const i = Math.max(args.indexOf('--receiver'), args.indexOf('--window'));
const window = i >= 0 ? args[i + 1] : process.env.DSH_WINDOW;
const text = args.filter((a) => a !== '--receiver' && a !== '--window' && a !== window).join(' ');
if (!window || !text) { console.error('用法：node bin/progress.mjs --receiver <接收方> "正在做什么"'); process.exit(2); }

createStore(loadConfig(process.cwd())).channel('progress', window, text);
console.log('已上报：' + text);