// 插件冒烟测试：不用 DSH 运行时，用假 ctx 验证「注册几个工具 + 工具真的能跑」。
// 用法：node scripts/test-plugin.mjs
import { apply, name } from '../lib/dsh-plugin.mjs';

const registered = [];
const ctx = { tools: { register: (t) => registered.push(t) }, logger: { warn: (m) => console.log('[warn]', m) } };

apply(ctx);

console.log(`插件名：${name}`);
console.log(`注册工具数：${registered.length}`);
for (const t of registered) console.log(`  - ${t.name}: ${t.description}`);

if (registered.length !== 6) {
  console.error(`期望 6 个工具，实际 ${registered.length}`);
  process.exit(1);
}

// 真跑一个：workflow_list（只读，不改数据）
const list = registered.find((t) => t.name === 'workflow_list');
const out = await list.execute({});
const ok = typeof out === 'string' && out.length > 0;
console.log(`\nworkflow_list 输出前 200 字：\n${String(out).slice(0, 200)}`);
if (!ok) {
  console.error('workflow_list 无输出');
  process.exit(1);
}
console.log('\n✅ 插件冒烟通过');
