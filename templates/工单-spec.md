# 工单 spec（喂给 `wo.mjs new -f`）

`wo.mjs new -f spec.json` 吃的是 **JSON**，不是 Markdown。格式：

```json
{
  "orders": [
    {
      "title": "一句话说清这单干什么",
      "why": "为什么做／不做会怎样（一句话）",
      "acceptance": [
        "验收项1：可验证的描述",
        "验收项2：要贴什么证据"
      ],
      "deps": ["WO-20261104-0001"],
      "window_hint": "alice",
      "priority": 2,
      "deliverable": "产物路径或文件名",
      "scope": ["允许改的目录前缀"],
      "tags": []
    }
  ]
}
```

## 字段说明

| 字段 | 必填 | 说明 |
|---|---|---|
| `title` | ✅ | 一句话，别写「优化一下」这种 |
| `acceptance` | ✅ | **数组**，每条要能贴证据；`check` 会报「没有验收标准」 |
| `why` | 建议 | 为什么做，方便别人接手时不问 |
| `deps` | 可选 | 依赖的工单 id 数组；依赖没 `done` 前 `take` 不会放行 |
| `window_hint` | 可选 | 建议接收方（只是建议，谁闲谁拿） |
| `priority` | 可选 | 数字 1/2/3，默认 2 |
| `deliverable` | 可选 | 产物落在哪 |
| `scope` | 可选 | 允许改的路径前缀，防冲突 |
| `tags` | 可选 | 含 `不可逆` 或标题/why 命中红线词时，会标 `needsYone` |

## 建单 → 领单 → 交单

```bash
node bin/wo.mjs new -f spec.json          # 建单（默认 draft）
node bin/wo.mjs check WO-20261104-0001    # 校验（验收标准/依赖）
node bin/wo.mjs ready                     # 看哪些可分配
node bin/wo.mjs assign WO-20261104-0001 alice
node bin/wo.mjs take alice                   # 接收方自取
node bin/wo.mjs report WO-20261104-0001 "进度"
node bin/wo.mjs submit WO-20261104-0001 "证据：路径/输出原文"
```

## 写单三条规矩

1. **每条验收都要能贴证据**——「做完了」不算
2. **依赖写清楚**——否则别人重复做或卡住
3. **红线写进单里**——花钱/删除/对外提交的，让 `needsYone` 自动标出来
