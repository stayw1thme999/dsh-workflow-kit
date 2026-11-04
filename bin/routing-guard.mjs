#!/usr/bin/env node
// 任务路由守卫 v2：所有接收方的任务长时间不动 → 批量催「去 DSH 点开该接收方」（强制唤醒的现实版）
// 规则（负责人 2026-11-04 改）：
//   · doing 任务：P1 卡 >20 分钟、其它卡 >40 分钟 → 催
//   · queued 任务：仅 P1 且派了 >60 分钟没人接 → 催
//   · 同一任务 60 分钟只催一次
//   · 提醒走「负责人+派单方」群（group.json 里的 token），不再用私聊（旧 token 已轮换失效）
// 计划任务：QQAgent-RoutingGuard，每 10 分钟
import fs from 'node:fs';
import { installFailHook } from '../lib/fail-hook.mjs';

installFailHook('alice', '路由守卫');
import path from 'node:path';

const DATA = process.env.DSH_WORKFLOW_DATA || path.join(process.cwd(), 'data');
const WIN = path.join(DATA, 'tasks', 'windows');
const STATE = path.join(DATA, 'tasks', 'routing-state.json');
const LOG = path.join(DATA, 'tasks', 'routing.log');
const CHAN = path.join(DATA, 'channel.jsonl');

const now = Date.now();
const iso = (t = now) => new Date(t).toISOString();
const log = (m) => { try { fs.appendFileSync(LOG, iso() + '  ' + m + '\n', 'utf8'); } catch { } };
const readJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return fb; } };

// 阈值：P1 doing 20 分钟；其它 doing 40 分钟；P1 queued 60 分钟
const TH = { doingP1: 20, doingOther: 40, queuedP1: 60 };

const st = readJson(STATE, {}) || {};
const stale = [];

for (const f of fs.existsSync(WIN) ? fs.readdirSync(WIN) : []) {
  if (!f.endsWith('.json') || f.endsWith('-next.json')) continue;
  const db = readJson(path.join(WIN, f), { items: [] }) || { items: [] };
  const w = db.window;
  for (const it of db.items || []) {
    if (it.status === 'doing') {
      const since = Date.parse(it.lastProgressAt || it.startedAt || it.createdAt || 0) || 0;
      const mins = Math.round((now - since) / 60000);
      const th = it.priority === 1 ? TH.doingP1 : TH.doingOther;
      if (mins < th) continue;
      stale.push({ id: it.id, window: w, title: it.title, mins, priority: it.priority, kind: 'doing', sinceAt: since });
    } else if (it.status === 'queued' && it.priority === 1) {
      const since = Date.parse(it.createdAt || 0) || 0;
      const mins = Math.round((now - since) / 60000);
      if (mins < TH.queuedP1) continue;
      stale.push({ id: it.id, window: w, title: it.title, mins, priority: it.priority, kind: 'queued', sinceAt: since });
    }
  }
}

// 去重：每个任务只催一次；催过之后若任务有新进度（sinceAt 前移），才允许再催一次
const fresh = stale.filter((s) => {
  const key = 'nudge:' + s.id;
  const last = st[key];
  if (typeof last === 'number') return false;                    // 旧版已催过（60 分钟循环时代），不再补催
  if (!last || !last.at) return true;                            // 从没催过
  return (last.sinceAt || 0) < (s.sinceAt || 0);                 // 有进展后又卡住 → 新一轮，再催一次
});

if (!fresh.length) { console.log('没有需要催的任务'); process.exit(0); }

fresh.sort((a, b) => a.priority - b.priority || b.mins - a.mins);
const lines = ['【接收方该醒了】以下任务派了没人动，去 DSH 点开对应接收方：', ''];
for (const s of fresh.slice(0, 15)) {
  lines.push('· [' + s.window + '] P' + s.priority + ' ' + String(s.title).slice(0, 36) + '　卡 ' + s.mins + ' 分钟（' + s.kind + '）');
}
if (fresh.length > 15) lines.push('…还有 ' + (fresh.length - 15) + ' 条');
lines.push('');
lines.push('点开对应接收方后，它开工第一件事就是领自己的 doing（AGENTS 第五节）。');

const text = lines.join('\n');
// 通用化：config.qqNotify=false 时直接写本地频道，不调 QQ
let cfg = null;
try { cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config.json'), 'utf8')); } catch { /* 无 config 走原路 */ }
try { fs.appendFileSync((cfg && cfg.channel) || CHAN, JSON.stringify({ at: iso(), who: 'alice', kind: 'ask', text }) + '\n', 'utf8'); } catch { }

for (const s of fresh) {
  st['nudge:' + s.id] = { at: now, sinceAt: s.sinceAt };
  log('催 ' + s.window + ' ' + s.id + '（卡 ' + s.mins + ' 分钟，' + s.kind + '）');
}
fs.mkdirSync(path.dirname(STATE), { recursive: true });
fs.writeFileSync(STATE, JSON.stringify(st, null, 2), 'utf8');

console.log('已催 ' + fresh.length + ' 条' + (g.ok ? '（已发群）' : '（群失败，已落频道）'));
for (const s of fresh.slice(0, 10)) console.log('  [' + s.window + '] ' + s.mins + ' 分钟 · ' + String(s.title).slice(0, 36));
