// 配置加载与校验。所有路径在这里解析成绝对路径，其他模块只拿结果。
// 「接收方」(receiver) 是使用者自己起的名字：一台机器、一个机器人、一个人、一个目录都行。
// 兼容旧字段 windows / maxDoingPerWindow。
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULTS = {
  workspace: '~/dsh-workspace',
  receivers: [],
  channelFile: 'data/channel.jsonl',
  checkMinutes: 20,
  progressMinutes: 10,
  maxDoingPerReceiver: 3,
  redlines: ['不花钱', '不删除', '不对外提交', '不改生产', '不承诺'],
};

export function expandHome(p) {
  if (!p) return p;
  if (p.startsWith('~')) return join(homedir(), p.slice(1).replace(/^[\\/]/, ''));
  return p;
}

export function loadConfig(kitDir = process.cwd()) {
  const file = join(kitDir, 'config.json');
  if (!existsSync(file)) {
    throw new Error(`找不到 config.json（先从 config.example.json 复制一份）：${file}`);
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`config.json 不是合法 JSON：${e.message}`);
  }

  // 兼容：receivers 是正名，windows 是旧名
  const receivers = raw.receivers || raw.windows || [];
  const cfg = {
    ...DEFAULTS,
    ...raw,
    receivers,
    windows: receivers,
    maxDoingPerReceiver: raw.maxDoingPerReceiver ?? raw.maxDoingPerWindow ?? DEFAULTS.maxDoingPerReceiver,
    checkMinutes: raw.checkMinutes ?? raw.mailboxCheckMinutes ?? DEFAULTS.checkMinutes,
  };

  if (!Array.isArray(cfg.receivers)) throw new Error('config.receivers 必须是数组');
  if (!cfg.receivers.length) {
    throw new Error('config.receivers 为空：至少写一个接收方名（随便起，比如 alice / worker-a / 我的机器人）');
  }

  const workspace = resolve(expandHome(cfg.workspace));
  return {
    ...cfg,
    kitDir,
    workspace,
    channelPath: resolve(workspace, cfg.channelFile),
    tasksDir: join(workspace, 'tasks'),
    receiversDir: join(workspace, 'tasks', 'receivers'),
    windowsDir: join(workspace, 'tasks', 'receivers'),
    mailboxDir: join(workspace, 'tasks', 'mailbox'),
    dispatchPath: join(workspace, 'tasks', 'dispatch.jsonl'),
    failuresPath: join(workspace, 'tasks', 'failures.jsonl'),
  };
}
