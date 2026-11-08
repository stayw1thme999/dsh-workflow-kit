# 变更日志

格式沿用 Keep a Changelog，新条目在最上面。

## [未发布]

### 新增

### 新增

- **2026-11-07 17:20｜补 cordis.patch.yml，改成可 `dsh plugin add` 的插件形态**
  - 为什么：dshbase 维护者回复（issue #250）：目录只收 cordis / dsh.bundle 形态，要求补 `cordis.patch.yml` 把 workflow_* 工具挂进宿主。
  - 改动：新增 `lib/dsh-plugin.mjs`（export name + apply(ctx)，注册 workflow_list/take/report/submit/accept/block 六个工具，内部 spawn `bin/wo.mjs` 转发，不重写状态机）、`cordis.patch.yml`（单条 insert 行）、`scripts/test-plugin.mjs`（假 ctx 冒烟）；`package.json` 补 `main`/`exports`/`dsh.bundle.patch`/peerDeps(@deepseek-ai/dsh-tools)/keywords(dsh-plugin)，版本 0.1.0→0.2.0；README 安装章改成「方式 A 插件 / 方式 B 脚本」。
  - 验证：`node --check` 两文件 exit 0；`node scripts/test-plugin.mjs` → 注册 6 个工具、workflow_list 实跑输出「（没有符合条件的工单）」、exit 0；脱敏扫描 0 命中；selfcheck 15/15。
  - 回滚：删 `lib/dsh-plugin.mjs`、`cordis.patch.yml`、`scripts/test-plugin.mjs`，package.json 回退到 0.1.0 版本。


- **2026-11-04 22:45｜拆解层审阅后的返工复验**
  - 为什么：拆解层审完 kit 做了三处修订（删 e2e 残留 `config.json`、删冗余 `compare.html`、修 README #10 指向不存在的 `patrol.mjs`），要求重跑 0039 端到端。
  - 改动：无新增代码，仅复验；确认包内不再含 `config.json`，README #10 已指 `docs/02-巡检prompt.md`。
  - 验证：干净目录 E:\kit-test → 复制 example → init（首次「已初始化」）→ 再跑 init（幂等，无报错）→ selfcheck **15/15** → 三处可移植性 `D:/大肥鱼=0 / E:\qqagent-tools=0 / postGroup=0` → new→check→assign→take→submit→accept 全通 → 频道文件 **1 个**。
  - 回滚：无改动可回滚。


- **2026-11-04 22:32｜发布前清理：去掉所有内部分工痕迹**
  - 为什么：yone 指出「给别人装的东西不能带着我们自己的窗口」——它是脚本，怎么用由使用者决定，我们只给说明书和干净的插件。
  - 改动：全仓替换内部分工词——`接收方` 取代原来的窗口概念；`派单方`（原内部协调者）、`负责人`（原 yone）、示例接收方统一为 alice/bob/carol/dave；`config.receivers` 取代 `config.windows`（旧字段仍兼容），`maxDoingPerReceiver`/`checkMinutes` 同步改名；`docs/01-窗口与派工.md` 重写为 `docs/01-任务与派单.md`（讲「接收方是使用者自己起的名字」，删掉内部分工与本机队列快照）；README 开头加一句「这是脚本+说明书，怎么用取决于你」。
  - 验证：内部名残留扫描（协调者/负责人/内部窗口名/内部项目名共 14 个关键词）→ **0 处**；`node --check` 12 个 bin 脚本全过；干净目录冒烟：init → selfcheck 15/15 → new → assign → take → submit → accept 全通；`scan-secrets` 32 文件 0 命中。
  - 回滚：`git checkout .` 回上一版。
  - 备注：`config.json` 是本地文件（.gitignore 掉），不随包发布。


- **2026-11-04 22:30｜FEATURES.md 改成一页打勾表**
  - 为什么：负责人 要求不做"谁强谁弱"的比较，只按补足关系列功能；描述要简洁，术语要白话。
  - 改动：FEATURES.md 重写为**单表 24 行**（功能/说明/superagent ✓✗/本套件 ✓✗），删除"谁强"列与 14 项/12 项分节；去掉"多接收方（接收方名一等公民）"这条——接收方分类不适用于所有人；README 第二节同步换成 12 行白话清单（到点叫醒/报错必须落盘/先查重…），去掉"一等公民""多接收方编排"等术语。
  - 验证：README/FEATURES 里 `更强|谁强|独有|一等公民|多接收方编排` 全部 0 命中；`node scripts/scan-secrets.mjs .` → 32 文件 0 命中；`node bin/selfcheck.mjs` → 15/15。
  - 回滚：还原 FEATURES.md 与 README 第二节。


- **2026-11-04 22:25｜新增 FEATURES.md：与 superagent 的全景对照**
  - 为什么：负责人 要"把我们的做法变成功能"，并把 superagent 的功能也列出来对比。
  - 改动：新增 `FEATURES.md`——①按能力域的全景对比表（触发/任务模型/准入/执行隔离/多接收方/唤醒/留证/查重/成本/消息可靠性/面板/策略版本/依赖/配额/路由/外部依赖/部署/许可，共 18 行，逐行标谁的强项）；②superagent 完整 14 项功能清单（S1-S14，含 Source/六聚合/Outbox/Effects/面板/版本/i18n/测试）；③我们 12 项新功能（N1-N12，每条写问题→功能→命令/文件）；④我们故意不重复造的 5 项。README 第二节加指针。
  - 验证：`node scripts/scan-secrets.mjs .` → 32 文件 0 命中；`node bin/selfcheck.mjs` → 15/15；包内文件 35 个。
  - 回滚：删 `FEATURES.md` 并还原 README 一句。
  - 备注：对照基于 0040 的实测（commit 8c32a9dc、MIT、docs 001-008 全文读过），未凭印象。


- **2026-11-04 22:20｜README 重写：定位为 superagent 补足版**
  - 为什么：负责人 要求"工作流描述更详细、作为 dsh-superagent 的补足版列出他们没有的功能"，并与视频插件彻底分开。
  - 改动：README 全量重写——开头明确「官方 superagent 管单仓库自主 agent，本套件管多接收方分发/留证/唤醒」；新增**补足清单 8 条**（多接收方编排、定时唤醒、失败强制留证、完成查重、成本台账、零外部依赖频道、工单依赖门、路由守门），每条标 superagent 有无 + 本套件实现文件；另列「我们没有重复造的部分」（状态机/面板/判分/Outbox 直接用它的）；docs/01、03、04 里的真实接收方名（alice/bob/carol/示例/视频插件制作）与业务示例全部泛化成 alice/bob/carol/dave。
  - 验证：`node scripts/scan-secrets.mjs .` → 31 文件 0 命中；`node bin/selfcheck.mjs` → 15/15；docs 里真实接收方名残留 **0**；包间交叉引用 0（工作流包不含 video/视频 字样）。
  - 回滚：`git checkout README.md docs/`。
  - 备注：视频插件已独立为 `dsh-video-read`（npm 名 `dsh-video-understand` 被占），两包无任何相互依赖。


- **2026-11-04 21:58｜端到端验收（0039 预演）**
  - 为什么：0039 要求「干净目录装包跑通一轮完整工作流」，先自测再交。
  - 改动：`templates/工单-spec.md` 重写为**真实 JSON schema**（`acceptance` 数组 / `deps` / `window_hint` / `priority` 数字），原来写的是 Markdown 叙述，照它建单会被 `check` 判「没有验收标准」。
  - 验证：干净临时目录 → 复制 kit → `init` → `selfcheck 15/15` → `new -f spec.json`（3 条验收）→ `check` 全部通过 → `assign alice` → `take alice` 领到 → `submit` → 状态 `review`；全程无绝对路径依赖。
  - 回滚：删 `templates/工单-spec.md` 的改动即可。
  - 备注：第一次 E2E 踩了三个坑——①`new` 的 spec 用 `acceptance` 不是 `accept`；②建出来是 `draft`，必须先 `assign`/`handoff` 才能 `take`；③kit 自己的 CHANGELOG 里残留本机绝对路径会被自家扫描器抓（已改成相对写法）。


- **2026-11-04 21:40｜合入 0037 通用化脚本**
  - 为什么：0038 要求把 WO-0037 的通用化版本填进 kit，让包在别人机器上能跑。
  - 改动：`bin/` 新增 `wo.mjs` / `dispatch.mjs` / `autotake.mjs` / `routing-guard.mjs`；`lib/` 新增 `fail-hook.mjs` / `quarantine.mjs`；四处通用化——①数据目录 `D:/大肥鱼/QQ Agent/data` → `process.env.DSH_WORKFLOW_DATA || ./data`；②`wo.mjs` 的 `execSync cwd: kit/` → `DSH_WORKFLOW_ROOT || process.cwd()`；③删除 `import postGroup` 与全部 QQ 分支，`notifyGroup/sayGroup` 只写本地 `channel.jsonl`；④import 路径 `./lib/` → `../lib/`（脚本进了 bin/）；README 增「命令速查」，selfcheck 增 4 个命令在位检查。
  - 验证：`node --check` 四脚本全 exit 0；`DSH_WORKFLOW_DATA=<tmp> node bin/wo.mjs list` 输出「（没有符合条件的工单）」exit 0；`node bin/selfcheck.mjs` → **15/15 通过**；`node scripts/scan-secrets.mjs .` → 扫描 31 文件 **0 命中**（postGroup/grep 0、绝对路径 0）。
  - 回滚：`git rm` 上述文件或删除 kit 目录。
  - 备注：规则微调——QQ 号检测改成「上下文命中」（`qq/QQ/扣扣` 后 8 字内），否则 `60000`/`86400000` 这类超时常量会被误判；首次扫描因此假阳性 21 处。


- **2026-11-04｜骨架落地**
  - 为什么：把多接收方任务流转（信箱/工单/自动接单/失败留证/巡检）做成别人能装的东西。
  - 改动：README（三步安装/架构图/配置表/FAQ）、docs 00-05、templates（工单 spec + 数据处理调用模板）、`lib/config.mjs`、`bin/init.mjs`、`bin/selfcheck.mjs`、`scripts/scan-secrets.mjs`、package.json、LICENSE、.gitignore。
  - 验证：临时工作区跑 `node bin/init.mjs` + `node bin/selfcheck.mjs` → 11/11 通过；`node scripts/scan-secrets.mjs .` → 扫描 15 文件 0 命中。
  - 回滚：删除本目录。
  - 待办：`bin/` 里的 take/list/progress/say/wo-take 等命令等 WO-20261104-0037（通用化改造）交付后填入。