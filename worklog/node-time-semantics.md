# 节点时间语义说明：不要把文件时间当成节点发布时间

## 核心问题

NodeProbe 可以可靠记录的是：NodeProbe 什么时候第一次观察到这个节点。
但通常无法可靠知道：这个节点究竟是什么时候第一次被发布到互联网。
这两个时间必须严格区分。

## 为什么不能用 Source 文件时间戳估计节点发布时间

一个节点可能是长生命周期节点。

例如：
1. 节点 A 在 2026-06-01 就已经被某个上游项目加入订阅；
2. 之后节点 A 一直可用，因此持续保留在订阅中；
3. 2026-09-20，上游项目重新生成/更新了订阅文件；
4. NodeProbe 在 2026-09-21 第一次发现节点 A。

此时：
- 文件修改时间：2026-09-20
- NodeProbe 首次观察时间：2026-09-21
- 节点真实首次发布时间：可能早于 2026-06-01，甚至无法知道

因此：**文件时间戳较晚，不代表其中的节点发布时间较晚。**

文件更新可能只是重新生成整个订阅、更新其他节点、修改文件格式、调整排序、重新发布同一批长期节点，或上游项目例行同步。

所以不能把 Source 文件最后修改时间直接传播为节点发布时间。

## NodeProbe 应该记录什么

当前数据模型中的时间字段，应明确表达为 NodeProbe 的观测时间：
- firstObservedAt：NodeProbe 第一次观察到该节点的时间。
- firstObservedSource：NodeProbe 第一次观察到该节点时对应的 Source。
- sourceObservations[].firstObservedAt：NodeProbe 第一次从该 Source 观察到该节点的时间。
- sourceObservations[].lastObservedAt：NodeProbe 最近一次从该 Source 观察到该节点的时间。
- lastObservedAt：NodeProbe 最近一次观察到该节点的时间。

这些字段都不应该被解释为 Source 的发布时间。

## 重要的推论

### 1. firstObservedAt ≠ firstPublishedAt

NodeProbe 的第一次观察只是一个下界信息：节点在 firstObservedAt 之前已经存在。
但无法仅凭 NodeProbe 的数据确定它究竟早多少。
因此不应该产生一个看似精确、实际上没有证据支持的 firstPublishedAt。

### 2. Source 文件更新 ≠ 节点更新

一个 Source 在今天更新文件，并不意味着文件中的每一个节点都是今天新增的。
特别是长活节点：节点长期存在 → Source 持续保留 → Source 文件不断重新生成 → 文件时间不断变新。
所以文件时间和节点年龄可能完全不同步。

### 3. NodeProbe 自己的观察历史才是可靠的时间基准

对于 NodeProbe 能证明的事实，应该以自己的观测历史为准：
firstObservedAt → sourceObservations → lastObservedAt → health history

这样可以回答：NodeProbe 从什么时候开始知道这个节点、哪些 Source 曾经提供过它、某个 Source 是什么时候第一次被 NodeProbe 观察到提供该节点、NodeProbe 观察到它持续了多久、以及它在被观察期间是否稳定。

但不能据此声称节点的真实互联网发布时间。

## 对后续开发的提醒

以后如果需要描述“节点年龄”，优先使用 NodeProbe observed lifetime / observation lifetime，而不要写成 node publication age / node publish time。

如果未来真的需要研究“节点首次公开发布时间”，必须引入独立证据，例如可靠的历史快照、版本提交历史或其他可验证的时间来源，并明确标记其证据等级。

**默认原则：没有证据就不要推断节点发布时间。**

## 与节点 ID 的关系

这些时间和来源字段都是 provenance / observation metadata。
它们不参与 endpoint fingerprint，不改变已有节点 ID，也不应该因为 Source 文件时间变化而导致节点被视为新节点。

NodeProbe 的核心原则仍然是：
**身份由节点端点决定；时间记录的是 NodeProbe 的观察历史。**