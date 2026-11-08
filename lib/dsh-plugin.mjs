/**
 * dsh-workflow-kit — Host half (Cordis plugin).
 *
 * 把套件的 CLI 能力挂进宿主，注册 6 个工具：
 *   workflow_list / workflow_take / workflow_report /
 *   workflow_submit / workflow_accept / workflow_block
 *
 * 设计原则：插件只做「转发」，不重写业务逻辑——真正的状态机在 bin/wo.mjs 里，
 * 插件调用它并回传 stdout。这样 CLI 用法和插件用法永远一致，不会两套实现。
 *
 * @module dsh-workflow-kit
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Loader diagnostics name. */
export const name = 'dsh-workflow-kit';

// defineTool 由宿主提供（peerDependency）；本地单测时退化为恒等函数，
// 这样没有 DSH 运行时也能验证注册与执行逻辑。
let defineTool;
try {
  ({ defineTool } = await import('@deepseek-ai/dsh-tools'));
} catch {
  defineTool = (tool) => tool;
}

const here = dirname(fileURLToPath(import.meta.url));
const kitRoot = join(here, '..');
const woCli = join(kitRoot, 'bin', 'wo.mjs');

function runWo(args, cwd = kitRoot) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [woCli, ...args], { cwd, env: process.env });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => resolve({ code: -1, out, err: String(e && e.message) }));
    child.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  });
}

function textTool(toolName, description, parameters, buildArgs) {
  return defineTool({
    name: toolName,
    description,
    parameters,
    output: {
      schema: { type: 'string' },
      render: (_a, v) => [{ type: 'text', text: String(v) }],
    },
    async execute(args) {
      const r = await runWo(buildArgs(args || {}));
      if (r.code !== 0 && r.err) return `${r.out}\n[exit ${r.code}] ${r.err}`.trim();
      return r.out || `(无输出，exit ${r.code})`;
    },
  });
}

const str = (description, required = true) => ({ type: 'string', required, description });

export function apply(ctx) {
  if (!existsSync(woCli)) {
    ctx.logger?.warn?.(`[dsh-workflow-kit] 找不到 ${woCli}，工具未注册`);
    return;
  }

  ctx.tools.register(textTool(
    'workflow_list',
    '列出工作流套件里的工单（可按接收方过滤）。',
    { receiver: str('接收方名，如 alice；留空列全部', false) },
    (a) => (a.receiver ? ['list', '--receiver', a.receiver] : ['list']),
  ));

  ctx.tools.register(textTool(
    'workflow_take',
    '接收方自取一张工单（依赖未完成会被拒绝）。',
    { receiver: str('接收方名') },
    (a) => ['take', a.receiver],
  ));

  ctx.tools.register(textTool(
    'workflow_report',
    '给工单报进度。',
    { id: str('工单号，如 WO-20261104-0001'), note: str('进度说明') },
    (a) => ['report', a.id, a.note],
  ));

  ctx.tools.register(textTool(
    'workflow_submit',
    '交验收，证据必须带命令/输出/退出码等可复跑信息。',
    { id: str('工单号'), evidence: str('证据原文') },
    (a) => ['submit', a.id, a.evidence],
  ));

  ctx.tools.register(textTool(
    'workflow_accept',
    '验收通过一张已交验收的工单。',
    { id: str('工单号') },
    (a) => ['accept', a.id],
  ));

  ctx.tools.register(textTool(
    'workflow_block',
    '把工单标为卡住，必须写卡点原文。',
    { id: str('工单号'), reason: str('卡点原文（报错/缺什么）') },
    (a) => ['block', a.id, a.reason],
  ));
}
