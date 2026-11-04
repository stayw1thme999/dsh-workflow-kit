#!/usr/bin/env node
// 队列自动接取：每 20 分钟一次；每接收方做多挂 5 条 doing，做完下轮再接；
// 「没活」= 所有接收方 queued 与 doing 全空；连续 1 小时没活 → 休眠到强制点（07:00 / 17:00 整点）
// 用法：node autotake.mjs [接收方...]   默认全部接收方
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DATA = process.env.DSH_WORKFLOW_DATA || path.join(process.cwd(), 'data');
const WIN = path.join(DATA, 'tasks', 'windows');
const STATE = path.join(DATA, 'tasks', 'autotake-state.json');
const CHAN = path.join(DATA, 'channel.jsonl');
const POOL = path.join(DATA, 'workorders', 'pool.json');
const WO = 'E:/qqagent-tools/work/派单方/wo.mjs';
const FORCE_HOURS = [7, 17];
const IDLE_SLEEP_MIN = 60;
const MAX_DOING = Number(process.env.AUTOTAKE_MAX || 5);   // 每接收方同时挂最多的 doing 数

const now = new Date();
const hh = now.getHours();
const forced = FORCE_HOURS.includes(hh);   // 整点小时都算强制检索点，不赌任务分钟的偏移

const st = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
st.lastTaskAt = st.lastTaskAt || 0;
st.sleepUntil = st.sleepUntil || 0;

const say = (t) => { try { fs.appendFileSync(CHAN, JSON.stringify({ at: now.toISOString(), who: 'alice', kind: 'info', text: t }) + '\n', 'utf8'); } catch { /* 写频道失败不阻断 */ } };

// 休眠判定：还没到点，且不在强制检索分钟的接收方内
if (!forced && st.sleepUntil && Date.now() < st.sleepUntil) {
  console.log('休眠中，下次 ' + new Date(st.sleepUntil).toLocaleString('zh-CN'));
  process.exit(0);
}

function nextForcePoint() {
  const t = new Date(now);
  for (const h of FORCE_HOURS) {
    const c = new Date(now); c.setHours(h, 0, 0, 0);
    if (c.getTime() > now.getTime()) return c;
  }
  const c = new Date(now); c.setDate(c.getDate() + 1); c.setHours(FORCE_HOURS[0], 0, 0, 0);
  return c;
}

let windows = process.argv.slice(2);
if (!windows.length) {
  windows = fs.readdirSync(WIN).filter((f) => f.endsWith('.json') && !f.endsWith('-next.json'))
    .map((f) => decodeURIComponent(f.replace('.json', '')));
}
let taken = null;
let anyWork = false;   // 任何接收方还有 queued 或 doing = 有活（doing 满员接不动也算有活，绝不误睡）

// ── 接单前查重：同接收方已有 doing/24h 内 done 的同题任务就跳过（不派重复单）──
// 纯脚本判定，零 LLM 上下文占用（不影响派单方任何注入）。
const STOPWORDS = new Set(['alice', '任务', '接收方', '工作', '完成', '修复', '处理', '问题', '相关', '功能', '系统', '文件', '数据', '检查', '更新', '自动', '内容', '现在', '需要', '一条', '重新', '继续', '其他', '开始', '进行', '出现', '情况', '需要', '关于', '这个', '那个', '一下']);
function normTitle(t) {
  const toks = String(t || '').toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*|[\u4e00-\u9fff]+/g) || [];
  return toks.filter((x) => !STOPWORDS.has(x) && (x.length >= 2 || /[a-z0-9]/.test(x) && x.length >= 4));
}
function sim(a, b) {
  const A = new Set(normTitle(a)), B = new Set(normTitle(b));
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  const cont = String(a).includes(String(b)) || String(b).includes(String(a));
  return cont ? 1 : shared / Math.min(A.size, B.size);
}

for (const w of windows) {
  const f = path.join(WIN, encodeURIComponent(w) + '.json');
  if (!fs.existsSync(f)) continue;
  const db = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
  const items = db.items || [];
  if (items.some((x) => x.status === 'queued' || x.status === 'doing')) anyWork = true;

  // 自愈：doing 超过 60 分钟没进度 → 退回待办
  let healed = 0;
  for (const it of items) {
    if (it.status !== 'doing') continue;
    const ref = Date.parse(it.lastProgressAt || it.startedAt || it.createdAt || 0);
    if (ref && Date.now() - ref > 60 * 60000) { it.status = 'queued'; it.notes = [...(it.notes || []), { at: now.toISOString(), text: '超 60 分钟无进度，自动退回待办' }]; healed++; }
  }
  if (healed) say('【自愈】' + w + ' ' + healed + ' 条超时任务退回待办');

  const doing = items.filter((x) => x.status === 'doing').length;
  const room = MAX_DOING - doing;
  if (room <= 0) { if (healed) fs.writeFileSync(f, JSON.stringify(db, null, 2), 'utf8'); continue; }

  const cands = items.filter((x) => x.status === 'queued')
    .sort((a, b) => (a.priority - b.priority) || (Date.parse(a.createdAt) - Date.parse(b.createdAt)))
    .slice(0, room);
  if (!cands.length) { if (healed) fs.writeFileSync(f, JSON.stringify(db, null, 2), 'utf8'); continue; }

  // 查重：与同接收方 doing 或 24 小时内 done 的任务比标题相似度，≥0.25 判疑似重复 → 挂起不派
  const recent = items.filter((x) => x.status === 'doing' || (x.status === 'done' && Date.now() - Date.parse(x.doneAt || 0) < 24 * 3600000));
  for (const cand of cands) {
    const dup = recent.find((r) => r.id !== cand.id && sim(cand.title, r.title) >= 0.25);
    if (dup) {
      cand.status = 'paused';
      cand.notes = [...(cand.notes || []), { at: now.toISOString(), text: '疑似重复：与 ' + dup.id + '「' + String(dup.title).slice(0, 30) + '」同题（相似度≥0.5），自动挂起。确认不同题再重新激活。' }];
      say('【防重复】' + w + ' ' + cand.id + ' 疑似重复于 ' + dup.id + '，已挂起不派');
    }
  }
  const fresh = cands.filter((x) => x.status === 'queued');
  if (!fresh.length) { fs.writeFileSync(f, JSON.stringify(db, null, 2), 'utf8'); continue; }

  for (const cand of fresh) {
    cand.status = 'doing';
    cand.startedAt = cand.startedAt || now.toISOString();
    cand.lastProgressAt = now.toISOString();
    cand.notes = [...(cand.notes || []), { at: now.toISOString(), text: '自动接取' }];
  }
  fs.writeFileSync(f, JSON.stringify(db, null, 2), 'utf8');
  taken = taken || [];
  taken.push({ w, list: fresh.map((c) => ({ id: c.id, title: c.title })) });
}

// ── 进化清单候选自动激活：条件满足 → 自动建单派发（每 20 分钟评估一次）──
try {
  const CAND = 'E:/qqagent-tools/work/派单方/roadmap-candidates.json';
  const cand = JSON.parse(fs.readFileSync(CAND, 'utf8'));
  const activated = cand.activated || [];
  let notesLines = 0;
  try {
    for (const nf of fs.readdirSync('E:/qqagent-tools/work').filter((x) => x.startsWith('完成笔记-'))) {
      notesLines += fs.readFileSync('E:/qqagent-tools/work/' + nf, 'utf8').split('\n').length;
    }
  } catch { /* 无笔记不计 */ }
  let poolCount = 0;
  try { poolCount = (JSON.parse(fs.readFileSync(POOL, 'utf8')).orders || []).length; } catch { /* 无池不计 */ }
  let failLines = 0;
  try { failLines = fs.readFileSync(path.join(DATA, 'tasks', 'failures.jsonl'), 'utf8').split('\n').filter(Boolean).length; } catch { /* 无失败不计 */ }
  let poolDone2 = {};
  try { poolDone2 = JSON.parse(fs.readFileSync(POOL, 'utf8')); } catch { }
  for (const c of cand.candidates || []) {
    if (activated.includes(c.key)) continue;
    let hit = false;
    if (c.cond.type === 'countNotes') hit = notesLines + poolCount > c.cond.gt;
    else if (c.cond.type === 'countFailures') hit = failLines > c.cond.gt;
    else if (c.cond.type === 'woDone') {
      const o = (poolDone2.orders || []).find((x) => x.id === c.cond.id);
      hit = o && o.status === 'done';
    }
    if (!hit) continue;
    try {
      const spec = { source: '派单方', orders: [{ key: c.key, title: c.title, why: c.why, acceptance: c.acceptance, deps: [], window_hint: c.window_hint, priority: c.priority || 2 }] };
      const tmp = 'C:/Users/Administrator/AppData/Local/Temp/cand-' + c.key + '.json';
      fs.writeFileSync(tmp, JSON.stringify(spec), 'utf8');
      execFileSync(process.execPath, [WO, 'new', '-f', tmp], { timeout: 30000, encoding: 'utf8', windowsHide: true });
      execFileSync(process.execPath, [WO, 'handoff'], { timeout: 30000, encoding: 'utf8', windowsHide: true });
      activated.push(c.key);
      say('【进化清单激活】' + c.key + ' 条件满足，已自动建单派发：' + c.title);
    } catch { /* 单条失败不阻断 */ }
  }
  cand.activated = activated;
  fs.writeFileSync(CAND, JSON.stringify(cand, null, 2), 'utf8');
} catch { /* 候选清单读不到不阻断 */ }

// ── SLA 检查（WO-0046）：验收超时 + 停滞告警（每单 6h 去重，机器判定零上下文）──
try {
  const SLAS = path.join(DATA, 'tasks', 'sla-state.json');
  let slaSt = {};
  try { slaSt = JSON.parse(fs.readFileSync(SLAS, 'utf8')); } catch { /* 首跑 */ }
  const nowMs = Date.now();
  let changed = false;
  for (const o of (JSON.parse(fs.readFileSync(POOL, 'utf8')).orders || [])) {
    const key = 'a:' + o.id;
    const last = Number(slaSt[key] || 0);
    if (nowMs - last < 6 * 3600000) continue;
    let msg = null;
    if (o.status === 'review' && Date.parse(o.updatedAt) && nowMs - Date.parse(o.updatedAt) > 24 * 3600000) {
      msg = '【SLA·验收超时】' + o.id + ' review 挂超 24h：' + String(o.title).slice(0, 40) + '（请派单方尽快 accept/reject）';
    } else if (o.status === 'doing' && o.lastProgressAt && nowMs - Date.parse(o.lastProgressAt) > 8 * 3600000) {
      msg = '【SLA·停滞】' + o.id + ' doing 超 8h 无进度：' + String(o.title).slice(0, 40) + '（建议重派或标 blocked）';
    }
    if (msg) { say(msg); slaSt[key] = nowMs; changed = true; }
  }
  if (changed) fs.writeFileSync(SLAS, JSON.stringify(slaSt, null, 2), 'utf8');
} catch { /* SLA 检查失败不阻断 */ }

// ── 派单方验收口子：push 待验收清单（集合变化才推）+ 执行派单方的 accept/reject 指令 ──
try {
  const CMDSTATE = path.join(DATA, 'tasks', 'xiaoyu-review-state.json');
  let rst = {};
  try { rst = JSON.parse(fs.readFileSync(CMDSTATE, 'utf8')); } catch { /* 首跑 */ }
  const poolNow = JSON.parse(fs.readFileSync(POOL, 'utf8'));
  const reviewIds = (poolNow.orders || []).filter((o) => o.status === 'review').map((o) => o.id);
  const sig = reviewIds.join(',');
  if (reviewIds.length && rst.lastSig !== sig) {
    fs.appendFileSync(CHAN, JSON.stringify({ at: new Date().toISOString(), who: '派单方', to: 'xiaoyu', kind: 'assign', text: '【待验收清单】' + reviewIds.join(' ') + '｜回「accept <id>」或「reject <id> <原因>」，机器替你执行' }) + '\n', 'utf8');
    rst.lastSig = sig;
  }
  const chanText = fs.readFileSync(CHAN, 'utf8');
  const lines = chanText.split('\n');
  let from = Number(rst.lastLine || 0);
  for (let i = from; i < lines.length; i++) {
    const l = lines[i]; if (!l.trim()) continue;
    let m; try { m = JSON.parse(l); } catch { continue; }
    if (m.who !== 'xiaoyu') continue;
    const mm = String(m.text || '').match(/^\s*(accept|reject)\s+(WO-\d{8}-\d{4})\s*(.*)$/);
    if (!mm) continue;
    try {
      const args = mm[1] === 'accept' ? [WO, 'accept', mm[2]] : [WO, 'reject', mm[2], String(mm[3] || '派单方拒绝').trim()];
      execFileSync(process.execPath, args, { timeout: 60000, encoding: 'utf8', windowsHide: true });
      fs.appendFileSync(CHAN, JSON.stringify({ at: new Date().toISOString(), who: '派单方', to: 'xiaoyu', kind: 'ack', text: '已执行你的 ' + mm[1] + ' ' + mm[2] }) + '\n', 'utf8');
    } catch { /* 单条失败不阻断，下轮重试 */ }
  }
  rst.lastLine = lines.length;
  fs.writeFileSync(CMDSTATE, JSON.stringify(rst, null, 2), 'utf8');
} catch { /* 验收口子失败不阻断 */ }

// ── 工单池自动派单：就绪（依赖满足）但没人领的 queued 单，按建议接收方自动 assign ──
let assigned = [];
try {
  const pool = JSON.parse(fs.readFileSync(POOL, 'utf8'));
  for (const o of pool.orders || []) {
    if (o.status !== 'queued' || o.window || !o.window_hint) continue;
    const badDep = (o.deps || []).some((d) => {
      const x = (pool.orders || []).find((y) => y.id === d);
      return !x || !['done', 'dropped'].includes(x.status);
    });
    if (badDep) continue;
    try {
      execFileSync(process.execPath, [WO, 'assign', o.id, o.window_hint], { timeout: 30000, encoding: 'utf8', windowsHide: true });
      assigned.push(o.id + '→' + o.window_hint);
    } catch { /* 单张失败不阻断其它 */ }
  }
} catch { /* 池子读不到不阻断 */ }
if (assigned.length) {
  st.lastTaskAt = Date.now(); st.sleepUntil = 0;
  fs.writeFileSync(STATE, JSON.stringify(st, null, 2), 'utf8');
  say('【自动派单】' + assigned.join('；'));
  console.log('自动派单 ' + assigned.length + ' 张：' + assigned.join('；'));
}

if (taken && taken.length) {
  st.lastTaskAt = Date.now(); st.sleepUntil = 0;
  fs.writeFileSync(STATE, JSON.stringify(st, null, 2), 'utf8');
  for (const g of taken) {
    const names = g.list.map((x) => x.id + ' ' + String(x.title).slice(0, 20)).join('；');
    say('【自动接取】' + g.w + ' 接下 ' + g.list.length + ' 条：' + names.slice(0, 120));
    console.log(g.w + ' 接下 ' + g.list.length + ' 条：' + names);
  }
} else if (anyWork) {
  // 有活但本轮接不动（doing 满员）：刷新活动时间、保持唤醒，不算"没活"
  st.lastTaskAt = Date.now(); st.sleepUntil = 0;
  fs.writeFileSync(STATE, JSON.stringify(st, null, 2), 'utf8');
  console.log('有活但接不动（doing 满员或全在自愈），保持唤醒，下一轮再试');
} else {
  const idleMin = Math.round((Date.now() - st.lastTaskAt) / 60000);
  if (!forced && st.lastTaskAt && idleMin >= IDLE_SLEEP_MIN) {
    st.sleepUntil = nextForcePoint().getTime();
    fs.writeFileSync(STATE, JSON.stringify(st, null, 2), 'utf8');
    say('【休眠】连续 ' + idleMin + ' 分钟没活，睡到 ' + new Date(st.sleepUntil).toLocaleString('zh-CN'));
    console.log('没活 ' + idleMin + ' 分钟 → 休眠到 ' + new Date(st.sleepUntil).toLocaleString('zh-CN'));
  } else {
    console.log('没活（' + (st.lastTaskAt ? idleMin + ' 分钟' : '首次') + '，继续 20 分钟一轮）');
  }
}
