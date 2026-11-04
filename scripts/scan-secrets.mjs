#!/usr/bin/env node
// 脱敏扫描：查 token / QQ号 / 群号 / 绝对路径 / 手机号。命中即非零退出。
// 用法：node scripts/scan-secrets.mjs [目录]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.argv[2] || '.';

const RULES = [
  { name: 'token(sk-)', re: /sk-[A-Za-z0-9]{8,}/g },
  { name: 'access_token/bearer', re: /(access_token|Bearer)\s*[:=]\s*["']?[A-Za-z0-9._-]{12,}/gi },
  { name: '群号字段', re: /(群号|group_id|groupId)\s*[:=]\s*["']?\d{5,}/gi },
  { name: 'Windows绝对路径', re: /[A-Za-z]:\\[^\s"'`]+/g },
  { name: '手机号', re: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
  { name: 'QQ号(上下文命中)', re: /(?:qq|QQ|扣扣|企鹅)[^\d\n]{0,8}([1-9]\d{4,10})(?!\d)/g },
];

// 目录黑名单：中间产物和依赖不进扫描
const SKIP_DIR = /(^|\/)(node_modules|\.git|models|build|demo_work|any|out|__pycache__)(\/|$)/;
// 行内白名单：文档里的占位符
const PLACEHOLDER = /<[^>]+>|example|\.example|示例|placeholder|xxxx|your-|你的/i;

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const rel = relative(root, p).split('\\').join('/');
    if (SKIP_DIR.test(rel)) continue;
    if (/(^|\/)config\.json$/.test(rel)) continue;
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(mjs|js|ts|json|md|yml|yaml|ps1|py|txt|sh)$/.test(name)) files.push(p);
  }
})(root);

let hits = 0;
for (const f of files) {
  const lines = readFileSync(f, 'utf8').split(/\r?\n/);
  let inAllowed = false;
  lines.forEach((line, i) => {
    // 联系方式块：<!-- contact-ok:start --> … <!-- contact-ok:end --> 之间不扫
    if (line.includes('contact-ok:start')) { inAllowed = true; return; }
    if (line.includes('contact-ok:end')) { inAllowed = false; return; }
    if (inAllowed) return;
    if (PLACEHOLDER.test(line)) return;
    if (line.includes('contact-ok')) return;
    // 命令行里的代码页数字（chcp 65001）不是 QQ 号
    if (/chcp\s+\d+/i.test(line)) return;
    for (const r of RULES) {
      r.re.lastIndex = 0;
      const m = line.match(r.re);
      if (!m) continue;
      for (const raw of m) {
        // 排除 8 位纯日期（YYYYMMDD）
        if (r.skipDate && /^(19|20)\d{6}$/.test(raw)) continue;
        hits++;
        console.log(`${relative(root, f)}:${i + 1}  [${r.name}]  ${raw.slice(0, 60)}`);
      }
    }
  });
}

console.log(`\n扫描 ${files.length} 个文件，命中 ${hits} 处`);
process.exit(hits > 0 ? 1 : 0);
