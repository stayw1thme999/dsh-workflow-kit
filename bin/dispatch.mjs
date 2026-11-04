#!/usr/bin/env node
// 接收方任务分配器：把任务分到不同的 DSH 接收方（alice / bob / carol …）
// 用法：
//   node dispatch.mjs windows                     列出所有接收方
//   node dispatch.mjs add <接收方> "<标题>" ["详细说明"] [优先级1-3]
//   node dispatch.mjs pull <接收方>                 取这个接收方的下一条任务（标记为 doing）
//   node dispatch.mjs done <任务id> ["备注"]       标记完成
//   node dispatch.mjs list [接收方]                 看队列
//   node dispatch.mjs status                      各接收方概览
//   node dispatch.mjs new <接收方>                  新建一个接收方队列
import fs from 'node:fs';
import { installFailHook, reportFailure } from '../lib/fail-hook.mjs';
import { quarantineBadQueueFile } from '../lib/quarantine.mjs';
installFailHook('alice', '接收方派工');
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const DATA = process.env.DSH_WORKFLOW_DATA || path.join(process.cwd(), 'data');
const DIR = path.join(DATA, 'tasks', 'windows');
fs.mkdirSync(DIR, { recursive: true });

// 完成笔记：每次 done 自动落一条（保留 7 天，clean-done-notes.mjs 每天清）
const NOTES_DIR = 'E:/qqagent-tools/work';
function doneLog(w, id, title, note) {
  try {
    const d = new Date();
    const ymd = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const hhmm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    fs.appendFileSync(NOTES_DIR + '/完成笔记-' + ymd + '.md', '- [' + w + '] ' + hhmm + ' ' + id + ' ' + String(title).slice(0, 60) + ' — ' + String(note || '[无详情]').slice(0, 120) + ' · source: wo:' + id + '\n', 'utf8');
  } catch { /* 笔记写失败不阻断完成任务 */ }
}

const DEFAULT_WINDOWS = ['alice', 'bob', 'carol'];
const fileOf = (w) => path.join(DIR, encodeURIComponent(String(w).trim()) + '.json');
const now = () => new Date().toISOString();


const CTRLDIR = path.join(DATA, 'harness-control');
const NOTESFILE = path.join(CTRLDIR, 'dsh-notes.jsonl');
function sayGroup(text, kind, ref) {
  try {
    // 通用化：config.qqNotify=false 时改写本地频道，不调 QQ 群脚本
    const cfg = JSON.parse(fs.readFileSync('E:/qqagent-tools/work/config.json', 'utf8'));
    if (cfg.qqNotify === false) {
      fs.appendFileSync(cfg.channel || path.join(DATA, 'channel.jsonl'), JSON.stringify({ at: now(), who: 'alice', kind, ref, text }) + '\n', 'utf8');
      return;
    }
  } catch { /* 读不到 config 就走原路 */ }
  try {
    const args = ['E:/qqagent-tools/work/派单方/group.mjs', 'say', text, '--as', 'alice', '--kind', kind];
    if (ref) args.push('--ref', ref);
    execFileSync(process.execPath, args, { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  } catch (e) {
    try { noteTo('群通知失败：' + (e?.message ?? e), false); } catch { /* 群通知失败且留言也失败时放弃 */ }
  }
}

function noteTo(text, urgent) {
  try {
    fs.mkdirSync(CTRLDIR, { recursive: true });
    fs.appendFileSync(NOTESFILE, JSON.stringify({ at: now(), text, urgent: !!urgent, delivered: false }) + '\n', 'utf8');
  } catch (e) { reportFailure('alice', '写上下文留言失败', e.stack || String(e), 'E:/qqagent-tools/work/dispatch.mjs:32'); }
}
function load(w) {
  try {
    return JSON.parse(fs.readFileSync(fileOf(w), 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) { reportFailure('alice', '读接收方队列失败（已隔离该文件）：' + w, e.stack || String(e), 'E:/qqagent-tools/work/dispatch.mjs:37'); quarantineBadQueueFile(fileOf(w), e, reportFailure, 'alice'); return { window: w, createdAt: now(), items: [] }; }
}
function save(w, db) { fs.writeFileSync(fileOf(w), JSON.stringify(db, null, 2), 'utf8'); }

function allWindows() {
  const set = new Set(DEFAULT_WINDOWS);
  for (const f of fs.readdirSync(DIR)) {
    if (f.endsWith('.json')) set.add(decodeURIComponent(f.replace('.json', '')));
  }
  return [...set];
}

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case 'windows': {
    for (const w of allWindows()) {
      const db = load(w);
      const open = db.items.filter((i) => i.status !== 'done').length;
      console.log(`${w}  (未完成 ${open} / 共 ${db.items.length})`);
    }
    break;
  }
  case 'new': {
    const w = rest[0];
    if (!w) { console.log('用法：new <接收方名>'); break; }
    const db = load(w);
    save(w, db);
    console.log('接收方已建：' + w);
    break;
  }
  case 'add': {
    const w = rest[0];
    const title = rest[1];
    const body = rest[2] || '';
    const prio = Number(rest[3] || 2);
    if (!w || !title) { console.log('用法：add <接收方> "<标题>" ["说明"] [优先级]'); break; }
    const db = load(w);
    const item = {
      id: crypto.randomBytes(4).toString('hex'),
      title, body, priority: prio,
      status: 'queued', createdAt: now(), startedAt: null, doneAt: null, notes: [],
      source: 'dsh 派工',
    };
    db.items.push(item);
    save(w, db);
    console.log(`已加入「${w}」：${item.id}  ${title}`);
    break;
  }
  case 'pull': {
    const w = rest[0];
    if (!w) { console.log('用法：pull <接收方>'); break; }
    const db = load(w);
    const doing = db.items.find((i) => i.status === 'doing');
    const next = doing || db.items.filter((i) => i.status === 'queued')
      .sort((a, b) => (a.priority - b.priority) || (String(a.createdAt).localeCompare(String(b.createdAt))))[0];
    if (!next) { console.log(`「${w}」队列空了`); break; }
    if (next.status === 'queued') {
      next.status = 'doing';
      next.startedAt = now();
      save(w, db);
    }
    console.log(`【${w}】${next.id}  ${next.title}`);
    if (next.body) console.log('说明：' + next.body);
    console.log('状态：' + next.status + (doing ? '（这是之前就在做的）' : ''));
    break;
  }
  case 'reply': {
    // 派单方把 负责人 的决定回填给某个工作区（不需要授权票）
    const w = rest[0], id = rest[1], decision = rest[2], note = rest[3] || '';
    if (!w || !id || !decision) { console.log('用法：reply <接收方> <任务id> "<继续/方案A/方案B>" ["备注"]'); break; }
    const db = load(w);
    const item = db.items.find((i) => i.id === id);
    if (!item) { console.log('没找到任务：' + id); break; }
    item.reply = { at: now(), by: 'xiaoyu', decision, note };
    item.notes = item.notes || [];
    item.notes.push({ at: now(), text: '派单方转达 负责人：' + decision + (note ? '｜' + note : '') });
    if (item.status === 'done') item.status = 'queued';   // 重新激活
    save(w, db);
    // 如果正好是为这件事挂起的决策，一并解除
    try {
      const pd = path.join(CTRLDIR, 'pending-decision.json');
      const d = JSON.parse(fs.readFileSync(pd, 'utf8').replace(/^\uFEFF/, ''));
      if (d && d.active && String(d.question || '').includes(item.title)) {
        d.active = false; d.answer = decision; d.answeredAt = now();
        fs.writeFileSync(pd, JSON.stringify(d, null, 2), 'utf8');
        console.log('已解除对应的挂起决策');
      }
    } catch { }
    noteTo('[' + w + '] 已按 负责人 的决定回填：' + item.title + ' → ' + decision, false);
    console.log('已回填「' + w + '」' + id + '：' + decision);
    break;
  }  case 'autopull': {
    // 接收方自己领：没有进行中的，就领队首；并写一份 next.md 给接收方里的 agent 看
    const w = rest[0];
    if (!w) { console.log('用法：autopull <接收方>'); break; }
    const db = load(w);
    const doing = db.items.find((i) => i.status === 'doing');
    let item = doing;
    if (!item) {
      item = db.items.filter((i) => i.status === 'queued')
        .sort((a, b) => (a.priority - b.priority) || String(a.createdAt).localeCompare(String(b.createdAt)))[0];
      if (!item) {
        fs.writeFileSync(path.join(DIR, w + '-next.md'), '# 队列空了\n\n没有待办任务。\n', 'utf8');
        console.log(w + ' 队列空了'); break;
      }
      item.status = 'doing';
      item.startedAt = now();
      save(w, db);
      noteTo('[' + w + '] 自动领到任务：' + item.title, false);
    }
    const md = [
      '# ' + w + '｜当前该做的任务', '',
      '- 任务 id：' + item.id,
      '- 标题：' + item.title,
      '- 优先级：P' + item.priority,
      '- 状态：' + item.status,
      '', '## 说明', '', (item.body || '(无)').slice(0, 1500),
      '', '## 做完怎么收尾', '',
      '`', 'node dispatch.mjs done ' + item.id + ' "一句话结果"', '`',
      '', '## 队列里还有', '',
      ...db.items.filter((i) => i.status === 'queued').slice(0, 5).map((i) => '- [ ] P' + i.priority + ' ' + i.title),
    ].join(String.fromCharCode(10));
    fs.writeFileSync(path.join(DIR, w + '-next.md'), md, 'utf8');
    console.log(w + ' 领到：' + item.id + ' ' + item.title);
    break;
  }  case 'block': {
    const id = rest[0];
    const why = rest[1] || '(没写卡点原文)';
    if (!id) { console.log('用法：block <任务id> "<卡点原文>"'); break; }
    let hit = false;
    for (const w of allWindows()) {
      const db = load(w);
      const it = (db.items || []).find((x) => x.id === id);
      if (!it) continue;
      it.status = 'blocked';
      it.notes = [...(it.notes || []), { at: now(), text: '卡住：' + why }];
      save(w, db);
      noteTo('[' + w + '] 卡住：' + it.title + '｜' + why, true);
      sayGroup('卡住：' + it.title.slice(0, 50) + '｜' + String(why).slice(0, 60), 'block', id);
      console.log('已标 blocked「' + w + '」' + id);
      hit = true;
      break;
    }
    if (!hit) console.log('没找到 ' + id);
    break;
  }
  case 'done': {
    const id = rest[0];
    const note = rest[1] || '';
    if (!id) { console.log('用法：done <任务id> ["备注"]'); break; }
    let hit = false;
    for (const w of allWindows()) {
      const db = load(w);
      const item = db.items.find((i) => i.id === id);
      if (item) {
        item.status = 'done';
        item.doneAt = now();
        if (note) item.notes.push({ at: now(), text: note });
        save(w, db);
        doneLog(w, id, item.title, note);
        console.log(`已完成「${w}」：${id} ${item.title}`);
        sayGroup('完成：' + String(item.title).slice(0, 60) + (note ? '｜' + String(note).slice(0, 40) : ''), 'done', id);
        hit = true;
        break;
      }
    }
    if (!hit) console.log('没找到这个任务 id：' + id);
    break;
  }
  case 'list': {
    const ws = rest[0] ? [rest[0]] : allWindows();
    for (const w of ws) {
      const db = load(w);
      console.log(`\n=== ${w}（${db.items.length} 条）===`);
      for (const i of db.items) {
        const mark = i.status === 'done' ? '✅' : i.status === 'doing' ? '🔄' : '⏳';
        console.log(`  ${mark} ${i.id}  P${i.priority}  ${i.title}${i.doneAt ? '  (' + i.doneAt.slice(5, 16).replace('T', ' ') + ')' : ''}`);
      }
    }
    break;
  }
  case 'status': {
    let total = 0, done = 0, doing = 0, queued = 0;
    for (const w of allWindows()) {
      const db = load(w);
      const d = db.items.filter((i) => i.status === 'done').length;
      const g = db.items.filter((i) => i.status === 'doing').length;
      const q = db.items.filter((i) => i.status === 'queued').length;
      total += db.items.length; done += d; doing += g; queued += q;
      if (db.items.length) console.log(`${w}: 待办 ${q}｜进行中 ${g}｜完成 ${d}`);
    }
    console.log(`\n合计 ${total}｜待办 ${queued}｜进行中 ${doing}｜完成 ${done}`);
    break;
  }
  default:
    console.log('用法：windows | new <接收方> | add <接收方> "<标题>" ["说明"] [P] | pull <接收方> | done <id> ["备注"] | list [接收方] | status');
}
