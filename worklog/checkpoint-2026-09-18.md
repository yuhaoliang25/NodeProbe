# Checkpoint — 2026-09-18

## 状态

NodeProbe 正从“筛选别人订阅中的好节点”转向“建立并维护自己的节点池”。

今天已经完成：
- 订阅 YAML → 完整 Mihomo 配置转换，并解决 FLClash 导入问题。
- 增加 COUNTRY 地区池。
- 增加基于服务器 IP 的实际国家探测。
- 明确最终目标：Source 只是节点发现/信息来源，不是最终产品。
- 明确节点生命周期与 Source 轮换必须分开观察。

## 当前核心架构原则

### 1. NodeProbe 自己的节点池才是最终产品

Source 的作用是：
- 发现新节点；
- 持续提供新的候选信息；
- 提供节点变化的外部信号。

最终订阅不应该简单复制某个 Source，也不应该以“哪个 Source 更好”为最终目标。

目标流程：

Source
→ Discovery
→ Validation
→ Tracking
→ Selection
→ NodeProbe 自己的 Subscription

### 2. 长生命周期节点是核心资产

节点需要记录：
- firstSeen
- lastSeen
- 连续出现周期
- 总出现次数
- 生命周期
- 历史健康表现
- 当前健康表现
- 曾经出现过的 Source

节点状态设计方向：
NEW → PROBATION → ACTIVE → STABLE → STALE → DEAD

节点从某个 Source 消失时不能立即视为死亡。

### 3. Source 的主动轮换不能简单惩罚

“节点生命周期短”不一定意味着 Source 差。
Source 可能主动淘汰旧节点、寻找更好的节点。

因此需要观察：
- Source 每轮新增/移除多少节点；
- 节点替换比例；
- 被替换节点与新节点的质量变化；
- Source 长期是否持续产生高质量的新节点。

也就是说：
- Node Stability：用户拿到的节点是否长期稳定；
- Source Quality / Evolution：这个 Source 是否持续提供有价值的新信息。

二者不能互相替代。

### 4. 存量维护 + 增量发现

最终系统应该形成：
- 长寿命节点：作为 NodeProbe 的存量核心资产；
- 聪明的轮换 Source：作为持续的新节点发现渠道；
- 健康检测：验证节点是否仍然值得保留；
- 生命周期跟踪：决定节点是否进入 STABLE / STALE / DEAD；
- 最终 YAML：只输出 NodeProbe 自己选择的节点。

## 当前已有数据

- data/history.json：多轮健康检测历史
- data/reputation.json：当时存在的历史节点信誉状态；该旧 Node Reputation 后续已移除。
- data/source-history.json：来源历史观测
- data/source-reputation.json：来源信誉
- data/source-similarity.json：来源重叠分析
- data/candidates.json：当前候选
- data/ip-geolocation.json：节点服务器 IP 地理信息
- data/country-pool.json：国家池选择记录

## 本次已实施

增加持久化节点池：
- data/node-pool.json（首次 Workflow 运行时生成）
- data/source-evolution.json（首次 Workflow 运行时生成）
- scripts/update-node-pool.js

节点池不再因为一次 Source 抓取结果消失就丢弃节点。已将持久化 Node Pool 合并回候选集，因此历史节点会继续进入下一轮健康检测。

每轮运行：
1. 当前 Source 产生新候选；
2. 与历史 Node Pool 合并；
3. 对当前候选和历史节点一起进行健康检测；
4. 根据最新健康结果更新 Node Pool；
5. 只有经过连续缺失/失败证据后才进入 DEAD；
6. STABLE 节点优先保留；
7. 新节点仍然保留探索机会；
8. Source 轮换产生的新节点继续进入观察体系。

同时记录 Source 的节点集合变化，为以后判断“坏轮换”还是“主动优化轮换”提供时间序列数据。已实现 data/source-evolution.json，当前只记录，不直接惩罚 Source。

## 当前不要做

- 不把 Source 排名当成最终目标。
- 不因为 Source 节点更换频繁就直接降低其信誉。
- 不因为节点一次消失就判定死亡。
- 不用单次运行结果修改核心阈值。
- 不删除已有历史数据。
- 暂不把来源相似度直接作为质量惩罚。

## 恢复入口

从最新 main 分支继续。

下一阶段重点是让 NodeProbe 真正拥有“节点记忆”，而不是每轮重新从 Source 开始。代码已完成首次接入，等待下一次 GitHub Actions 实际运行验证。


## 来源信誉与节点信誉分离

本阶段明确来源信誉的职责：
- 来源信誉评价的是“来源作为长期侦察渠道是否值得继续使用”，不是评价某个具体节点。
- 主要用于发现两类需要降级/淘汰的来源：长期不再更新的来源，以及持续提供低质量、节点快速失效的来源。
- 来源高频轮换本身不视为负面；轮换来源如果持续提供高质量节点，可以保持正常/可信状态。
- source-reputation 现在记录 freshness（lastObservedAt/stalenessDays）、质量，以及 source-evolution 的轮换观测，但轮换率不直接扣分。
- source-reputation 不再直接进入单节点 qualityScore；节点最终质量主要由 NodeProbe 自己的当前/历史健康证据决定。
- 来源信誉仍然用于 Source lifecycle / probe frequency，避免来源长期不更新却一直按正常来源处理。

当前状态：
- 当时的 Node Reputation：评价节点本身；该独立节点信誉体系后续已移除。
- Node Pool：维护 NodeProbe 自有节点资产及生命周期。
- Source Reputation：评价来源渠道。
- Source Evolution：观察来源的节点集合变化，暂不直接惩罚来源。


## 本阶段新增：互联网发现记忆

发现机制已从“固定 GitHub 查询 + 每次取第一页”升级为有状态的探索机制。

新增：
- data/discovery-state.json
- discover-sources.js 的 GitHub 多通道探索记忆

当前 GitHub 探索通道：
- updated：近期活跃项目
- created：新创建项目
- stars：成熟/高关注项目

每个 channel 保存搜索页游标，避免每次只重复读取第一页。

同时记录：
- repository 首次/最近被发现；
- repository 被发现次数；
- repository 最近一次展开时间；
- source 被作为 crawler parent 展开的次数与时间。

Repository 设置了有限 revisit interval，近期已经展开过的 repo 不会立即重复消耗探索额度。

因此现在明确区分：
- Search ranking：GitHub 当前如何排序；
- Discovery progress：NodeProbe 已经探索到哪里。

这层 discovery memory 不参与 Source Reputation，也不参与 Node Reputation。

当前设计仍保持 bounded crawler：
- GitHub 每个 channel 每次只推进有限页；
- 每轮限制 repository 展开数量；
- 每轮限制 source-link 扩展数量；
- 不把 NodeProbe 变成无限制的通用互联网爬虫。

下一步应先观察实际 Workflow 数据，再决定是否需要更复杂的时间窗口、topic/owner/fork 关联发现等机制。


## 本阶段新增：节点时间语义

需要特别避免把“Source 文件时间”解释成“节点发布时间”。

NodeProbe 能确认的是自己的观察时间，而不是节点在互联网中的真实首次发布时间：
- firstObservedAt：NodeProbe 第一次观察到节点的时间；
- firstObservedSource：NodeProbe 第一次观察到节点时对应的 Source；
- sourceObservations：NodeProbe 从各 Source 观察到该节点的历史。

不能通过 Source 文件的修改/生成时间准确估计节点发布时间。一个节点可能已经作为长活节点存在很久，只是随着 Source 重新生成订阅文件而出现在一个较新的文件中。因此“文件时间较晚”不等于“节点发布较晚”。

详细说明见：
- worklog/node-time-semantics.md

后续任何涉及“节点年龄”“发布时间”的逻辑，都必须先区分：
- NodeProbe observation time
- Source file update time
- actual publication time

默认不推断无法由证据支持的 actual publication time。
