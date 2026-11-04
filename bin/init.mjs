#!/usr/bin/env node
// 初始化工作区：建目录、建台账、注册接收方。可重复执行（幂等）。
import { mkdirSync, existsSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { loadConfig } from '../lib/config.mjs';

const cfg = loadConfig(process.cwd());

const dirs = [
  cfg.workspace,
  cfg.tasksDir,
  cfg.receiversDir,
  cfg.mailboxDir,
  ...cfg.receivers.map((w) => join(cfg.mailboxDir, w)),
];
for (const d of dirs) mkdirSync(d, { recursive: true });

// 频道文件在 workspace 下，父目录可能还没建
mkdirSync(dirname(cfg.channelPath), { recursive: true });

// 把解析后的绝对频道路径回写进 config.json，让所有脚本写同一个频道文件
try {
  const cfgFile = join(process.cwd(), 'config.json');
  const raw = JSON.parse(readFileSync(cfgFile, 'utf8'));
  if (!raw.channel) {
    raw.channel = cfg.channelPath;
    writeFileSync(cfgFile, JSON.stringify(raw, null, 2), 'utf8');
  }
} catch (e) { console.warn('⚠ config.json 回写频道失败：' + e.message + '（脚本仍会用默认 data/channel.jsonl）'); }

// 台账文件：不存在才建，已有内容绝不覆盖
for (const f of [cfg.dispatchPath, cfg.failuresPath, cfg.channelPath]) {
  if (!existsSync(f)) writeFileSync(f, '', 'utf8');
}

// 接收方状态文件
for (const w of cfg.receivers) {
  const f = join(cfg.receiversDir, `${w}.json`);
  if (!existsSync(f)) {
    writeFileSync(f, JSON.stringify({ window: w, createdAt: new Date().toISOString(), items: [] }, null, 2), 'utf8');
  }
}

const stamp = new Date().toISOString();
appendFileSync(cfg.channelPath, JSON.stringify({ at: stamp, who: 'init', kind: 'info', text: '工作区初始化' }) + '\n', 'utf8');

console.log('已初始化：');
console.log(`  工作区   ${cfg.workspace}`);
console.log(`  接收方     ${cfg.receivers.join(', ')}`);
console.log(`  信箱     ${cfg.mailboxDir}`);
console.log(`  频道     ${cfg.channelPath}`);
console.log(`\n下一步：在每个接活会话里挂一次巡检提醒（docs/02-巡检prompt.md）`);
