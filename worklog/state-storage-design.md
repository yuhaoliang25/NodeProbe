# Persistent State Storage Design

## 1. 目的

NodeProbe 已经从一次性“抓取 Source → 筛选节点”的脚本，演化为具有长期记忆的系统。

当前长期状态包括：

- 节点历史与生命周期；
- Source 历史与信誉；
- Source Evolution；
- Discovery Memory；
- 节点健康历史与生命周期；
- IP 地理信息；
- 其他用于跨 Workflow 运行保持连续性的状态。

这些数据逐渐变大。继续全部 commit 到 NodeProbe 主仓库，会使代码仓库与运行时状态混在一起；但 GitHub Actions 的 runner 是临时环境，如果完全不持久化状态，又会让 NodeProbe 每次运行都“失忆”。

本设计的目标是：

> **代码与运行状态解耦，同时保证 NodeProbe 在每次 Workflow 运行之间保留自己的长期记忆。**

本阶段只完成架构设计与文档化，不立即进行存储迁移。

---

## 2. 核心原则

### 2.1 Git 仓库保存“如何运行”，状态存储保存“运行后记住了什么”

代码仓库负责：

- scripts/
- .github/workflows/
- 配置与 schema；
- worklog/
- 必要的静态 seed。

持久化状态负责：

- NodePool；
- Node/health history；
- Source history；
- Source evolution；
- Source reputation；
- Discovery state；
- IP geolocation cache；
- 其他跨运行不可轻易重建的信息。

二者职责不能混淆。

### 2.2 State 是 NodeProbe 的记忆，而不是代码的一部分

例如：

data/node-pool.json

不是“程序源码”，而是：

> NodeProbe 到目前为止知道哪些节点、观察过它们多久、它们处于什么生命周期。

同理：

data/discovery-state.json

表达的是：

> NodeProbe 已经探索过互联网的哪些位置。

因此这些文件即使不进入主代码仓库，也不能被视为普通临时文件。

### 2.3 可重建数据与不可重建状态分开

未来每个 data 文件都应标记为三类之一：

1. **Persistent State**
   - 丢失后会造成长期记忆断裂；
   - 必须跨 Workflow 保存。

2. **Derived / Rebuildable**
   - 可以由其他状态和当前输入重新计算；
   - 不必长期保存。

3. **Ephemeral**
   - 仅用于当前运行；
   - Workflow 结束后可以丢弃。

原则：

> 能重建的不要为了方便长期保存；不能重建的不要当临时文件。

---

## 3. 推荐目标架构

`text
                 GitHub Repository
              ┌─────────────────────┐
              │ scripts/             │
              │ .github/workflows/   │
              │ config/              │
              │ worklog/             │
              └──────────┬──────────┘
                         │ code
                         ▼
                 GitHub Actions
                         │
                 restore state
                         │
                         ▼
              ┌─────────────────────┐
              │     NodeProbe       │
              │                     │
              │ Discovery           │
              │ Fetch               │
              │ Validation          │
              │ Tracking            │
              │ Selection            │
              └──────────┬──────────┘
                         │
                    update state
                         │
                         ▼
              ┌─────────────────────┐
              │ Persistent State    │
              │                     │
              │ node-pool           │
              │ source history      │
              │ source evolution    │
              │ discovery memory    │
              │ reputation          │
              │ geo cache           │
              └──────────┬──────────┘
                         │
                    save state
                         │
                         ▼
              Generate subscriptions
`

关键点：

> Workflow 每次启动时先恢复 State，结束前再保存 State。

因此 runner 是否是临时机器，不再影响 NodeProbe 的长期记忆。

---

## 4. Persistent State 的建议分类

### 4.1 第一优先级：必须持久化

| 数据 | 原因 |
|---|---|
| data/node-pool.json | NodeProbe 自有节点资产与生命周期 |
| data/source-history.json | Source 长期质量与健康时间序列 |
| data/source-evolution.json | Source 节点集合变化历史 |
| data/discovery-state.json | Discovery 的探索进度与去重记忆 |

这些数据丢失会明显改变 NodeProbe 的行为。

### 4.2 第二优先级：视实际依赖决定

| 数据 | 当前建议 |
|---|---|
| data/ip-geolocation.json | 持久化，但可视为 cache；丢失后可重新查询 |
| data/history.json | 保存健康观测历史；由 Node lifecycle / selection 使用 |
| data/candidates.json | 通常不需要长期保存，可由 Source + NodePool 重建 |
| data/scores.json | 若完全由当前输入计算，应视为 derived |
| data/health.json | 若 reputation/history 已保存完整信息，可考虑减少重复存储 |
| data/raw-sources.json | 通常是当前运行中间产物，不宜作为核心长期状态 |

### 4.3 生成物

例如：

- subscriptions/*.yaml
- mihomo/*.yaml

这些主要是产品输出，不应该承担 NodeProbe 的历史记忆职责。

它们可以继续 commit，也可以以后改为其他发布方式；这与 State Storage 是两个独立问题。

---

## 5. 推荐的物理存储：独立 Private State Repository

长期目标推荐：

`text
Public / low-profile NodeProbe
        │
        │ GitHub Actions secret
        ▼
Private NodeProbe-State
        │
        ├── node-pool.json
        ├── source-history.json
        ├── source-evolution.json
        ├── discovery-state.json
             └── ip-geolocation.json
`

NodeProbe 主仓库只保存：

- State schema；
- state restore/save 脚本；
- Workflow；
- 必要的默认空状态。

Private State Repository 保存真正的运行状态。

这样可以同时解决：

1. 主代码仓库不断膨胀；
2. runtime state 与 source code 混杂；
3. Git history 被大量 JSON 更新污染；
4. Discovery / source relationship 等内部运行信息不必暴露在主仓库；
5. Workflow runner 每次启动仍然可以恢复长期记忆。

### 为什么不把 State 放 GitHub Actions Cache

Cache 适合依赖缓存，不适合作为 NodeProbe 的唯一数据库。

原因：

- cache 的生命周期与策略并不是业务状态语义；
- cache 可能被淘汰；
- cache 不适合作为长期、可审计的数据库；
- cache key/version 管理复杂；
- 丢失 cache 后无法保证系统行为连续。

因此：

> Cache 可以作为加速层，但不能作为 NodeProbe 长期记忆的唯一真相源。

### 为什么不把 State 全放 Artifact

Artifact 可以作为备份或调试材料，但不宜作为主数据库：

- retention 是有限的；
- 每次运行需要找到正确的历史 artifact；
- restore/save 流程复杂；
- artifact 更像“运行产物”，而不是状态存储。

---

## 6. State Repository 的最小结构

建议保持非常简单：

`text
NodeProbe-State/
├── state/
│   ├── node-pool.json
│   ├── source-history.json
│   ├── source-evolution.json
│   ├── discovery-state.json
│   ├── reputation.json
│   └── ip-geolocation.json
└── manifest.json
`

manifest.json 用于描述：

- schema version；
- state format version；
- last saved run；
- generatedAt；
- 每个 state 文件的版本/校验信息。

例如：

`json
{
  "schemaVersion": 1,
  "lastRunId": "github-actions-run-id",
  "savedAt": "2026-09-21T00:00:00Z",
  "files": {
    "node-pool.json": {
      "schemaVersion": 1
    }
  }
}
`

Manifest 不保存节点本身，只负责 State 包的元数据。

---

## 7. Restore / Save 生命周期

Workflow 未来调整为：

`text
checkout
  ↓
setup runtime
  ↓
restore persistent state
  ↓
discover
  ↓
fetch
  ↓
build
  ↓
health check
  ↓
node pool update
  ↓
source evolution update
  ↓
node/source lifecycle update
  ↓
generate subscriptions
  ↓
save persistent state
  ↓
publish generated outputs
`

### Restore

恢复 State 时：

- State Repository 不存在 → 创建空状态；
- 某个 state 文件不存在 → 使用该文件的默认空状态；
- schema version 不兼容 → 停止或执行显式 migration；
- JSON 损坏 → 不覆盖原状态，保留失败现场。

### Save

保存 State 时：

1. 所有状态更新完成；
2. schema 校验；
3. JSON 序列化；
4. 写入临时目录；
5. 校验文件可读；
6. commit/push State Repository；
7. 主 Workflow 再处理最终输出。

不要在状态尚未完成更新时反复保存。

---

## 8. 一致性与失败处理

这是比“把文件放在哪里”更重要的问题。

### 8.1 不允许半套 State

例如：

`text
node-pool = 新版本
source-history = 旧版本
discovery-state = 新版本
`

如果这些状态之间存在运行关联，就可能产生难以解释的问题。

因此建议一次 Workflow 形成一个 State Snapshot。

逻辑上：

`text
State Snapshot N
      ↓
NodeProbe Run N
      ↓
State Snapshot N+1
`

而不是分别维护互不关联的最新文件。

### 8.2 保存失败时

如果 State 保存失败：

- 不应删除旧 State；
- 不应覆盖旧 State；
- Workflow 应明确报告“State persistence failed”；
- generated subscription 是否发布，可以独立决定。

核心原则：

> 宁可保留旧记忆，也不要用不完整的新记忆覆盖它。

### 8.3 恢复失败时

如果无法恢复 State：

- 不应该默默把系统当作“第一次运行”；
- 应明确记录 state restore failed；
- 对关键 State 最好停止运行；
- 对可选 cache 可以允许降级运行。

否则会出现“数据库丢了，但程序看起来运行成功”的隐蔽错误。

---

## 9. State 与 Git history 解耦后的好处

当前：

`text
每次 Workflow
    ↓
修改大量 data/*.json
    ↓
git commit
    ↓
main history 不断膨胀
`

目标：

`text
NodeProbe code history
    ↓
只记录代码/架构变化

State history
    ↓
独立记录运行状态变化
`

这样 Git commit history 更接近：

`text
fix discovery
add node provenance
change source reputation
fix country parser
...
`

而不是：

`text
chore: refresh node candidates
chore: refresh node candidates
chore: refresh node candidates
...
`

---

## 10. State Schema 必须版本化

未来 State 结构一定会变化。

例如：

`text
v1
node.firstSeen
`

以后可能变成：

`text
v2
node.firstObservedAt
node.firstObservedSource
sourceObservations[]
`

因此每个核心 State 应有 schema version。

迁移原则：

`text
old state
   ↓
migration
   ↓
new state
`

而不是：

`text
new code
   ↓
猜测旧 JSON 的含义
`

尤其需要遵守已经确定的时间语义：

- firstObservedAt = NodeProbe 首次观察时间；
- firstObservedSource = NodeProbe 首次观察来源；
- 不得把它解释成 firstPublishedAt。

---

## 11. “真正的数据库”与 JSON 的关系

现阶段不需要因为文件变大就立即引入数据库。

NodeProbe 当前的状态特点仍然是：

- 单 Workflow 写入；
- 没有高并发事务；
- 状态规模目前仍可序列化；
- GitHub Actions 是主要运行环境。

因此第一阶段：

> **JSON State + 独立持久化仓库**

已经足够。

未来如果出现：

- 数十万/百万节点；
- 大量历史 observation；
- 需要按 node/source 查询；
- 需要复杂时间窗口统计；
- 单次运行 JSON 解析明显成为瓶颈；

再考虑：

`text
SQLite
PostgreSQL
DuckDB
或其他专门存储
`

不要为了“数据库更专业”而提前增加复杂度。

---

## 12. 迁移前必须完成的盘点

在真正迁移前，对每个 data/* 文件回答四个问题：

1. 谁产生它？
2. 谁读取它？
3. 丢失后能否从其他数据重新生成？
4. 它是否代表跨 Workflow 的长期事实？

形成类似：

| File | Producer | Consumer | Rebuildable | Persistent |
|---|---|---|---|---|
| node-pool.json | node-pool | build | No | Yes |
| source-evolution.json | evolution | reputation | No | Yes |
| discovery-state.json | discovery | discovery | No | Yes |
| candidates.json | build | health | Yes | No |
| subscriptions/*.yaml | convert | user | Yes | No |

最终以实际代码依赖为准，而不是仅凭文件名判断。

---

## 13. 第一阶段实施边界

本设计阶段**不立即重构整个项目**。

建议实施顺序：

### Phase 1 — State inventory

完整盘点 data/：

- producer；
- consumer；
- dependency；
- size；
- rebuildability；
- persistence requirement。

### Phase 2 — State adapter

新增统一接口：

`text
restoreState()
saveState()
validateState()
migrateState()
`

业务脚本暂时继续读写原来的 data/*.json。

这样可以先改变“存储位置”，不改变业务逻辑。

### Phase 3 — Private State Repository

建立独立私有 State Repository。

Workflow：

`text
restore → run → validate → save
`

### Phase 4 — 减少主仓库 runtime data

确认 State Repository 稳定后，再停止向 NodeProbe 主仓库 commit 大型 runtime JSON。

### Phase 5 — 再考虑数据库

只有当 JSON State 本身成为性能/查询瓶颈时才进入。

---

## 14. 不应该做的事情

当前阶段不要：

- 直接把所有 data 删除；
- 直接依赖 GitHub Actions Cache；
- 用 Artifact 充当永久数据库；
- 在没有 schema/migration 的情况下修改 State 结构；
- 为了减小仓库而丢弃历史；
- 把 candidates 等可重建数据误认为核心记忆；
- 在没有验证 restore/save 后就停止 commit runtime state；
- 同时重构 State schema、业务逻辑和 Workflow。

应该保持：

> **一次只改变一个边界。**

---

## 15. 最终目标

NodeProbe 最终应该形成两个清晰的系统：

### Code

`text
NodeProbe
├── Discovery
├── Fetch
├── Validation
├── Tracking
├── Lifecycle / evidence
├── Selection
└── Subscription Generation
`

### Memory

`text
NodeProbe State
├── Node Memory
├── Source Memory
├── Discovery Memory
├── Evolution Memory
├── Lifecycle Memory
└── Cache
`

两者关系：

`text
             Code
              │
              ▼
        ┌─────────────┐
        │   NodeProbe │
        └──────┬──────┘
               │
        read / update
               │
               ▼
        Persistent State
               │
        ┌──────┴──────┐
        ▼             ▼
   next Workflow   analysis/history
`

最终原则：

> **NodeProbe 的代码定义它“怎么运行”；Persistent State 记录它“记得什么”。**

只有二者结合，NodeProbe 才真正是一个持续运行的系统，而不是每四小时重新运行一次的无状态脚本。

---

## 16. 与当前项目设计的关系

这一设计不会改变现有核心理念：

- Source 不是最终产品；
- Node 是长期资产；
- Node Pool 是 NodeProbe 自有资产层；
- Source Reputation 与 Node lifecycle 分离；
- Source Evolution 只观察，不直接惩罚；
- Discovery Memory 与 Source Reputation 分离；
- firstObservedAt 是 NodeProbe observation time，而不是 publication time；
- 节点消失不等于节点死亡。

它解决的是另一个层次的问题：

> **这些长期记忆应该存在哪里，才能让 NodeProbe 在临时 GitHub Actions runner 上持续存在。**

因此，Storage Architecture 属于基础设施层，不应该反过来改变 Node/Source 的业务语义。
