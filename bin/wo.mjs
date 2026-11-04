#!/usr/bin/env node
// 派单层 · 工单库
// 职责边界（谁用什么命令）：
//   派单层：new / check / handoff / accept / reject / tidy / windows
//   派单方  ：ready / assign / accept / windows / tidy
//   各接收方：pull / report / submit / block
// 用法：
//   node wo.mjs new -f <spec.json>              从派单方产物导入工单（数组或 {orders:[]}）
//   node wo.mjs list [--status x] [--window w]  列单
//   node wo.mjs show <id>                       看一张单的全文
//   node wo.mjs check [id]                      校验字段/依赖/环
//   node wo.mjs handoff <id...>                 派给派单方（写 harness-inbox + 频道报一句）
//   node wo.mjs ready [--window w]              可分配的单（依赖已满足）
//   node wo.mjs assign <id> <接收方>               派单方把单派给某个接收方
//   node wo.mjs pull <接收方> [id]                 接收方领单（依赖没满足不给领）
//   node wo.mjs report <id> "<进度>"             接收方上报进度
//   node wo.mjs submit <id> "<证据>"             接收方交验收（证据必填）
//   node wo.mjs accept <id> ["结论"]             验收通过（有 eval 型验收时自动跑，不过不放行）
//   node wo.mjs verify <id>                       只跑 eval 型验收，看每条的 pass/fail（接收方自检用）
//   node wo.mjs reject <id> "<原因>"             打回
//   node wo.mjs block <id> "<卡点原文>"           标阻塞
//   node wo.mjs windows [--json]                接收方上下文表（派单方分配用）
//   node wo.mjs tidy [--apply]                  归纳：哪些该整理、哪些直接丢
//   node wo.mjs stats                           汇总
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { installFailHook, reportFailure } from '../lib/fail-hook.mjs';


installFailHook('派单方', '工单库');

const DATA = process.env.DSH_WORKFLOW_DATA || path.join(process.cwd(), 'data');
const DIR = path.join(DATA, 'workorders');
const POOL = path.join(DIR, 'pool.json');
const ARCH = path.join(DIR, 'archive');
const WIN = path.join(DATA, 'tasks', 'windows');
const INBOX = path.join(DATA, 'harness-inbox');
const CTRL = path.join(DATA, 'harness-control');
const CHAN = path.join(DATA, 'channel.jsonl');
const SESSMAP = path.join(DATA, 'tasks', 'session-map.json');
const REGISTRY = path.join(DIR, 'windows-registry.json');

const now = () => new Date().toISOString();
const stamp = () => now().replace(/[:.]/g, '-');
const today = () => now().slice(0, 10).replace(/-/g, '');
const SRC = 'E:/qqagent-tools/work/派单方/wo.mjs';
const CFG_PATH = 'E:/qqagent-tools/work/config.json';
function readCfg() {
  try { return JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); }
  catch { return null; }
}
const clipStr = (s, n) => { const v = String(s || '').replace(/\s+/g, ' ').trim(); return v.length > n ? v.slice(0, n) + '…' : v; };

const STATUSES = ['draft', 'queued', 'assigned', 'doing', 'review', 'done', 'blocked', 'dropped'];

for (const d of [DIR, ARCH, WIN, CTRL]) fs.mkdirSync(d, { recursive: true });

// ── 读写 ──────────────────────────────────────────────
function readJson(p, fb) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { if (fs.existsSync(p)) reportFailure('派单方', '读 JSON 失败：' + p, e.stack || String(e), SRC + ':57'); return fb; }
}
function writeJsonAtomic(p, v) {
  const tmp = p + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}
function loadPool() {
  const p = readJson(POOL, null);
  if (p && Array.isArray(p.orders)) return p;
  return { version: 1, seq: 0, orders: [] };
}
function savePool(p) { writeJsonAtomic(POOL, p); }
function findOrder(pool, id) { return pool.orders.find((o) => o.id === id); }
function nextId(pool) {
  pool.seq = (pool.seq || 0) + 1;
  return 'WO-' + today() + '-' + String(pool.seq).padStart(4, '0');
}

function queueFile(w) { return path.join(WIN, encodeURIComponent(String(w).trim()) + '.json'); }
function loadQueue(w) { return readJson(queueFile(w), { window: w, createdAt: now(), items: [] }) || { window: w, createdAt: now(), items: [] }; }
function saveQueue(w, db) { writeJsonAtomic(queueFile(w), db); }

function channel(rec) {
  try { fs.appendFileSync(CHAN, JSON.stringify({ at: now(), ...rec }) + '\n', 'utf8'); }
  catch (e) { reportFailure('派单方', '写频道失败', e.stack || String(e), SRC + ':78'); }
}

// 群汇报：状态变化直接说到「负责人 + 派单方」的群里；qqNotify=false 时改写本地频道（通用化，零外部调用）
async function notifyGroup(kind, who, ref, text) {
  try {
    const cfg = readCfg();
    const chan = (cfg && cfg.channel) || CHAN;
    fs.appendFileSync(chan, JSON.stringify({ at: now(), who, kind, ref, text }) + '\n', 'utf8');
  }
  catch (e) { reportFailure('派单方', '群汇报失败（已记台账）', e.stack || String(e), SRC + ':86'); }
}

// ── 并发：pool 锁（两个执行体同时领单会丢数据，必须串行化）─────────
const LOCK = POOL + '.lock';
let LOCKED = false;
function withLock(fn) {
  if (LOCKED) return fn();                       // 可重入：同进程嵌套直接进
  for (let i = 0; i < 100; i++) {
    try {
      const fd = fs.openSync(LOCK, 'wx');
      fs.writeSync(fd, process.pid + '@' + now());
      fs.closeSync(fd);
      LOCKED = true;
      try { return fn(); } finally { LOCKED = false; try { fs.unlinkSync(LOCK); } catch { } }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(LOCK).mtimeMs > 10000) { fs.unlinkSync(LOCK); continue; } } catch { }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  throw new Error('拿不到 pool 锁（10 秒）：' + LOCK);
}

// ── 去重指纹：同一件事不许拆两次、派两次 ─────────────────
function fingerprint(title) {
  const norm = String(title)
    .replace(/^[\s【\[（(][^\]】)）]{1,12}[\]】)）]\s*/, '')
    .replace(/[\s，,。.、:：;；!！?？()（）\[\]【】"'“”‘’\-—_/\\]/g, '')
    .toLowerCase();
  return crypto.createHash('sha1').update(norm).digest('hex').slice(0, 10);
}

// ── 租约：认领不是永久的，超时自动放回池子 ────────────────
const LEASE_MIN = Number(process.env.WO_LEASE_MIN || 30);
const leaseAlive = (o) => !!(o.leaseUntil && Date.parse(o.leaseUntil) > Date.now());
function renewLease(o) { o.leaseUntil = new Date(Date.now() + LEASE_MIN * 60000).toISOString(); }

// ── presence：每个执行体写自己的心跳，一张表看谁在干什么 ─────
const PRES = path.join(DATA, 'presence');
fs.mkdirSync(PRES, { recursive: true });
const PRES_TTL_MIN = Number(process.env.WO_PRESENCE_MIN || 15);
const presenceFile = (agent) => path.join(PRES, encodeURIComponent(agent) + '.json');
function writePresence(agent, patch) {
  const cur = readJson(presenceFile(agent), {}) || {};
  const next = { agent, ...cur, ...patch, at: now() };
  writeJsonAtomic(presenceFile(agent), next);
  return next;
}
function readPresence() {
  const out = [];
  try {
    for (const f of fs.readdirSync(PRES)) {
      if (!f.endsWith('.json')) continue;
      const p = readJson(path.join(PRES, f), null);
      if (!p || !p.agent) continue;
      const idleMin = Math.round((Date.now() - Date.parse(p.at)) / 60000);
      out.push({ ...p, idleMin, expired: idleMin > PRES_TTL_MIN });
    }
  } catch (e) { reportFailure('派单方', '读 presence 失败', e.stack || String(e), SRC + ':140'); }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

// ── 验收标准归一化 ─────────────────────────────────────
// 允许四种写法：
//   "人能看懂的一句话"                         → manual
//   {"check":"file","path":"E:/x","expect":"存在"}   → file
//   {"check":"cmd","cmd":"node x.mjs","expect":"退出码0"} → cmd
//   {"check":"eval","cmd":"node x.mjs","expect":"包含的字串","mode":"contains|equals|exit0"} → eval（accept 时自动跑，不过不放行）
function normAccept(a) {
  if (typeof a === 'string') return { check: 'manual', text: a.trim(), expect: a.trim() };
  if (!a || typeof a !== 'object') return { check: 'manual', text: String(a), expect: String(a) };
  const check = a.check || (a.path ? 'file' : a.cmd ? (a.mode === 'contains' || a.mode === 'equals' ? 'eval' : 'cmd') : 'manual');
  const mode = a.mode || (check === 'eval' ? 'contains' : undefined);
  return {
    check,
    text: a.text || a.expect || a.path || a.cmd || '',
    path: a.path || undefined,
    cmd: a.cmd || undefined,
    expect: a.expect || '',
    mode,
  };
}

// ── eval 型验收执行 ────────────────────────────────────
// 每条跑一次命令，按 mode 判定；返回 {results:[{ok,out,exit}], allOk}
function runEvalChecks(o) {
  const evals = (o.acceptance || []).filter((a) => a.check === 'eval');
  if (!evals.length) return { results: [], allOk: true };
  const results = [];
  for (const a of evals) {
    try {
      const out = execSync(a.cmd, { shell: 'cmd.exe', cwd: process.env.DSH_WORKFLOW_ROOT || process.cwd(), timeout: 90000, encoding: 'utf8', windowsHide: true });
      const text = String(out || '').trim();
      let ok;
      if (a.mode === 'equals') ok = text === String(a.expect).trim();
      else if (a.mode === 'exit0') ok = true;
      else ok = text.includes(String(a.expect));
      results.push({ ok, out: text.slice(0, 400), exit: 0 });
    } catch (e) {
      const out = String((e && (e.stdout || e.stderr)) || e).slice(0, 400);
      const isExit0 = a.mode === 'exit0' && e.status === 0;
      results.push({ ok: isExit0, out, exit: e.status ?? 1 });
    }
  }
  return { results, allOk: results.every((r) => r.ok) };
}
function normOrder(raw, pool) {
  const REDLINE = /(花钱|付费|买入|购买|充值|转账|删除|清空|下线|对外提交|提交漏洞|投稿|发布|上线|注册|开户|实盘|承诺|报价|签合同)/;
  const o = {
    id: raw.id && /^WO-\d{8}-\d{4}$/.test(raw.id) ? raw.id : nextId(pool),
    title: String(raw.title || '').trim(),
    why: String(raw.why || '').trim(),
    acceptance: (Array.isArray(raw.acceptance) ? raw.acceptance : raw.acceptance ? [raw.acceptance] : []).map(normAccept),
    deps: Array.isArray(raw.deps) ? raw.deps.filter(Boolean) : raw.deps ? [raw.deps] : [],
    window_hint: raw.window_hint || raw.windowHint || raw.window || null,
    priority: Number(raw.priority || 2),
    key: raw.key || null,
    status: raw.status || 'draft',
    window: raw.window || null,
    source: raw.source || '派单方',
    deliverable: raw.deliverable || null,
    scope: Array.isArray(raw.scope) ? raw.scope : raw.scope ? [raw.scope] : [],
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    notes: [],
    evidence: [],
    createdAt: now(),
    updatedAt: now(),
    startedAt: null,
    doneAt: null,
  };
  o.needsYone = !!raw.needsYone || REDLINE.test(o.title + ' ' + o.why) || o.tags.includes('不可逆');
  if (o.needsYone && !o.tags.includes('不可逆')) o.tags.push('不可逆');
  return o;
}

// ── 依赖 ──────────────────────────────────────────────
function depsState(pool, o) {
  const out = { done: [], pending: [], dropped: [] };
  for (const d of o.deps || []) {
    const dep = findOrder(pool, d);
    if (!dep) out.pending.push({ id: d, why: '依赖单不存在' });
    else if (dep.status === 'done') out.done.push(d);
    else if (dep.status === 'dropped') out.dropped.push(d);
    else out.pending.push({ id: d, why: dep.title + '（' + dep.status + '）' });
  }
  return out;
}
function depsReady(pool, o) {
  const s = depsState(pool, o);
  return s.pending.length === 0 && s.dropped.length === 0;
}

// ── scope 冲突域（WO-0006）：同一文件/目录同时只许一张单在做 ──────────
function scopeOverlap(a, b) {
  for (const x of a || []) for (const y of b || []) {
    const X = String(x).replace(/\\/g, '/').toLowerCase().trim();
    const Y = String(y).replace(/\\/g, '/').toLowerCase().trim();
    if (!X || !Y) continue;
    if (X === Y) return true;
    // 目录与子文件：一方是另一方的前缀（目录以 / 结尾，或前缀后紧跟 /）
    if (X.endsWith('/') && Y.startsWith(X)) return true;
    if (Y.endsWith('/') && X.startsWith(Y)) return true;
  }
  return false;
}
function scopeConflict(pool, o) {
  if (!o.scope || !o.scope.length) return null;
  return (pool.orders || []).find((x) =>
    x.id !== o.id && ['assigned', 'doing'].includes(x.status) && scopeOverlap(x.scope, o.scope));
}

function findCycle(pool) {
  const byId = new Map(pool.orders.map((o) => [o.id, o]));
  const state = new Map();
  const bad = [];
  const walk = (id, trail) => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) { bad.push([...trail, id].join(' → ')); return; }
    state.set(id, 1);
    const o = byId.get(id);
    for (const d of (o && o.deps) || []) if (byId.has(d)) walk(d, [...trail, id]);
    state.set(id, 2);
  };
  for (const o of pool.orders) walk(o.id, []);
  return bad;
}

// ── 工单渲染（给接收方看的正文） ───────────────────────────
function renderOrder(o) {
  const L = [];
  L.push('# ' + o.title, '');
  L.push('- 工单：' + o.id);
  L.push('- 优先级：P' + o.priority);
  L.push('- 建议接收方：' + (o.window_hint || '不限') + '（建议，不是决定）');
  L.push('- 依赖：' + (o.deps.length ? o.deps.join('、') : '无'));
  if (o.why) L.push('- 为什么做：' + o.why);
  L.push('', '## 验收标准（做完要逐条对上）', '');
  o.acceptance.forEach((a, i) => {
    const tag = a.check === 'file' ? '文件' : a.check === 'cmd' ? '命令' : '人工';
    L.push((i + 1) + '. [' + tag + '] ' + (a.check === 'file' ? a.path : a.check === 'cmd' ? a.cmd : a.text));
    if (a.expect) L.push('   - 算过：' + a.expect);
  });
  if (o.deliverable) L.push('', '## 交付物', '', String(o.deliverable));
  L.push('', '## 收尾（必须带证据，写"做完了"不算）', '', '```',
    'node bin/派单方\\wo.mjs submit ' + o.id + ' "<证据：路径/输出原文/截图路径>"', '```');
  return L.join('\n');
}

// ── 队列同步：pool ↔ windows/<接收方>.json ────────────────
function queueItem(o) {
  return {
    id: o.id, title: o.title, body: renderOrder(o).slice(0, 4000),
    priority: o.priority, status: 'queued',
    createdAt: now(), startedAt: null, doneAt: null,
    notes: [], source: '派单层工单',
  };
}
const Q2P = { queued: 'assigned', doing: 'doing', done: 'review', blocked: 'blocked' };

function reconcile() {
  return withLock(() => {
  const pool = loadPool();
  let changed = false;
  for (const o of pool.orders) {
    if (!o.window) continue;
    if (o.status === 'done' || o.status === 'dropped') continue;
    const db = loadQueue(o.window);
    const it = (db.items || []).find((i) => i.id === o.id);
    if (!it) {
      if (['assigned', 'doing', 'review', 'blocked'].includes(o.status)) {
        const fresh = queueItem(o);
        fresh.status = o.status === 'review' ? 'done' : o.status === 'assigned' ? 'queued' : o.status;
        db.items.push(fresh); saveQueue(o.window, db); changed = true;
      }
      continue;
    }
    const want = Q2P[it.status];
    if (want && o.status !== want) { o.status = want; o.updatedAt = now(); changed = true; }
    if (it.doneAt && !o.doneAt && it.status === 'done') { o.updatedAt = now(); changed = true; }
  }
  if (changed) savePool(pool);
  return pool;
  });
}

// ── 接收方上下文 ────────────────────────────────────────
function windowList() {
  const set = new Set(['alice', 'bob', 'carol', '派单方']);
  try { for (const f of fs.readdirSync(WIN)) if (f.endsWith('.json')) set.add(decodeURIComponent(f.replace('.json', ''))); } catch { }
  return [...set];
}
function buildWindows() {
  const pool = loadPool();
  const sess = readJson(SESSMAP, {}) || {};
  const rev = {};
  for (const [sid, w] of Object.entries(sess)) (rev[w] = rev[w] || []).push(sid);
  const chan = readLines(CHAN);
  return windowList().map((w) => {
    const db = loadQueue(w);
    const items = db.items || [];
    const doing = items.find((i) => i.status === 'doing');
    const queued = items.filter((i) => i.status === 'queued');
    const doneN = items.filter((i) => i.status === 'done').length;
    const lastNote = doing && doing.notes && doing.notes.length ? doing.notes[doing.notes.length - 1] : null;
    const chanLast = [...chan].reverse().find((m) => m.who === w);
    const lastSeen = [lastNote && lastNote.at, doing && doing.lastProgressAt, chanLast && chanLast.at]
      .filter(Boolean).sort().pop() || null;
    const idleMin = lastSeen ? Math.round((Date.now() - Date.parse(lastSeen)) / 60000) : null;
    const openWo = pool.orders.filter((o) => o.window === w && !['done', 'dropped'].includes(o.status));
    return {
      window: w,
      state: doing ? 'busy' : 'idle',
      current: doing ? { id: doing.id, title: doing.title, since: doing.startedAt || doing.createdAt } : null,
      doingCount: doing ? 1 : 0,
      queued: queued.length,
      openWorkorders: openWo.length,
      doneTotal: doneN,
      lastSeen,
      idleMin,
      stale: idleMin === null ? true : idleMin > 360,
      lastNote: lastNote ? String(lastNote.text).slice(0, 120) : null,
      sessions: (rev[w] || []).slice(0, 2),
    };
  });
}
function readLines(p) {
  try {
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// ── 子命令 ────────────────────────────────────────────
const [cmd, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith('-')));

// 位置参数：跳过 flag 本身和它的值（否则 presence "在写工单" 会把 --state 的 busy 也吃进去）
const VALUE_FLAGS = new Set(['--as', '--to', '--kind', '--ref', '--state', '--task',
  '--f', '-f', '--file', '--status', '--window', '--n', '--timeout']);
const args = (() => {
  const out = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('-')) { if (VALUE_FLAGS.has(a)) i++; continue; }
    out.push(a);
  }
  return out;
})();

function opt(name, def) {
  let i = rest.indexOf('--' + name);
  if (i < 0) i = rest.indexOf('-' + name);
  if (i < 0) return def;
  const v = rest[i + 1];
  return v && !v.startsWith('-') ? v : def;
}

switch (cmd) {
  case 'new': {
    const f = opt('f') || opt('file');
    if (!f) { console.log('用法：new -f <spec.json>   或  new --title "..." --accept "a|b" --deps "id1,id2" --hint 接收方 --prio 2'); break; }
    const raw = readJson(path.resolve(f), null);
    if (!raw) { console.log('读不到 spec：' + f); break; }
    const list = Array.isArray(raw) ? raw : Array.isArray(raw.orders) ? raw.orders : [raw];
    reconcile();
    const added = [], dups = [];
    withLock(() => {
    const pool = loadPool();
    const openFp = new Map();
    for (const o of pool.orders) {
      if (['done', 'dropped'].includes(o.status)) continue;
      openFp.set(o.fingerprint || fingerprint(o.title), o);
    }
    for (const r of list) {
      const o = normOrder(r, pool);
      o.acceptance = o.acceptance.map((a) => (a.check === 'manual' && !a.expect ? { ...a, expect: a.text } : a));
      o.fingerprint = fingerprint(o.title);
      const hit = openFp.get(o.fingerprint);
      if (hit) { pool.seq -= 1; dups.push({ title: o.title, hit }); continue; }
      openFp.set(o.fingerprint, o);
      pool.orders.push(o);
      added.push(o);
    }
    // 依赖可以用 spec 里的 key 写，导入后换成真 id
    const keyMap = new Map();
    for (const o of added) if (o.key) keyMap.set(o.key, o.id);
    for (const o of added) o.deps = o.deps.map((d) => keyMap.get(d) || d);
    savePool(pool);
    });
    for (const d of dups) console.log('⏭ 跳过重复：' + d.title + '（已有未完成单 ' + d.hit.id + ' ' + d.hit.status + '）');
    for (const o of added) console.log('已建单：' + o.id + '  P' + o.priority + '  ' + o.title);
    if (!added.length) { console.log('\n没有新单（全部命中去重）'); break; }
    console.log('\n下一步：node wo.mjs check  →  node wo.mjs handoff ' + added.map((o) => o.id).join(' '));
    break;
  }

  case 'list': {
    const pool = reconcile();
    const st = opt('status'), w = opt('window');
    const rows = pool.orders.filter((o) => (!st || o.status === st) && (!w || o.window === w));
    if (!rows.length) { console.log('（没有符合条件的工单）'); break; }
    for (const o of rows) {
      const mark = { draft: '·', queued: '⏳', assigned: '📌', doing: '🔄', review: '🔍', done: '✅', blocked: '⛔', dropped: '🗑' }[o.status] || '?';
      console.log(`${mark} ${o.id}  P${o.priority}  ${o.status.padEnd(8)}  ${(o.window || o.window_hint || '-').padEnd(10)}  ${o.title}`);
    }
    break;
  }

  case 'show': {
    const pool = reconcile();
    const o = findOrder(pool, args[0]);
    if (!o) { console.log('没这张单：' + args[0]); break; }
    console.log(renderOrder(o));
    if (o.notes.length) { console.log('\n## 进度记录'); for (const n of o.notes) console.log('- ' + n.at.slice(5, 16).replace('T', ' ') + '  ' + n.text); }
    if (o.evidence.length) { console.log('\n## 证据'); for (const n of o.evidence) console.log('- ' + n.at.slice(5, 16).replace('T', ' ') + '  ' + n.text); }
    console.log('\n状态：' + o.status + (o.window ? '｜接收方：' + o.window : ''));
    break;
  }

  case 'check': {
    const pool = reconcile();
    const targets = args.length ? args.map((id) => findOrder(pool, id)).filter(Boolean) : pool.orders.filter((o) => o.status !== 'done');
    let bad = 0;
    for (const o of targets) {
      const errs = [];
      if (!o.title) errs.push('缺标题');
      if (!o.acceptance.length) errs.push('没有验收标准');
      for (const a of o.acceptance) {
        if (a.check === 'file' && !a.path) errs.push('file 类验收缺 path');
        if (a.check === 'cmd' && !a.cmd) errs.push('cmd 类验收缺 cmd');
        if (!a.expect) errs.push('验收"' + (a.text || a.path) + '"没写怎样算过');
      }
      for (const d of o.deps) if (!findOrder(pool, d)) errs.push('依赖不存在：' + d);
      if (errs.length) { bad++; console.log('❌ ' + o.id + ' ' + o.title); for (const e of errs) console.log('    - ' + e); }
    }
    const cyc = findCycle(pool);
    for (const c of cyc) { bad++; console.log('❌ 依赖成环：' + c); }
    console.log(bad ? `\n${bad} 张单有问题` : `\n${targets.length} 张单全部通过`);
    process.exitCode = bad ? 1 : 0;
    break;
  }

  case 'handoff': {
    const pool = reconcile();
    const ids = args.length ? args : pool.orders.filter((o) => o.status === 'draft').map((o) => o.id);
    if (!ids.length) { console.log('没有可派的单（用 draft 状态或显式给 id）'); break; }
    const picked = ids.map((id) => findOrder(pool, id)).filter(Boolean);
    if (!picked.length) { console.log('没找到：' + ids.join(',')); break; }
    // P1 配额：全标 P1 等于没有优先级，当天超额的自动降 P2
    const QUOTA = Number(process.env.WO_P1_QUOTA || 3);
    const day = new Date().toISOString().slice(0, 10);
    let used = pool.orders.filter((o) => o.priority === 1 && o.status !== 'draft' && String(o.createdAt).slice(0, 10) === day).length;
    const downgraded = [];
    for (const o of picked) {
      if (o.priority !== 1) continue;
      if (used >= QUOTA) { o.priority = 2; o.notes.push({ at: now(), text: 'P1 配额（' + QUOTA + ' 张/天）已满，自动降 P2' }); downgraded.push(o); }
      else used++;
    }
    const L = ['# 派单层交付：' + picked.length + ' 张工单', '', '我是派单层。以下工单已拆好，派单/分配由你决定，我不碰接收方。', ''];
    for (const o of picked) {
      o.status = o.status === 'draft' ? 'queued' : o.status;
      o.updatedAt = now();
      L.push('## ' + o.id + '｜P' + o.priority + '｜建议 ' + (o.window_hint || '不限'), '');
      L.push('**' + o.title + '**', '');
      if (o.why) L.push('为什么：' + o.why, '');
      L.push('依赖：' + (o.deps.length ? o.deps.join('、') : '无'), '');
      L.push('验收：');
      o.acceptance.forEach((a, i) => L.push((i + 1) + '. ' + (a.check === 'file' ? a.path : a.check === 'cmd' ? '`' + a.cmd + '`' : a.text) + ' —— ' + a.expect));
      L.push('');
    }
    L.push('---', '分配用：`node bin/派单方\\wo.mjs assign <id> <接收方>`', '接收方上下文：`node bin/派单方\\wo.mjs windows`');
    fs.mkdirSync(INBOX, { recursive: true });
    const file = path.join(INBOX, stamp() + '-workorder.md');
    fs.writeFileSync(file, L.join('\n'), 'utf8');
    savePool(pool);
    channel({ who: '派单方', to: 'xiaoyu', kind: 'assign', ref: picked.map((o) => o.id).join(','), text: '派单层交付 ' + picked.length + ' 张工单：' + picked.map((o) => o.id + ' ' + o.title).join('｜') + '。信件：' + file });
    console.log('已派给派单方：' + file);
    for (const o of picked) console.log('  ' + o.id + '  P' + o.priority + '  ' + o.title);
    for (const o of downgraded) console.log('  ⚠ P1 配额已满，' + o.id + ' 自动降为 P2');
    break;
  }

  case 'ready': {
    const pool = reconcile();
    const w = opt('window');
    const rows = pool.orders.filter((o) => o.status === 'queued' && depsReady(pool, o) && (!w || !o.window_hint || o.window_hint === w));
    if (!rows.length) { console.log('（没有可分配的单）'); break; }
    for (const o of rows) console.log(`${o.id}  P${o.priority}  建议 ${(o.window_hint || '不限').padEnd(10)}  ${o.title}`);
    console.log('\n分配：node wo.mjs assign <id> <接收方>');
    break;
  }

  case 'assign': {
    const pool = reconcile();
    const [id, w] = args;
    const o = findOrder(pool, id);
    if (!o) { console.log('没这张单：' + id); break; }
    if (!w) { console.log('用法：assign <id> <接收方>'); break; }
    const ds = depsState(pool, o);
    // 已经在别家手里做着的单，不许被悄悄改派（抢单）
    if (o.owner && o.owner !== w && o.status === 'doing' && leaseAlive(o) && !flags.has('--force')) {
      console.log('改派被拒：' + o.id + ' 正由「' + o.owner + '」执行，租约到 ' + o.leaseUntil.slice(11, 16) + '。确认要抢用 --force');
      process.exitCode = 4; break;
    }
    o.window = w; o.owner = w; o.status = 'assigned'; o.updatedAt = now();
    savePool(pool);
    const db = loadQueue(w);
    db.items = db.items || [];
    if (!db.items.some((i) => i.id === o.id)) { db.items.push(queueItem(o)); saveQueue(w, db); }
    channel({ who: 'xiaoyu', to: w, kind: 'assign', ref: o.id, text: '派单：' + o.id + ' ' + o.title + (ds.pending.length ? '（依赖未完成：' + ds.pending.map((x) => x.id).join(',') + '，到点再领）' : '') });
    console.log('已派给「' + w + '」：' + o.id + '  ' + o.title);
    if (ds.pending.length) console.log('注意：依赖还没完成 → ' + ds.pending.map((x) => x.id + ' ' + x.why).join('；'));
    break;
  }

  case 'pull': {
    const pool = reconcile();
    const [w, wantId] = args;
    if (!w) { console.log('用法：pull <接收方> [工单id]'); break; }
    let o = wantId ? findOrder(pool, wantId) : null;
    if (!o) o = pool.orders.filter((x) => x.window === w && x.status === 'assigned').sort((a, b) => a.priority - b.priority || String(a.createdAt).localeCompare(String(b.createdAt)))[0];
    if (!o) { console.log('「' + w + '」没有待领的工单'); break; }
    if (o.window !== w) { console.log(o.id + ' 不归「' + w + '」，归「' + (o.window || '未分配') + '」'); process.exitCode = 1; break; }
    const ds = depsState(pool, o);
    if (ds.pending.length || ds.dropped.length) {
      console.log('领不了：依赖没完成 → ' + [...ds.pending, ...ds.dropped.map((d) => ({ id: d, why: '已被丢弃' }))].map((x) => x.id + ' ' + x.why).join('；'));
      process.exitCode = 3; break;
    }
    const clash0 = scopeConflict(pool, o);
    if (clash0) {
      console.log('领不了：scope 冲突——' + clash0.id + '（' + String(clash0.title).slice(0, 24) + '）正在改 ' + (clash0.scope || []).join('、') + '，等它 submit/block 再来');
      process.exitCode = 7; break;
    }
    // 原子认领：锁里重读一次，别人已经领走就拒绝（两个执行体同时 pull 不会都成功）
    const claim = withLock(() => {
      const p2 = loadPool();
      const o2 = findOrder(p2, o.id);
      if (!o2) return { err: '单子已不存在' };
      if (o2.owner && o2.owner !== w && o2.status === 'doing' && leaseAlive(o2)) {
        return { err: '「' + o2.owner + '」正在做，租约到 ' + o2.leaseUntil.slice(11, 16) + (o2.updatedAt ? '（最后动作 ' + o2.updatedAt.slice(11, 16) + '）' : '') };
      }
      o2.status = 'doing'; o2.startedAt = o2.startedAt || now(); o2.updatedAt = now();
      o2.window = o2.window || w; o2.owner = w; renewLease(o2);
      savePool(p2);
      return { o: o2 };
    });
    if (claim.err) { console.log('领不了：' + claim.err); process.exitCode = 4; break; }
    const o2 = claim.o;
    const db = loadQueue(w);
    db.items = db.items || [];
    const it = db.items.find((i) => i.id === o2.id);
    if (it) { it.status = 'doing'; it.startedAt = it.startedAt || now(); saveQueue(w, db); }
    writePresence(w, { state: 'busy', task: o2.id, title: o2.title, since: o2.startedAt, scope: o2.scope || [] });
    console.log(renderOrder(o2));
    break;
  }

  case 'take': {
    // 接收方自取：谁闲谁拿，不等派单方派。派单方只处理「派不出去的」。
    const w = opt('as', null) || args[0];
    if (!w) { console.log('用法：take <接收方>'); process.exitCode = 1; break; }
    const pool = reconcile();
    const busy = pool.orders.filter((o) => o.window === w && o.status === 'doing' && leaseAlive(o));
    if (busy.length) {
      console.log('你手上还有一张在做：' + busy[0].id + ' ' + busy[0].title + '（租约到 ' + String(busy[0].leaseUntil).slice(11, 16) + '）');
      console.log('先 wo.mjs submit / block / report，再来领新的');
      process.exitCode = 6; break;
    }
    const own = (o) => o.window === w;
    const cands = pool.orders.filter((o) =>
      ['queued', 'assigned'].includes(o.status) &&
      (!o.window || o.window === w) &&
      (!o.window_hint || o.window_hint === w || o.window_hint === '不限') &&
      depsReady(pool, o) &&
      !scopeConflict(pool, o))
      .sort((a, b) => (own(b) ? 1 : 0) - (own(a) ? 1 : 0) || a.priority - b.priority || String(a.createdAt).localeCompare(String(b.createdAt)));
    if (!cands.length) {
      const blocked = pool.orders.filter((o) => !o.window && !depsReady(pool, o)).length;
      console.log('「' + w + '」现在没活可领' + (blocked ? '（另有 ' + blocked + ' 张卡在依赖上）' : ''));
      process.exitCode = 4; break;
    }
    const target = cands[0];
    const claim = withLock(() => {
      const p2 = loadPool();
      const o2 = findOrder(p2, target.id);
      if (!o2 || !['queued', 'assigned'].includes(o2.status)) return { err: '被别人先领走了' };
      if (o2.window && o2.window !== w) return { err: '已归「' + o2.window + '」' };
      if (!depsReady(p2, o2)) return { err: '依赖还没完成' };
      o2.window = w; o2.owner = w; o2.status = 'doing';
      o2.startedAt = o2.startedAt || now(); o2.updatedAt = now(); renewLease(o2);
      savePool(p2);
      return { o: o2 };
    });
    if (claim.err) { console.log('没领到：' + claim.err + '（稍后重试）'); process.exitCode = 4; break; }
    const o2 = claim.o;
    const db = loadQueue(w);
    db.items = db.items || [];
    if (!db.items.some((i) => i.id === o2.id)) db.items.push(queueItem(o2));
    const it = db.items.find((i) => i.id === o2.id);
    it.status = 'doing'; it.startedAt = it.startedAt || now();
    saveQueue(w, db);
    writePresence(w, { state: 'busy', task: o2.id, title: o2.title, since: o2.startedAt });
    console.log(renderOrder(o2));
    console.log('\n（自取成功，不用等派单方点头。做完 submit，卡住 block。）');
    break;
  }

  case 'report': {
    const pool = reconcile();
    const [id, text] = args;
    const o = findOrder(pool, id);
    if (!o) { console.log('没这张单：' + id); break; }
    o.notes.push({ at: now(), text: text || '' });
    o.updatedAt = now();
    if (o.status === 'assigned') o.status = 'doing';
    renewLease(o);
    if (o.window) o.owner = o.window;
    savePool(pool);
    if (o.window) writePresence(o.window, { state: 'busy', task: o.id, title: o.title, note: String(text || '').slice(0, 80) });
    const db = o.window ? loadQueue(o.window) : null;
    if (db) {
      const it = (db.items || []).find((i) => i.id === o.id);
      if (it) { it.notes = it.notes || []; it.notes.push({ at: now(), text }); it.lastProgressAt = now(); saveQueue(o.window, db); }
    }
    channel({ who: o.window || '派单方', to: 'xiaoyu', kind: 'report', ref: o.id, text: '【' + (o.window || '?') + '】' + id + ' ' + text });
    console.log('已记录进度：' + id);
    break;
  }

  case 'submit': {
    const pool = reconcile();
    const [id, ev] = args;
    const o = findOrder(pool, id);
    if (!o) { console.log('没这张单：' + id); break; }
    if (!ev) { console.log('证据必填：submit <id> "<路径/输出原文>"'); process.exitCode = 1; break; }
    o.evidence.push({ at: now(), by: o.window || '?', text: ev });
    o.status = 'review'; o.updatedAt = now(); renewLease(o);
    savePool(pool);
    // 完成笔记：submit 证据自动落当天笔记（保留 7 天）
    try {
      const d = new Date();
      const ymd = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      const hhmm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      fs.appendFileSync('E:/qqagent-tools/work/完成笔记-' + ymd + '.md', '- [' + (o.window || '?') + '] ' + hhmm + ' ' + id + ' ' + String(o.title).slice(0, 60) + ' — ' + String(ev).slice(0, 120) + '\n', 'utf8');
    } catch { /* 笔记写失败不阻断 */ }
    if (o.window) writePresence(o.window, { state: 'idle', task: null, title: null, note: '交了 ' + o.id });
    if (o.window) {
      const db = loadQueue(o.window);
      const it = (db.items || []).find((i) => i.id === o.id);
      if (it) { it.status = 'done'; it.doneAt = now(); it.notes = it.notes || []; it.notes.push({ at: now(), text: '交验收：' + ev }); saveQueue(o.window, db); }
    }
    channel({ who: o.window || '?', to: 'xiaoyu', kind: 'submit', ref: o.id, text: '【交验收】' + id + ' ' + o.title + '｜证据：' + ev });
    await notifyGroup('done', o.window || '?', o.id, o.title + '｜证据：' + ev);
    console.log('已交验收：' + id + '（等派单层 accept/reject）');
    break;
  }

  case 'accept': {
    const pool = reconcile();
    const [id, note] = args;
    const o = findOrder(pool, id);
    if (!o) { console.log('没这张单：' + id); break; }
    // 红线闸门：花钱/删除/对外提交/改生产/代表 负责人 承诺 —— 只能 负责人 点头
    const byYone = flags.has('--by-负责人') || opt('by', null) === '负责人';
    if (o.needsYone && !byYone) {
      await notifyGroup('ask', '派单方', o.id, '触到红线（' + (o.tags.join('/') || '不可逆') + '），要 负责人 点头：' + o.title);
      console.log('这张单触到红线，派单方不能直接验收：' + o.id + ' ' + o.title);
      console.log('已把问题发到群里。负责人 回话后执行：accept ' + o.id + ' --by-负责人 "负责人 原话"');
      process.exitCode = 5; break;
    }
    // eval 型验收门禁：自动跑，不过不放行（派单层收口前先机器打分）
    if (!flags.has('--skip-eval')) {
      const ev = runEvalChecks(o);
      if (!ev.allOk) {
        const fails = ev.results.map((r, i) => '· ' + (i + 1) + ' [' + (r.ok ? 'pass' : 'FAIL') + '] exit=' + r.exit + '\n' + r.out.slice(0, 200)).join('\n');
        channel({ who: '派单方', to: o.window || 'xiaoyu', kind: 'reject', ref: o.id, text: '【eval 不过，验收拒绝】' + id + '\n' + fails });
        console.log('eval 型验收没过，已拒绝：' + id);
        console.log(fails);
        process.exitCode = 6; break;
      }
    }
    o.acceptedBy = byYone ? '负责人' : 'xiaoyu';
    o.status = 'done'; o.doneAt = now(); o.updatedAt = now();
    if (note) o.notes.push({ at: now(), text: '验收：' + note });
    savePool(pool);
    if (o.window) {
      const db = loadQueue(o.window);
      const it = (db.items || []).find((i) => i.id === o.id);
      if (it) { it.status = 'done'; it.doneAt = it.doneAt || now(); saveQueue(o.window, db); }
    }
    channel({ who: '派单方', to: 'xiaoyu', kind: 'ack', ref: o.id, text: '【验收通过】' + id + ' ' + o.title + (note ? '｜' + note : '') });
    await notifyGroup('accept', o.window || '派单方', o.id, o.title + (note ? '｜' + note : ''));
    console.log('已验收：' + id);
    break;
  }

  case 'verify': {
    const pool = reconcile();
    const [id] = args;
    const o = findOrder(pool, id);
    if (!o) { console.log('没这张单：' + id); break; }
    const ev = runEvalChecks(o);
    if (!ev.results.length) { console.log('这张单没有 eval 型验收（只有 manual/cmd/file，机器不判）'); break; }
    for (let i = 0; i < ev.results.length; i++) {
      const r = ev.results[i];
      console.log('[' + (r.ok ? 'pass' : 'FAIL') + '] ' + (i + 1) + ' exit=' + r.exit);
      console.log('  ' + r.out.slice(0, 200));
    }
    console.log(ev.allOk ? '全部通过 ✓' : '有 ' + ev.results.filter((r) => !r.ok).length + ' 条没过 ✗');
    if (!ev.allOk) process.exitCode = 6;
    break;
  }

  case 'reject': {
    const pool = reconcile();
    const [id, reason] = args;
    const o = findOrder(pool, id);
    if (!o) { console.log('没这张单：' + id); break; }
    o.status = 'doing'; o.updatedAt = now();
    o.notes.push({ at: now(), text: '打回：' + (reason || '未写原因') });
    savePool(pool);
    if (o.window) {
      const db = loadQueue(o.window);
      const it = (db.items || []).find((i) => i.id === o.id);
      if (it) { it.status = 'doing'; it.doneAt = null; it.notes = it.notes || []; it.notes.push({ at: now(), text: '打回：' + (reason || '') }); saveQueue(o.window, db); }
    }
    channel({ who: '派单方', to: o.window || 'xiaoyu', kind: 'reject', ref: o.id, text: '【打回】' + id + ' ' + o.title + '｜原因：' + (reason || '未写') });
    await notifyGroup('reject', o.window || '派单方', o.id, o.title + '｜打回：' + (reason || '未写'));
    console.log('已打回：' + id);
    break;
  }

  case 'block': {
    const pool = reconcile();
    const [id, raw] = args;
    const o = findOrder(pool, id);
    if (!o) { console.log('没这张单：' + id); break; }
    o.status = 'blocked'; o.updatedAt = now();
    o.notes.push({ at: now(), text: '阻塞：' + (raw || '') });
    savePool(pool);
    channel({ who: o.window || '?', to: 'xiaoyu', kind: 'block', ref: o.id, text: '【阻塞】' + id + ' ' + o.title + '\n卡点原文：\n' + (raw || '(未提供)') });
    await notifyGroup('block', o.window || '?', o.id, o.title + '｜卡在：' + String(raw || '(未写)').slice(0, 300));
    console.log('已标阻塞：' + id);
    break;
  }

  case 'windows': {
    reconcile();
    const list = buildWindows();
    writeJsonAtomic(REGISTRY, { at: now(), windows: list });
    if (flags.has('--json')) { console.log(JSON.stringify(list, null, 2)); break; }
    console.log('接收方'.padEnd(14) + '状态'.padEnd(6) + '待办'.padEnd(6) + '未完成单'.padEnd(8) + '最近活动'.padEnd(10) + '当前/备注');
    for (const w of list) {
      const act = w.idleMin === null ? '无记录' : w.idleMin < 60 ? w.idleMin + '分钟前' : Math.round(w.idleMin / 60) + '小时前';
      console.log(
        String(w.window).padEnd(12) +
        (w.state === 'busy' ? '忙' : '空闲').padEnd(6) +
        String(w.queued).padEnd(7) +
        String(w.openWorkorders).padEnd(9) +
        act.padEnd(10) +
        (w.current ? w.current.id + ' ' + w.current.title : (w.lastNote || '—')).slice(0, 60)
      );
    }
    console.log('\n文件：' + REGISTRY);
    break;
  }

  case 'tidy': {
    const pool = reconcile();
    const apply = flags.has('--apply');
    const done = pool.orders.filter((o) => ['done', 'dropped'].includes(o.status));
    const buckets = { KEEP: [], COMPACT: [], DROP: [], STALE: [] };

    for (const o of pool.orders) {
      if (o.status === 'dropped' || o.supersededBy) { buckets.DROP.push(o); continue; }
      if (o.status !== 'done') {
        const touched = Date.parse(o.updatedAt || o.createdAt);
        const days = Math.round((Date.now() - touched) / 86400000);
        if (days >= 14 && ['queued', 'assigned', 'doing', 'blocked'].includes(o.status)) buckets.STALE.push({ o, days });
        continue;
      }
      const text = [o.deliverable || '', ...(o.evidence || []).map((e) => e.text), ...(o.notes || []).map((n) => n.text)].join('\n');
      const files = [...text.matchAll(/([A-Za-z]:[\\/][^\s"'，,、）)]+\.(?:mjs|js|md|json|ps1|py|html|csv|png|txt|log))/g)].map((m) => m[1].replace(/\\/g, '/'));
      const alive = files.filter((f) => { try { return fs.existsSync(f); } catch { return false; } });
      const external = (o.tags || []).includes('对外') || /对外|提交|发布|客户|交付/.test(o.title + (o.deliverable || ''));
      if (alive.length || external) buckets.KEEP.push(o);
      else if ((o.evidence || []).length || (o.notes || []).length >= 2) buckets.COMPACT.push(o);
      else buckets.DROP.push(o);
    }

    const month = now().slice(0, 7);
    const dir = path.join(ARCH, month);
    const lines = ['# 工单归纳报告 ' + now().slice(0, 16).replace('T', ' '), ''];
    lines.push('## 该整理（留全文，归档）— ' + buckets.KEEP.length + ' 张');
    for (const o of buckets.KEEP) lines.push('- ' + o.id + ' ' + o.title);
    lines.push('', '## 留摘要即可（一行结论，正文不留）— ' + buckets.COMPACT.length + ' 张');
    for (const o of buckets.COMPACT) lines.push('- ' + o.id + ' ' + o.title + '｜' + ((o.evidence[0] && o.evidence[0].text) || '').slice(0, 80));
    lines.push('', '## 直接丢（只留台账）— ' + buckets.DROP.length + ' 张');
    for (const o of buckets.DROP) lines.push('- ' + o.id + ' ' + o.title + '（' + o.status + '）');
    lines.push('', '## 需要人看一眼（超 14 天没动）— ' + buckets.STALE.length + ' 张');
    for (const s of buckets.STALE) lines.push('- ' + s.o.id + ' ' + s.o.title + '｜' + s.o.status + '｜' + s.days + ' 天没更新');
    const report = lines.join('\n');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '归纳报告-' + stamp() + '.md'), report, 'utf8');
    console.log(report);

    if (!apply) { console.log('\n（只看了没动。确认后加 --apply 真归档）'); break; }
    for (const o of buckets.KEEP) {
      fs.writeFileSync(path.join(dir, o.id + '.md'), renderOrder(o) + '\n\n## 证据\n\n' + o.evidence.map((e) => '- ' + e.at + ' ' + e.text).join('\n') + '\n', 'utf8');
      fs.writeFileSync(path.join(dir, o.id + '.json'), JSON.stringify(o, null, 2), 'utf8');
    }
    const oneLine = (o, why) => JSON.stringify({ id: o.id, title: o.title, status: o.status, why, doneAt: o.doneAt, window: o.window, at: now() });
    fs.appendFileSync(path.join(dir, 'summary.jsonl'), buckets.COMPACT.map((o) => oneLine(o, 'compact')).join('\n') + (buckets.COMPACT.length ? '\n' : ''), 'utf8');
    fs.appendFileSync(path.join(dir, 'pruned.jsonl'), buckets.DROP.map((o) => oneLine(o, 'drop')).join('\n') + (buckets.DROP.length ? '\n' : ''), 'utf8');
    const gone = new Set([...buckets.KEEP, ...buckets.COMPACT, ...buckets.DROP].map((o) => o.id));
    pool.orders = pool.orders.filter((o) => !gone.has(o.id));
    savePool(pool);
    console.log('\n已归档 ' + gone.size + ' 张 → ' + dir);
    break;
  }

  case 'presence': {
    const agent = opt('as', process.env.QQ_AGENT_NAME || null) || args[0];
    if (!agent) { console.log('用法：presence <自己> --state busy|idle [--task 工单id] ["在干什么"]'); process.exitCode = 1; break; }
    const state = opt('state', 'busy');
    const task = opt('task', null);
    const note = args.filter((a) => a !== agent).join(' ');
    const p = writePresence(agent, { state, task: task || (state === 'idle' ? null : undefined), note: note || undefined });
    console.log('心跳已写：' + agent + ' / ' + state + (note ? ' / ' + note : '') + '（' + p.at.slice(11, 16) + '）');
    break;
  }

  case 'who': {
    const rows = readPresence();
    if (!rows.length) { console.log('（还没有心跳。每个执行体跑一次：wo.mjs presence <名字> --state busy "在干什么"）'); break; }
    console.log('执行体'.padEnd(13) + '状态'.padEnd(6) + '心跳'.padEnd(9) + '当前');
    for (const r of rows) {
      const age = r.idleMin < 60 ? r.idleMin + '分钟前' : Math.round(r.idleMin / 60) + '小时前';
      const st = r.expired ? '掉线' : r.state === 'busy' ? '忙' : '空闲';
      console.log(String(r.agent).padEnd(11) + st.padEnd(6) + age.padEnd(9) + ((r.task ? r.task + ' ' : '') + (r.title || r.note || '')).slice(0, 56));
    }
    console.log('\n心跳超过 ' + PRES_TTL_MIN + ' 分钟判掉线；写心跳用 presence 命令。');
    break;
  }

  case 'inbox': {
    const w = opt('as', null) || args[0];
    if (!w) { console.log('用法：inbox <接收方>'); process.exitCode = 1; break; }
    const pool = reconcile();
    const mine = pool.orders.filter((o) => o.window === w && !['done', 'dropped'].includes(o.status));
    const ready = mine.filter((o) => o.status === 'assigned' && depsReady(pool, o));
    const doing = mine.filter((o) => o.status === 'doing');
    const blocked = mine.filter((o) => o.status === 'blocked');
    const review = mine.filter((o) => o.status === 'review');
    console.log(w + '：可领 ' + ready.length + '｜在做 ' + doing.length + '｜待验收 ' + review.length + '｜卡住 ' + blocked.length);
    for (const o of [...doing, ...ready].slice(0, 3)) console.log('  ' + o.id + ' P' + o.priority + ' ' + o.title);
    if (!mine.length) { console.log('（没事干，退出码 4）'); process.exitCode = 4; }
    break;
  }

  case 'reap': {
    reconcile();
    const apply = flags.has('--apply');
    const lost = [];
    withLock(() => {
      const p = loadPool();
      let touched = false;
      for (const o of p.orders) {
        if (o.status !== 'doing') continue;
        if (!o.leaseUntil) {
          const base = Date.parse(o.updatedAt || o.createdAt || now());
          o.leaseUntil = new Date(base + LEASE_MIN * 60000).toISOString();
          touched = true;
        }
        if (leaseAlive(o)) continue;
        lost.push({ id: o.id, owner: o.owner, title: o.title, leaseUntil: o.leaseUntil });
        if (apply) {
          o.status = 'assigned'; o.owner = null; o.updatedAt = now();
          o.notes.push({ at: now(), text: '租约过期（' + o.leaseUntil.slice(11, 16) + '），自动放回待领' });
          // 队列项也要放回 queued，否则下一次 reconcile 会按队列把它翻回 doing
          if (o.window) {
            const db = loadQueue(o.window);
            const it = (db.items || []).find((i) => i.id === o.id);
            if (it) { it.status = 'queued'; it.startedAt = null; saveQueue(o.window, db); }
          }
          touched = true;
        }
      }
      if (touched) savePool(p);
    });
    if (!lost.length) { console.log('（没有过期租约）'); break; }
    for (const o of lost) console.log('⏰ ' + o.id + ' 租约到期 ' + String(o.leaseUntil).slice(11, 16) + '｜' + (o.owner || '无主') + '｜' + o.title);
    console.log(apply ? '\n已放回 ' + lost.length + ' 张待领' : '\n（只是看看。确认加 --apply 才真的放回）');
    break;
  }

  case 'audit': {
    const pool = reconcile();
    const rate = Number(opt('rate', 10));
    const days = Number(opt('days', 7));
    const doReject = flags.has('--reject');
    const since = Date.now() - days * 86400000;
    const done = pool.orders.filter((o) => o.status === 'done' && Date.parse(o.doneAt || o.updatedAt || 0) >= since);
    if (!done.length) { console.log('近 ' + days + ' 天没有已完成单可抽检'); break; }
    const sample = done.filter((o) => (parseInt(fingerprint(o.id + o.title).slice(0, 4), 16) % 100) < rate);
    if (!sample.length) { console.log('按 ' + rate + '% 抽，这次没抽到（共 ' + done.length + ' 张已完成）'); break; }

    const bad = [];
    for (const o of sample) {
      const why = [];
      for (const a of o.acceptance || []) {
        if (a.check === 'file') {
          if (!a.path) { why.push('验收缺 path'); continue; }
          if (!fs.existsSync(a.path)) { why.push('文件不存在：' + a.path); continue; }
          const want = String(a.expect || '').trim();
          if (want && !/存在|有|能|不/.test(want)) {
            try { if (!fs.readFileSync(a.path, 'utf8').includes(want)) why.push('文件里找不到「' + want + '」：' + a.path); } catch { }
          }
        } else if (a.check === 'cmd') {
          why.push('命令类验收需人工跑：' + clipStr(a.cmd, 60));
        } else if (a.check === 'manual') {
          if (!(o.evidence || []).length) why.push('人工验收但没有任何证据');
        }
      }
      const evText = (o.evidence || []).map((e) => e.text).join('\n');
      const paths = [...evText.matchAll(/([A-Za-z]:[\\/][^\s"'，,、）)]+\.(?:mjs|js|md|json|ps1|py|html|csv|png|txt|log))/g)].map((m) => m[1].replace(/\\/g, '/'));
      for (const p of paths) if (!fs.existsSync(p)) why.push('证据里引用的文件已不在：' + p);
      const hard = why.filter((w) => !w.startsWith('命令类验收需人工跑'));
      console.log((hard.length ? '⚠ ' : '✅ ') + o.id + '  ' + o.title + (o.acceptedBy ? '（' + o.acceptedBy + ' 验收）' : ''));
      for (const w of why) console.log('     - ' + w);
      if (hard.length) bad.push({ o, why: hard });
    }
    console.log('\n抽检 ' + sample.length + ' / ' + done.length + ' 张，存疑 ' + bad.length + ' 张');
    if (bad.length && doReject) {
      for (const b of bad) {
        b.o.status = 'doing'; b.o.updatedAt = now();
        b.o.notes.push({ at: now(), text: '抽检打回：' + b.why.join('；') });
        if (b.o.window) {
          const db = loadQueue(b.o.window);
          const it = (db.items || []).find((i) => i.id === b.o.id);
          if (it) { it.status = 'doing'; it.doneAt = null; saveQueue(b.o.window, db); }
        }
        channel({ who: '派单方', to: b.o.window || 'xiaoyu', kind: 'reject', ref: b.o.id, text: '【抽检打回】' + b.o.id + '｜' + b.why.join('；') });
      }
      savePool(pool);
      for (const b of bad) await notifyGroup('reject', b.o.window || '派单方', b.o.id, '抽检打回：' + b.why.join('；').slice(0, 300));
      console.log('已打回 ' + bad.length + ' 张（接收方队列同步回 doing）');
    } else if (bad.length) {
      console.log('（只看没动。确认加 --reject 打回）');
    }
    break;
  }

  case 'stats': {
    const pool = reconcile();
    const by = {};
    for (const o of pool.orders) by[o.status] = (by[o.status] || 0) + 1;
    console.log('工单总数：' + pool.orders.length);
    for (const s of STATUSES) if (by[s]) console.log('  ' + s.padEnd(9) + by[s]);
    const ws = buildWindows();
    console.log('\n接收方：' + ws.map((w) => w.window + '(' + (w.state === 'busy' ? '忙' : '空闲') + ',' + w.queued + '待办)').join('  '));
    break;
  }

  default:
    console.log(`派单层工单库
  new -f <spec.json>            建单
  list [--status x] [--window w] 列单
  show <id>                     看全文
  check [id]                    校验
  handoff <id...>               派给派单方
  ready                         可分配
  assign <id> <接收方>             派单方分配
  take <接收方>                    接收方自取（谁闲谁拿，不等派）
  pull <接收方> [id]               接收方领单
  report <id> "<进度>"           上报
  submit <id> "<证据>"           交验收
  accept <id> ["结论"]           验收通过
  reject <id> "<原因>"           打回
  block <id> "<卡点原文>"         标阻塞
  windows [--json]              接收方上下文
  presence <自己> [--state busy|idle] [--task id] "在干什么"   写心跳
  who                           看谁在忙、心跳多久前、在做什么
  inbox <接收方>                   轻量轮询：有没有活（没事干退出码 4）
  reap [--apply]                过期租约放回待领
  audit [--rate 10] [--reject]  抽检已完成单的证据
  tidy [--apply]                归纳
  stats                         汇总`);
}
