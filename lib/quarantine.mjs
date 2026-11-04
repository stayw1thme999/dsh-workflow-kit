import fs from 'node:fs';
import path from 'node:path';

// 队列坏文件隔离：解析失败的文件移出 windows，进 quarantine，并上报
const DATA = process.env.DSH_WORKFLOW_DATA || process.env.QQ_AGENT_DATA_DIR || path.join(process.cwd(), 'data');

export function quarantineBadQueueFile(filePath, error, reportFailure, windowName) {
  try {
    const qdir = path.join(DATA, 'tasks', 'quarantine');
    fs.mkdirSync(qdir, { recursive: true });
    const base = path.basename(filePath);
    const dest = path.join(qdir, new Date().toISOString().replace(/[:.]/g, '-') + '-' + base);
    fs.renameSync(filePath, dest);
    if (reportFailure) reportFailure(windowName || 'dispatch', '队列文件坏了，已移进 quarantine：' + base, (error && (error.stack || error.message)) || String(error), String(filePath));
    return dest;
  } catch {
    return null;
  }
}
