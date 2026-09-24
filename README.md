# dsh-decision-engine

[English](README-en.md) · **简体中文**

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）用的
**通用决策层**：一个低延迟的 System-1 运行时，位于「环境」与「在环境里执行的动作」之间。
它不绑定任何具体模型 —— Laya 只是第一个 Decision Provider，不是架构本身。

支持两种工作方式：`decision_decide` 做单次决策或单步执行；`decision_run` 一次接收
**大模型制定的目标、计划与完成条件**，由小模型独立执行整段流程。执行器直接读取和操作
浏览器、电脑或外部接口，完成后返回结果供大模型验收，中途无需主 Agent 转发状态或点击下一步。
接入示例、Mermaid 流程图和 HTTP 环境协议见 [任务接管协议](docs/任务接管协议.md)。

```text
环境  →  Environment Adapter  →  Decision Request  →  Decision Engine
                                                             ↓
                                                      Decision Router
                                                             ↓
                                                     Decision Provider
                                                             ↓
环境  ←  Action Mapper  ←  Decision Result  ←────────────────┘
```

把 Laya 换成规则引擎、ONNX 分类器、RL Policy 或别的模型，只是换一次注册；
Browser / Computer / Custom / HTTP 环境适配器**一行都不用改**。

---

## 这个项目守住的边界

| 层 | 负责 | 绝不做 |
| --- | --- | --- |
| **Environment** | 观察结构化状态；执行真实动作 | 决策 |
| **Environment Adapter** | 观察 → 决策请求；决策 → 具体动作 | 知道是谁做的决策 |
| **Decision Engine** | 校验、路由、能力与超时约束、结果归一化 | 知道任何工具名或模型 |
| **Decision Provider** | 在有限候选集里作答 | 输出 tool call、凭空造动作 |
| **Action Mapper**（在适配器内） | 候选 id → `browser_click(index=17)` | 解释模型输出 |

三条不变量由**测试**保证，而不是靠约定（`tests/unit/architecture.test.ts`）：

1. `core/`、`runtime/`、`environments/`、`tools/` 永不 import 任何 provider。
   删掉 `src/providers/laya/`，它们仍然全部可编译、可运行。
2. `providers/laya/` 之外的文件不出现 Laya SDK、ONNX，或 `choice`/`score`/`noul`
   这套问句词汇。
3. 任何 Decision Provider 都不会知道工具名（`browser_click`、`computer_use_*`……）。
   Provider 只看到候选 id 和描述。

> 外部软件怎么接进来：见 [`docs/外部接入规范.md`](docs/外部接入规范.md)。
> 一句话版本 —— 非 DSH 宿主（游戏、业务系统、模拟器）用一次调用即可嵌入：
>
> ```js
> import { createDecisionLayer } from 'dsh-decision-engine/embed'
> const decisions = createDecisionLayer({ laya: { modelDir: '/path/to/bundle' } })
> decisions.environments.register(myGameAdapter)
> const outcome = await decisions.runTask({ environment: 'my-game', objective: '赢下这一局。' })
> ```
>
> 完整契约（两套角色、错误模型、HTTP 线格式、检查清单）在那个文档里。
> 捕获错误请用 `isDecisionError(error)` 或直接读 `error.code`，**不要用 `instanceof`** ——
> 本包逐入口打包，跨入口的类身份不成立。

---

## 安装

```bash
# 从固定 tag 安装（本仓库推荐的方式）
dsh plugin --profile web-candidate add github:LiuRJ99/dsh-decision-engine#v0.4.15

# 或用本地 checkout / release tarball
dsh plugin --profile web-candidate add /path/to/dsh-decision-engine

dsh --profile web-candidate --dump-config      # 先验证，再提升到正式 profile
```

包内声明了 `dsh.bundle.patch` → `cordis.patch.yml`，它插入**一行** host-plane 配置。
公共工具 `decision_decide`、`decision_run` 和 `/decision-control` skill 都由这一行注册。

`lib/` 是**提交进仓库**的：git 安装拿到的就是可运行入口，不需要构建步骤（pnpm ≥ 10
不会执行依赖的构建脚本）。`npm run build` 能从 `src/` 逐字节重建它，而且构建产物
只依赖 `@deepseek-ai/schemastery`，所以脱离 DSH 进程也能 import 测试。

### 让 Laya Provider 真正工作

`@receptron/laya` 是**可选** peer，用动态 import 加载。没装它时插件照常启动，
provider 报 `degraded`，决策返回 `provider_unavailable` —— 宿主不会启动失败。
所以「只装插件」得到的是决策层 + 环境 + 工具；要真正作答还需要模型运行时。

```bash
# 模型运行时（ONNX），装在宿主进程能解析到的位置
pnpm add @receptron/laya
```

模型本体（Laya bundle 约 1.6 GB）由 SDK 自己解析。想直接指向已有的导出目录，
二选一：

```yaml
providers:
  laya:
    modelDir: /path/to/exported/bundle   # 内含 laya.onnx、laya_config.json、tokenizer/
```

或用环境变量（provider 优先读它）：

| 变量 | 含义 |
| --- | --- |
| `LAYA_MODEL_DIR` | bundle 目录；完全跳过 SDK 的下载逻辑 |
| `LAYA_EP` | 执行后端，逗号分隔（`cpu`、`coreml`、`cuda`、`dml`、`wasm`） |
| `LAYA_THREADS` | `intraOpNumThreads` 覆盖值 |
| `LAYA_CACHE`、`LAYA_REVISION`、`LAYA_SUBFOLDER` | SDK 查找缓存 bundle 的位置 |

**建议显式配置 `modelDir`**：`@receptron/laya@0.1.1` 的新鲜度检查把「读不到远端大小」
当成 0 字节，于是每次加载都会重新下载 tokenizer.json；缓存目录不可写时直接 EPERM。
给了 `modelDir` 就完全不碰这套逻辑。

装完确认一下：

```bash
node examples/verify-real-laya.mjs --mode choice    # 加载 bundle 并报告延迟
```

---

## 使用

### 作为工具

```jsonc
// 只决策，不执行任何动作
{
  "objective": "推进当前流程",
  "state": { "step": "review", "fieldsFilled": true },
  "candidates": [
    { "id": "submit", "description": "提交表单" },
    { "id": "edit", "description": "继续编辑" },
    { "id": "wait", "description": "等待页面变化" }
  ]
}
```

```jsonc
// 观察浏览器/桌面环境，并执行一个映射出来的动作
{ "environment": "browser", "objective": "把流程推进到成功页。", "execute": true }
```

```jsonc
// 有界循环：观察 → 决策 → 映射 → 执行 → 校验，直到完成或触发停止条件
{
  "environment": "snake",
  "objective": "尽量吃到食物且不要死。",
  "execute": "loop",
  "maxSteps": 24
}
```

`state` 既可以是结构化对象，也可以是字符串 —— 文档里的最小示例就是传字符串。

### 作为 host 服务

```ts
const decision = await ctx.decisionEngine.decide({
  objective: '选择下一步',
  state,
  candidates,
})
decision.selected       // 'submit'
decision.ranking        // [{ id: 'submit', score: 0.8 }, …]
decision.confidence     // 0.84
decision.confidenceKind // 'normalized' —— 这个数字是什么尺度
decision.latencyMs      // 仅 provider 耗时
```

`ctx.decisionEngine` 还暴露 `providers`、`environments`、`runtime`、`health()`、
`telemetry()`、`run()`。

### 置信度：一个数字，必须声明尺度

不同 provider 的置信度**不可直接比较**：softmax head、分类器后验、规则引擎的 margin、
RL 的 value 估计，各自一套尺度。因此协议要求每个置信度数字都必须带 `confidenceKind`：

| kind | 含义 | 受 `confidenceThreshold` 约束？ |
| --- | --- | --- |
| `normalized` | provider 已把自身数值映射到可比较的 0..1 尺度 | **是** |
| `provider_raw` | provider 自身尺度上的原值 | 否（只上报） |
| `unavailable` | 该 provider / 该模式无法给出可比较数值 | 否（诚实的缺失，不是 0） |

缺少 kind 的置信度会在校验层被拒绝，所以 provider 无法把未标注的数字偷偷塞进阈值比较。

Laya provider 报告 `provider_raw`，这是**测量结论**而不是保守选择：在真实 bundle 上，
它的 entropy 置信度不反映决策质量（毫无信息的状态得 0.039，明确决策得 0.15），而
选项优势度这个替代指标把刻意制造的两难排在明确决策之上。见
`examples/laya-head-calibration.mjs`。将来若有校准过的 head，只需改
`providers/laya/modes.ts` 里的一个标签，全局门限就会开始对它生效。

---

## 配置

配置有三个来源，优先级从低到高：schema 默认值 → `cordis.patch.yml` 的 bundle 行 →
设置面板写入的用户层。**默认模型可在 DSH Web「设置 → 插件 → 插件配置」中调整**（见下节），
不必手改 YAML。

```yaml
decisionEngine:
  enabled: true
  defaultProvider: laya

  providers:              # provider 私有配置只在这里，绝不放到顶层
    laya:
      enabled: true
      modelDir: /path/to/bundle     # 强烈建议显式给
      device: cpu                   # cpu / coreml / cuda / dml / wasm
      threads: 0
      autoLoad: false               # 默认首次决策才加载
      idleTtlMs: 600000             # 默认空闲 10 分钟后释放
      required: false               # true = 模型不可用即视为硬失败
      strictCandidates: true        # 模型选了不在候选集里的 id 就报错
      classificationBinaryMode: choice
      scoreLevels: [...]            # 打分等级，从低到高
      timeoutMs: 30000
      maxStateChars: 20000

  runtime:
    confidenceThreshold: 0.55       # 只对 normalized 生效
    maxSteps: 10
    maxDurationMs: 120000
    noProgressLimit: 3              # 连续 N 步状态不变就停止
    repeatedDecisionLimit: 3        # 连续 N 次选同一个就停止
    observeTimeoutMs: 90000
    executeTimeoutMs: 90000
    stepDelayMs: 0
    stateFingerprintChars: 2000

  telemetryLimit: 200
```

### 第三方页面的普通 div 控件

v0.3.0 起可在 `decision_run` / `decision_decide` 的 `browser` 参数中临时开启扩展识别，
不会修改全局配置。需要 browser workspace v0.1.10（bridge v0.0.10）或更新版本：

```json
{
  "environment": "browser",
  "objective": "回答当前题目，确认页面已记录答案",
  "browser": {
    "includeNonSemantic": true,
    "candidateSelector": ".option-item",
    "maxCandidates": 12
  },
  "completion": { "path": "main", "includes": "已答 1/49" }
}
```

上例用于 `decision_run`；选择器和完成条件必须按实际页面调整，多步任务须包含必要的导航控件。
选择器在扩展内、清单截断前过滤控件及表单；没有匹配项时不会退回整页。
扩展识别有名称的可见 `onclick` / pointer 边界元素，标记为 `clickable`，
并传回原始 class 与明确的 ARIA 状态。class 只是页面线索，不自动等同于选中状态。
插件会检查扩展是否确认候选范围，旧版扩展忽略参数时停止执行。
识别动作不等于答对题；验收需确认答案记录、状态变化和业务完成，不能仅看循环结束。

### 阶段级候选范围（v0.4.0）

计划（`decision_run` 的 `plan`）里**每个阶段可以带自己的 `scope`**，进入该阶段时套用，
不需要新工具也不需要新参数。`scope` 的键由环境适配器解释：浏览器环境认
`includeNonSemantic` / `candidateSelector` / `maxCandidates`。

这条能力解决的问题是"**每件事需要多次决策**"的流程（例如答题：先选答案，再点下一题）。
把两类动作同时摆在候选里，模型就得在它们之间赌，而它会被目标里的名词牵引、随状态漂移 ——
实测同一局里同样的目标，一次点对"下一题"、下一次点了"交卷"。
**阶段级 scope 的做法是不给它错的选择**：

```json
"plan": [
  { "id": "a-q1", "objective": "选出你认为正确的选项",
    "scope": { "includeNonSemantic": true, "candidateSelector": ".option-item" },
    "completion": { "path": "main", "includes": "已答 1/49" }, "maxSteps": 3 },
  { "id": "n-q1", "objective": "进入下一题",
    "scope": { "includeNonSemantic": true, "candidateSelector": "#next-btn" },
    "completion": { "path": "main", "includes": "第 2 题" }, "maxSteps": 3 }
]
```

- 阶段的**目标**、**动作范围**、**完成判据**都由规划者给；小模型只在范围内选动作。
- 阶段推进只看判据（页面自己的标记），小模型**不能改写或跳过计划**。
- 一个计划最多 64 个阶段；更长的流程拆成多次调用，每次一份计划。
- 阶段没有 `scope` 时沿用调用级的配置；适配器没有 `withConfig` 时该字段被忽略。
- **只有一个候选的步骤不问 provider**：没得选的东西不该去问模型；本地小模型的 choice 头也答不了
  （Laya 的 TopK 需要 k=2，单类别直接报 `provider_failed`）。运行时直接执行它。

### 通过内置设置面板配置

Host 注册 `decision-engine` settings 命名空间，Web 客户端在「设置 → 插件 →
插件配置」提供「决策引擎」卡片，用下拉框选择默认 Provider。选项来自运行中
已启用的 Provider 注册表；当前内置的只有 `laya`，其他决策模型须先以独立的
Provider ID 注册。单次 `decision_decide` / `decision_run` 可用 `provider` 参数临时覆盖默认值。
模型目录、驻留策略与循环预算不占据前台；高级部署仍可通过配置文件设置，
任务预算可在调用参数里覆盖。浏览器和电脑按任务调用，并沿用宿主能力门控。

面板行为：

- **立即生效**：卡片保存的 `defaultProvider`。后续决策与执行读取新值。
- **重启后生效**：配置文件中的 `providers.*`。Laya 运行时在启动时创建。
- 面板读到的是**已保存的解析值**：schema 默认、bundle 行、用户覆盖三层合并后的结果；
  只有你真正改过的字段才会被记为「用户覆盖」。
- 已保存的 Provider ID 若尚未注册，引擎会等待对应插件注册并明确报告不可用；不会转用 Laya。
  仅关闭 Laya 时，重启后可保持引擎运行并报告无可用 Provider。

### 接入其他本地 Provider

目前随包提供的模型实现只有本地 Laya。其他模型日后可由独立 DSH 插件实现
`DecisionProvider`，在注入 `decisionEngine` 服务后调用
`ctx.decisionEngine.providers.register(provider)`；卸载时执行返回的注销函数。
Provider 插件自行管理和验证自己的设置，Engine 设置只保存 `defaultProvider`。
注册后下拉框会从运行中的注册表读取其 ID。若该 ID 已保存在设置中，注册时会自动
成为默认 Provider。嵌入式入口也可直接传 `createDecisionLayer({ providers: [provider] })`，
此时不会隐式加入 Laya；需要两者时显式传入 `laya` 配置。

循环预算有保护性默认值：单次循环最多 10 步、2 分钟；整任务 `decision_run`
默认最多 1000 步、10 分钟。它们不是所有任务的最佳值，长任务应在调用时覆盖。

配置文档落在 `$DSH_HOME/settings.yaml` 的 `decision-engine` 段（由 settings provider 管理）。

---

## 模型驻留机制

**默认是「首次使用加载，空闲 10 分钟后释放」**。具体：

| 时点 | 行为 |
| --- | --- |
| DSH 启动、插件 `apply()` | **不加载模型**。只注册 provider，会话不打开 |
| 第一次 `decision_decide` | 加载（warm cache 约 5–6 秒），随后同一进程内复用 |
| 10 分钟内的后续决策 | 复用已加载的模型 |
| 空闲 10 分钟后 | 释放权重；下次决策按需重新加载 |
| 进程退出 | 随进程释放 |

为什么默认不随启动加载：一个 ONNX 会话会一直占住模型权重（Laya bundle 约 1.6 GB），
从不做决策的部署不该付这个内存。

需要特殊部署策略时，可在配置文件里覆盖：

```yaml
providers:
  laya:
    autoLoad: true      # 随 DSH 启动加载：把首次加载成本挪到启动
    idleTtlMs: 0        # 保持常驻；默认 600000 毫秒
```

`decisionEngine.health()` 会报告 `runtimeStatus`、`idleTtlMs`、`unloads`，可以据此观察。

---

## 加一个 Provider

三步，且**不需要碰任何环境适配器**：

```ts
// 1. 实现接口
class JevDecisionProvider implements DecisionProvider {
  readonly id = 'jev'
  readonly capabilities = ['choice', 'ranking', 'score', 'classification'] as const
  async decide(request: DecisionRequest, context?: DecisionContext): Promise<DecisionResult> { … }
  async healthCheck(): Promise<ProviderHealth> { … }
}

// 2. 注册（嵌入入口传 providers，或独立插件注入 decisionEngine 后注册）
registry.register(new JevDecisionProvider(), { enabled: true })

// 3. 把默认指过去
//    defaultProvider: jev
```

`tests/integration/game-adapter.test.ts` 就是在执行这个说法：
同一个适配器、两个不同 provider、映射出的动作词表完全一致。

---

## 环境

| id | 传输方式 | 读取 | 什么情况下拒绝猜 |
| --- | --- | --- | --- |
| `browser` | 已注册的 `browser_*` 工具 | 结构化快照文本：标题、URL、带编号的交互清单、表单字段 | 纯 canvas/WebGL 页面、快照无法解析；未完成却没有动作 |
| `computer` | DSH 使用 `computer_use_*` 工具；独立 SDK 可注入 ComputerSeam | daemon 渲染的无障碍树文本与元素索引 | 只有匿名 group 的树、没有可供合并的全量捕获的 diff、没有可寻址节点 |
| custom | 环境自己的回调 | 它自己暴露的结构化状态 | 它没有结构化状态 |
| HTTP | `GET state` / `POST action` | `dsh-environment/v1` 状态、候选和最终结果 | 协议不合法、状态过期、任务实例切换 |

这些适配器读取文字或结构化数据，不请求、不读取、不分析任何截图。

### 一个完整的自定义环境

```ts
const snake = new CustomEnvironmentAdapter<SnakeState>({
  id: 'snake',
  observe: () => game.snapshot(),                        // { head, food, availableActions, … }
  candidates: state => state.availableActions.map(a => ({ id: a, description: `Move ${a}` })),
  execute: candidate => game.apply(candidate.id),
  isDone: state => state.alive === false || state.score >= 5,
})
registry.register(snake)
```

游戏侧只需要提供「结构化状态」和「动作执行」两个能力，剩下全部由适配器负责。
**本插件不为任何具体游戏做适配** —— 游戏要接入，按
[`docs/外部接入规范.md`](docs/外部接入规范.md) 实现自己的适配器。

---

## 权限边界

决策层**不拥有**浏览器/电脑权限，也无法扩大它：

- 环境动作全部经宿主的已注册工具派发（`ctx.tools.execute`），因此与模型调用走同一条
  pre-execute 策略、同一套会话能力门禁、同一个 approval 缝、同一套超时包装。
- 插件只**读取** lazy gate（`ctx.toolLazyGate.isUnlocked`）以便尽早给出准确的拒绝理由；
  它从不安装 guard、从不授予能力、也从不重新实现门禁。
- 用户没有执行 `/browser` 或 `/computer-use` 时，环境调用会被拒绝（与直接调用工具一样），
  决策层随后升级回主 Agent。

---

## 升级（Escalation）

每次拒绝都是一个带类型的理由，并返回统一形状（`status: 'needs_escalation'` + `guidance`），
所以主 Agent 每次学到的都是同一件事。词表见 `src/core/errors.ts`：

```text
provider_unknown  provider_unavailable  provider_unsupported_capability
invalid_decision  unknown_candidate     low_confidence      provider_timeout
provider_failed   insufficient_observation  environment_unsupported
environment_unknown  environment_unavailable  no_candidates  invalid_request
action_mapping_failed  action_execution_failed  no_progress  repeated_decision
budget_exhausted  aborted  needs_vision  needs_planning  high_risk_action  internal
```

没有 `while (true)`：每个循环都被 `maxSteps`、`maxDurationMs` 和调用方的 abort signal 约束。

---

## 开发

```bash
npm run typecheck     # tsc --noEmit，strict + exactOptionalPropertyTypes
npm test              # 243 个测试，node:test，无需构建
npm run build         # esbuild 入口 + tsc 声明，输出到 lib/
npm run bench         # 分层延迟表
```

### 验证脚本

```bash
# 真 ONNX provider，四种模式，延迟 + 置信度门限报告
node examples/verify-real-laya.mjs --repeat 3

# 真实无障碍树跑完整闭环（listApps → 捕获 → 适配器 → 决策请求 → Laya → 映射出的
# 元素索引动作；不点击任何东西）
node examples/verify-real-ax-loop.mjs --list
node examples/verify-real-ax-loop.mjs --app com.apple.finder

# 为什么 Laya 的置信度上报为 provider_raw 而不是 normalized
node examples/laya-head-calibration.mjs --repeat 4

# 一个游戏端到端，分别用本地启发式和真模型
node examples/demo-custom-game.mjs
node examples/demo-custom-game.mjs --provider laya

# 真桌面单步（默认只预览，--yes 才执行）
node examples/verify-real-computer.mjs --app Finder

# 每个公共入口都通过 package 的 exports map 用裸标识符解析
# （就是它抓出了坏掉的 v0.1.0）
node examples/verify-exports.mjs

# 设置面板：用真实文件后端注册命名空间，检查面板会渲染什么
node examples/verify-settings-panel.mjs

# 无 DSH 依赖的嵌入验证（外部软件接入路径）
node examples/verify-embedding.mjs
node examples/verify-embedding.mjs --laya     # 用真模型

# 决策工具经真实 ctx.tools 注册表派发
node examples/verify-host-integration.mjs

# 插件对着真实 Cordis 上下文启动（在 profile 根目录下跑）
cd "$HOME/.dsh/profiles" && node <本仓库>/examples/verify-plugin-boot.mjs

# 浏览器集成测试用的三态页面
python3 -m http.server 8099 --directory tests/fixtures
```

---

## 目录结构

```text
src/
├── core/            协议：类型、错误、校验、注册表、路由、引擎、telemetry
├── runtime/         有界运行时（观察 → 决策 → 映射 → 执行 → 校验）
├── environments/    类型、注册表、派发缝，以及 browser/、computer/、custom/
├── providers/laya/  第一个 Provider：SDK 运行时、模式翻译、配置
├── tools/           decide-logic.ts（无 host 依赖）+ decision-decide.ts（工具本体）
├── composition.ts   不依赖 host 的组合根（含配置 schema）
├── plugin.ts        Cordis 入口（派发器、注册工具、注册 skill、发布 ctx.decisionEngine）
├── gate.ts          只读的 lazy-gate 感知
└── skill.ts         /decision-control skill
docs/
└── 外部接入规范.md   外部软件接入的接口规范与样例
```

---

## 限制

- 没有视觉、没有 OCR、没有截图理解、没有 canvas CV、不从像素推断坐标。
- 纯 canvas/WebGL/video 页面、只有匿名 group 的无障碍树，都属于
  `environment_unsupported` / `insufficient_observation` —— 这是设计，不是待补的缺口。
- 复杂规划仍归主 Agent：这一层在给定候选集里做选择，不生成计划。
- 没有 `while (true)`、没有无界重试、不允许 provider 自由生成动作。
- 无障碍树解析器是按 daemon **当前**渲染格式写的；该格式是未声明契约，所以解析器按
  daemon 自己的角色词表匹配、无法识别的行如实上报而不是丢弃，
  `tests/unit/environments.test.ts` 用逐字抓取的真实捕获把它钉住。

## 许可

MIT
