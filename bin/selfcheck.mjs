#!/usr/bin/env node
// 安装自检：配置能解析、目录存在、文件可写、扫描脚本可跑。全过 exit 0。
import { existsSync, accessSync, constants, appendFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../lib/config.mjs';

const checks = [];
const ok = (name, detail = '') => checks.push({ ok: true, name, detail });
const bad = (name, detail = '') => checks.push({ ok: false, name, detail });

let cfg;
try {
  cfg = loadConfig(process.cwd());
  ok('config.json 可解析', `receivers=${cfg.receivers.length} workspace=${cfg.workspace}`);
} catch (e) {
  bad('config.json 可解析', e.message);
  console.log('\n提示：包里不附带 config.json（每人配置不同）。先执行：');
  console.log('  cp config.example.json config.json   # Windows: copy config.example.json config.json');
  console.log('然后再跑一次 selfcheck。');
}

if (cfg) {
  for (const [name, p] of [
    ['工作区目录', cfg.workspace],
    ['信箱目录', cfg.mailboxDir],
    ['台账目录', cfg.tasksDir],
  ]) {
    if (existsSync(p) && statSync(p).isDirectory()) ok(`${name}存在`, p);
    else bad(`${name}缺失`, `${p}（跑 node bin/init.mjs）`);
  }

  for (const [name, p] of [
    ['频道文件', cfg.channelPath],
    ['派单台账', cfg.dispatchPath],
    ['失败台账', cfg.failuresPath],
  ]) {
    if (!existsSync(p)) { bad(`${name}缺失`, `${p}（跑 node bin/init.mjs）`); continue; }
    try { accessSync(p, constants.W_OK); ok(`${name}可写`, p); }
    catch { bad(`${name}不可写`, p); }
  }

  for (const w of cfg.receivers) {
    const mb = join(cfg.mailboxDir, w);
    if (existsSync(mb)) ok(`接收方信箱 ${w}`, mb);
    else bad(`接收方信箱 ${w}`, `缺失 ${mb}`);
  }

  // 频道能追加
  try {
    appendFileSync(cfg.channelPath, JSON.stringify({ at: new Date().toISOString(), who: 'selfcheck', kind: 'info', text: '自检写入' }) + '\n', 'utf8');
    ok('频道可追加', cfg.channelPath);
  } catch (e) { bad('频道可追加', e.message); }

  // 关键命令在位
  for (const f of ['wo.mjs', 'dispatch.mjs', 'autotake.mjs', 'routing-guard.mjs']) {
    const p = join(process.cwd(), 'bin', f);
    if (existsSync(p)) ok(`命令 ${f}`, p); else bad(`命令 ${f} 缺失`, p);
  }

  // 扫描脚本可跑
  const scan = join(process.cwd(), 'scripts', 'scan-secrets.mjs');
  if (existsSync(scan)) {
    const r = spawnSync(process.execPath, [scan, '.'], { encoding: 'utf8' });
    if (r.status === 0) ok('脱敏扫描通过', (r.stdout || '').trim().split('\n').pop());
    else bad('脱敏扫描有命中', (r.stdout || '').trim().split('\n').slice(0, 5).join(' | '));
  } else {
    bad('脱敏扫描脚本缺失', scan);
  }
}

for (const c of checks) console.log(`${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? '  ' + c.detail : ''}`);
const failed = checks.filter((c) => !c.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} 通过`);
process.exit(failed ? 1 : 0);
