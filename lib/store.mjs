// 工作区存储：信箱、任务、工单、频道。全部是普通文件，换机器/换会话都能接着用。
import { readdirSync, readFileSync, writeFileSync, appendFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const readJsonl = (p) => {
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
};

const appendJsonl = (p, obj) => appendFileSync(p, JSON.stringify(obj) + '\n', 'utf8');

export function createStore(cfg) {
  const channel = (kind, who, text, extra = {}) =>
    appendJsonl(cfg.channelPath, { at: new Date().toISOString(), who, kind, text, ...extra });

  // ---------- 信箱 ----------
  function listMailbox(window) {
    const dir = join(cfg.mailboxDir, window);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  }

  function takeMailbox(window) {
    const files = listMailbox(window);
    if (!files.length) return null;
    const name = files[0];
    const src = join(cfg.mailboxDir, window, name);
    const doneDir = join(cfg.mailboxDir, window, '_done');
    mkdirSync(doneDir, { recursive: true });
    const body = readFileSync(src, 'utf8');
    renameSync(src, join(doneDir, name));
    return { name, body };
  }

  // ---------- 任务（接收方队列） ----------
  const taskPath = (w) => join(cfg.receiversDir, `${w}.json`);

  function readTasks(window) {
    const p = taskPath(window);
    if (!existsSync(p)) return { window, items: [] };
    return JSON.parse(readFileSync(p, 'utf8'));
  }

  function writeTasks(window, data) {
    writeFileSync(taskPath(window), JSON.stringify(data, null, 2), 'utf8');
  }

  function addTask(window, { id, title, priority = 'P2', notes = '' }) {
    const data = readTasks(window);
    data.items.push({ id, title, priority, status: 'queued', notes, createdAt: new Date().toISOString() });
    writeTasks(window, data);
    return data.items.at(-1);
  }

  function updateTask(window, id, patch) {
    const data = readTasks(window);
    const t = data.items.find((x) => x.id === id);
    if (!t) throw new Error(`任务不存在：${id}`);
    Object.assign(t, patch, { updatedAt: new Date().toISOString() });
    writeTasks(window, data);
    return t;
  }

  // ---------- 工单 ----------
  const woPath = () => join(cfg.tasksDir, 'workorders.jsonl');

  const listWorkOrders = () => readJsonl(woPath());

  function addWorkOrder({ id, title, priority = 'P2', window = '', dependsOn = [] }) {
    appendJsonl(woPath(), { id, title, priority, window, dependsOn, status: 'queued', createdAt: new Date().toISOString() });
    return id;
  }

  // 只取：分给本接收方的、或无接收方归属的；且依赖都已 done
  function takeWorkOrder(window) {
    const all = listWorkOrders();
    const doneIds = new Set(all.filter((w) => w.status === 'done').map((w) => w.id));
    const mineDoing = all.find((w) => w.status === 'doing' && w.owner === window);
    if (mineDoing) throw new Error(`本接收方已有在做工单：${mineDoing.id}（先 submit/block）`);
    const ready = all.filter((w) => w.status === 'queued'
      && (!w.window || w.window === window)
      && (w.dependsOn || []).every((d) => doneIds.has(d)));
    if (!ready.length) return null;
    const pick = ready[0];
    const idx = all.findIndex((w) => w.id === pick.id);
    all[idx] = { ...pick, status: 'doing', owner: window, startedAt: new Date().toISOString() };
    writeFileSync(woPath(), all.map((w) => JSON.stringify(w)).join('\n') + '\n', 'utf8');
    return all[idx];
  }

  function updateWorkOrder(id, patch) {
    const all = listWorkOrders();
    const idx = all.findIndex((w) => w.id === id);
    if (idx < 0) throw new Error(`工单不存在：${id}`);
    all[idx] = { ...all[idx], ...patch, updatedAt: new Date().toISOString() };
    writeFileSync(woPath(), all.map((w) => JSON.stringify(w)).join('\n') + '\n', 'utf8');
    return all[idx];
  }

  return { channel, listMailbox, takeMailbox, readTasks, addTask, updateTask,
    listWorkOrders, addWorkOrder, takeWorkOrder, updateWorkOrder };
}
