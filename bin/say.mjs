#!/usr/bin/env node
// 发频道：done / block / ask。
import { loadConfig } from '../lib/config.mjs';
import { createStore } from '../lib/store.mjs';

const args = process.argv.slice(2);
const opt = (name, dft) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dft; };
const kind = opt('--kind', 'done');
const window = opt('--window', process.env.DSH_WINDOW);
const ref = opt('--ref', null);
const text = args.filter((a) => !a.startsWith('--') && a !== kind && a !== window && a !== ref).join(' ');
if (!window || !text) { console.error('用法：node bin/say.mjs "一句话" --receiver <接收方> --kind done|block|ask [--ref id]'); process.exit(2); }

createStore(loadConfig(process.cwd())).channel(kind, window, text, ref ? { ref } : {});
console.log(`已发频道：[${kind}] ${text}`);