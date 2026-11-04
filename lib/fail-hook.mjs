// 统一的失败捕获：进程崩了就贴「源文件 + 报错原文」进频道，别静默死掉
import fs from 'node:fs';
import path from 'node:path';

const DATA = process.env.DSH_WORKFLOW_DATA || process.env.QQ_AGENT_DATA_DIR || path.join(process.cwd(), 'data');
const CHAN = path.join(DATA, 'channel.jsonl');
const FAILS = path.join(DATA, 'tasks', 'failures.jsonl');
const NOTES = path.join(DATA, 'harness-control', 'dsh-notes.jsonl');

// 从异常栈里抽出「哪个文件第几行」
export function sourceOf(error, fallback) {
  const text = String(error || '');
  const re = /([A-Za-z]:[^\s():]+\.(?:mjs|js|cjs|ps1))(?::(\d+))?/;
  const m = text.match(re);
  if (m) {
    const file = m[1].split('\\').join('/');
    return m[2] ? file + ':' + m[2] : file;
  }
  return fallback || '(源文件未解析出来)';
}

function record(window, action, error, src) {
  const at = new Date().toISOString();
  const source = src || sourceOf(error, '(源文件未解析出来)');
  const rec = { at, window, action, source, error: String(error || '').slice(0, 4000) || '(没有拿到报错原文)' };
  try { fs.mkdirSync(path.dirname(FAILS), { recursive: true }); fs.appendFileSync(FAILS, JSON.stringify(rec) + '\n', 'utf8'); } catch { /* 记录失败不影响退出 */ }
  try { fs.appendFileSync(CHAN, JSON.stringify({ at, who: window, kind: 'error', source, text: '【失败】' + action + '\n源文件：' + source + '\n报错原文：\n' + rec.error }) + '\n', 'utf8'); } catch { /* 频道写失败不影响退出 */ }
  try { fs.appendFileSync(NOTES, JSON.stringify({ at, urgent: true, delivered: false, text: '[' + window + '] 失败：' + action + '｜' + source + '｜' + rec.error.split('\n')[0].slice(0, 80) }) + '\n', 'utf8'); } catch { /* 留言写失败不影响退出 */ }
  try { process.stderr.write('[失败已上报] ' + action + ' @ ' + source + ' → ' + rec.error.split('\n')[0] + '\n'); } catch { /* stderr 不可写时放弃 */ }
}

export function installFailHook(window, action) {
  process.on('uncaughtException', (e) => {
    record(window, action || 'uncaughtException', e?.stack || e?.message || String(e));
    process.exitCode = 1;
  });
  process.on('unhandledRejection', (e) => {
    record(window, action || 'unhandledRejection', e?.stack || e?.message || String(e));
    process.exitCode = 1;
  });
}

// 脚本内部某一步失败时调用（可显式传源文件:行号）
export function reportFailure(window, action, error, source) {
  record(window, action, error, source);
}
