# dsh-workflow-kit

> **官方 `dsh-superagent` 的补足版**——它管「一个仓库里的自主 agent」，我们管「**多个接收方之间怎么分活、怎么留证、被谁叫醒**」。
>
> 不 fork、不重写、不替代。只在它明确没有的地方补。
>
> **这是一个脚本 + 一份说明书**：装完怎么用取决于你。包里不含任何特定团队的分工，接收方的名字由你自己定（`alice`/`bob`/`财务机器人`都行）。

---

## English overview

**dsh-workflow-kit** is a companion to the official [`dsh-superagent`](https://github.com/deepseek-ai/dsh-superagent-prototype) (MIT). superagent handles *one repo, one autonomous agent*; this kit handles *how work moves between several receivers* — who gets a task, how completion is reported, how failures are recorded, who wakes a sleeping session.

- **What you get**: mailbox dispatch, work-order state machine with dependency gates, auto-take, scheduled wake-ups, failure ledger (errors must be pasted verbatim), duplicate-work check, cost ledger, local channel (zero external services).
- **What we do not redo**: superagent's Ticket/Assignment state machine, web panel, model-based gating, Outbox reliability.
- **Install**: copy the folder → `cp config.example.json config.json` → `node bin/init.mjs` → `node bin/selfcheck.mjs` → mount the 20-minute check-in reminder.
- **Requirements**: Node 18+, no network calls, no account needed.
- **Receivers are yours to name**: `alice`, `bob`, `finance-bot` — whatever fits your setup.

See [FEATURES.md](FEATURES.md) for the checkmark-by-checkmark comparison.

---

## 一、为什么需要它（先说清分工）

DSH 官方 2026-10-31 开源了 [`deepseek-ai/dsh-superagent-prototype`](https://github.com/deepseek-ai/dsh-superagent-prototype)（MIT），是个很完整的**单仓库自主 agent**：监听 GitHub/Feishu，收到请求就开 Ticket、起独立 session、开 PR、用 Web 面板展示待办。

但它有一个明确的架构假设：**一个仓库 + 一个 agent**。

真实接活/交付场景不是这样：一个人同时有 3-5 个接收方（不同项目、不同角色），活要从 A 派到 B，卡了要有人看见，没人盯的时候要能被叫醒。这些 superagent 不管，我们从零补上。

**所以两者的关系是：**

```
        ┌──────────────────────────────┐
        │  dsh-superagent（官方，MIT）  │
        │  单仓库 · Source 驱动 · 面板  │
        │  Ticket/Assignment · 判分模型 │
        └──────────────┬───────────────┘
                       │ 它没有的部分 ↓
        ┌──────────────┴───────────────┐
        │   dsh-workflow-kit（本套件）  │
        │  多接收方 · 定时唤醒 · 失败留证  │
        │  完成查重 · 成本台账 · 依赖门 │
        └──────────────────────────────┘
```

两者可以同时装：superagent 管单仓库的自主交付，本套件管跨接收方的分发与治理。

---

## 二、补足清单（superagent 没有、本套件补上）

> 完整对照表见 **[FEATURES.md](FEATURES.md)**（两列打勾，一眼看完谁有什么）。

| # | 功能 | 说明 | 文件 |
|---|---|---|---|
| 1 | **定时唤醒** | 到点叫醒睡着的会话，不用人盯 | `docs/02-巡检prompt.md` |
| 2 | **失败强制留证** | 报错必须写进 `failures.jsonl` 并贴原文，禁止静默绕过 | `lib/fail-hook.mjs`、`bin/wo.mjs block` |
| 3 | **开工前查重** | 先查最近完成记录，做过就关单，不重复劳动 | `docs/01` |
| 4 | **成本与资源台账** | 支出记账 + 进程/内存守门 | `docs/03` |
| 5 | **本地频道** | 汇报写本地 `channel.jsonl`，不依赖任何外部服务 | `lib/store.mjs`、`bin/say.mjs` |
| 6 | **工单依赖门** | 依赖没完成，不允许领 | `bin/wo.mjs take` |
| 7 | **派单路由检查** | 派错接收方时提示 | `bin/routing-guard.mjs` |
| 8 | **优先级配额** | P1 每日有上限，超了自动降 P2 | `bin/wo.mjs list` |
| 9 | **自动接单** | 没人盯时自己领活，单接收方有并发上限 | `bin/autotake.mjs` |
| 10 | **巡检速览** | 一行看全局：信箱/队列/工单/失败（速览命令组合见 `docs/02-巡检prompt.md`） | `docs/02-巡检prompt.md` |
| 11 | **阶段摘要** | 换会话前落摘要，交接不丢信息 | `docs/03` |
| 12 | **安装自检** | 装完自证环境可用（15 项） | `bin/selfcheck.mjs` |

---

## 三、它解决什么具体问题

没有这套东西时，多接收方协作会撞上四个问题：

1. **谁该干哪条** —— 靠人在群里喊，喊完忘了
2. **干完了怎么让人知道** —— 干完不说，上游一直等
3. **卡住了怎么让人看见** —— 静默失败，三天后才发现
4. **没人管的时候谁来叫醒** —— 接收方睡着，活堆着

本套件把四个问题变成**文件 + 几条命令**：

| 问题 | 机制 | 落点 |
|---|---|---|
| 谁干哪条 | 信箱投递 + 工单自取 | `tasks/mailbox/<接收方>/*.md`、`tasks/workorders/pool.json` |
| 干完怎么回写 | `dispatch done` / `wo submit` | `tasks/dispatch.jsonl`、工单 `evidence` |
| 卡住怎么留证 | `fail` 必须贴原文 | `tasks/failures.jsonl` |
| 谁叫醒 | 20 分钟巡检提醒 | DSH schedule |

**三条设计原则**：

- **状态在文件里，不在人脑里** —— 换会话/换机器都能接着干
- **失败必须贴原文** —— 绕一次等于藏一个 bug
- **只做流转，不做智能** —— 判断留给人和模型，套件只保证「不丢、不漏、不静默」

---

## 四、三步安装

### 1. 复制目录 + 配置

```bash
cp -r dsh-workflow-kit ~/dsh-workflow-kit && cd ~/dsh-workflow-kit
cp config.example.json config.json
```

改 `config.json`：

```json
{
  "workspace": "~/dsh-workspace",
  "receivers": ["alice", "bob"],
  "channelFile": "data/channel.jsonl",
  "qqNotify": false,
  "checkMinutes": 20,
  "maxDoingPerReceiver": 3,
  "redlines": ["不花钱", "不删除", "不对外提交", "不改生产", "不承诺"]
}
```

### 2. 初始化 + 自检

```bash
node bin/init.mjs        # 建目录/台账/接收方信箱（幂等）
node bin/selfcheck.mjs   # 15 项自检：配置/目录/权限/脱敏扫描/命令在位
```

`init` 会把解析出的**绝对频道路径**回写进 `config.json`，保证所有脚本写同一个 `channel.jsonl`。

### 3. 挂巡检提醒（每个接活会话挂一次）

把 `docs/02-巡检prompt.md` 里那段作为提醒内容，间隔 20 分钟。

> DSH 的提醒**跟会话走，不跟接收方名走**——换会话要重挂。

---

## 五、一轮完整流程（可复制）

```bash
# 建单（spec 是 JSON，字段见 templates/工单-spec.md）
node bin/wo.mjs new -f spec.json
node bin/wo.mjs check WO-20261104-0001      # 校验验收标准/依赖
node bin/wo.mjs assign WO-20261104-0001 alice  # 派给接收方
node bin/wo.mjs take alice                     # 接收方自取（依赖未完成会拒）
node bin/wo.mjs report WO-20261104-0001 "进度"
node bin/wo.mjs submit WO-20261104-0001 "证据：路径 + 输出原文"
node bin/wo.mjs accept WO-20261104-0001 "验收通过"
```

---

## 六、命令速查

| 命令 | 用途 |
|---|---|
| `node bin/init.mjs` | 初始化工作区（幂等） |
| `node bin/selfcheck.mjs` | 自检（配置/目录/权限/脱敏/命令） |
| `node bin/wo.mjs new -f spec.json` | 建工单 |
| `node bin/wo.mjs list [--receiver r]` | 列工单 |
| `node bin/wo.mjs take <接收方>` | 自取（自动判依赖） |
| `node bin/wo.mjs report/submit/block/accept` | 上报/交验收/报卡点/验收 |
| `node bin/dispatch.mjs list <接收方>` / `done <id>` | 接收方队列 / 结单 |
| `node bin/autotake.mjs [--dry]` | 自动接单 |
| `node bin/routing-guard.mjs` | 路由守门 |
| `node bin/take.mjs --receiver r` | 收信箱 |
| `node bin/progress.mjs --receiver r "..."` | 报进度 |
| `node bin/say.mjs "..." --receiver r --kind done` | 发频道 |
| `node scripts/scan-secrets.mjs .` | 脱敏扫描（发布前必跑） |

**数据目录**：默认 `./data`，可用 `DSH_WORKFLOW_DATA` 覆盖。
**频道**：`data/channel.jsonl`，一行一条 `{at,who,kind,text}`。

---

## 七、可配置项

| 配置 | 默认 | 说明 |
|---|---|---|
| `workspace` | `~/dsh-workspace` | 活数据根目录（不进仓库） |
| `receivers` | `[]` | 接收方名列表（名字随你起） |
| `channelFile` | `data/channel.jsonl` | 频道文件（相对 workspace） |
| `qqNotify` | `false` | 外部通知开关；false 时**零外部调用** |
| `checkMinutes` | `20` | 巡检间隔 |
| `progressMinutes` | `10` | 进度上报间隔 |
| `maxDoingPerReceiver` | `3` | 单接收方并发上限 |
| `redlines` | 五条 | 红线关键词，命中即要求人确认 |

---

## 八、常见问题

**Q1：必须多台机器吗？**
不用。单机开几个 DSH 会话即可，接收方只是会话标签；多人多机时把 `workspace` 指到共享目录。

**Q2：和 superagent 冲突吗？**
不冲突，可同时装。它管单仓库自主交付，本套件管跨接收方分发；两者都写文件，不抢同一个数据目录即可。

**Q3：工单和信箱有什么区别？**
信箱是**投递**（一封信一个文件，收完进 `_done`）；工单是**状态**（queued→doing→review→done，带验收和依赖）。小活用信箱，要验收的用工单。

**Q4：为什么失败必须贴原文？**
因为「失败了但绕过去了」是最难查的 bug。`fail-hook` 会在未捕获异常时自动落 `failures.jsonl`，`wo.mjs block` 也强制写卡点原文。

---

## 九、目录

```
bin/        命令（init/selfcheck/wo/dispatch/autotake/routing-guard/take/list/progress/say）
lib/        核心（config/store/fail-hook/quarantine）
docs/       手册 00-05
templates/  工单 spec、数据处理调用模板
scripts/    脱敏扫描
config.json 你的配置（.gitignore 掉，不入库）
```

## 十、联系 / Contact

<!-- contact-ok:start -->

**中文**：发现 bug、想加功能、或者想让我帮你改造成你自己团队的流程，都可以直接联系我。

- QQ：`1181622043`　（加好友备注「dsh-workflow-kit」）
- 邮箱：`1181622043@qq.com`

**English**: Found a bug, need a feature, or want this adapted to your team's workflow? Reach out.

- QQ: `1181622043` (add a note "dsh-workflow-kit")
- Email: `1181622043@qq.com`

<!-- contact-ok:end -->

## License

MIT
