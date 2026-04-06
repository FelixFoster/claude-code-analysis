# COMPACT 深度分析

> **Source Commit**: `4b9d30f`
> **分析日期**: 2026-04-04
> **复杂度等级**: A-Tier
> **涉及文件数**: ~28
> **相关 Feature Flags**: `tengu_cobalt_raccoon`, `tengu_slate_heron`, `tengu_compact_cache_prefix`, `tengu_compact_streaming_retry`

## 概述

COMPACT 子系统在当前快照中不是单一路径，而是三类互补策略：

1. **CACHED_MICROCOMPACT**：在请求前做轻量删除规划，但不改写本地消息正文，把删除动作延迟到 API 参数层，以尽量保住前缀缓存命中。入口在 query 主循环的 microcompact 阶段，状态管理在 `microCompact.ts`，注入动作在 `claude.ts`。`src/query.ts:queryLoop (L412)`, `src/services/compact/microCompact.ts:microcompactMessages (L253)`, `src/services/api/claude.ts:addCacheBreakpoints (L3063)`
2. **REACTIVE_COMPACT**：当模型调用返回“prompt too long / 媒体过大”后再恢复性压缩，属于“被动触发、单次兜底、然后重试”的惰性策略。其主调度在 `query.ts`，真实实现体通过动态 `require` 指向 `reactiveCompact.js`，但源码文件未出现在当前快照。`src/query.ts:queryLoop (L15)`, `src/query.ts:queryLoop (L1119)`
3. **标准 COMPACT**：用户手动 `/compact` 命令，先尝试 session memory compact，再落到传统 summarize compact，必要时在 reactive-only 模式下改走 reactive 路径。`src/commands/compact/compact.ts:call (L40)`, `src/commands/compact/compact.ts:compactViaReactive (L139)`

这三条路径共享两条核心约束：
- 都服务于“让下一次 query 能继续跑”，而不是“永久删除历史”。`src/services/compact/compact.ts:buildPostCompactMessages (L330)`
- 都在 compaction 后执行统一清理，避免主线程状态与压缩后的消息视图不一致。`src/services/compact/postCompactCleanup.ts:runPostCompactCleanup (L31)`

## 架构图

下图展示三种策略在一次 query 中的相对位置与切换关系（图标题中文、节点英文）。

```mermaid
flowchart TD
  A[Query Loop Start] --> B[Microcompact Stage]
  B --> C{Cached MC eligible?}
  C -- yes --> D[Queue cache_edits]
  C -- no --> E[No pre-edit]
  D --> F[Call Model]
  E --> F

  F --> G{Prompt-too-long / media error?}
  G -- yes --> H[Reactive Compact Retry]
  G -- no --> I[Continue tool loop]

  J[/compact command] --> K{Session memory compact?}
  K -- yes --> L[Build compact result]
  K -- no --> M[Summarize compactConversation]
  M --> N[Post-compact cleanup]
  L --> N
  H --> N
```

图中流程证据：`src/query.ts:queryLoop (L412, L454, L1065, L1119)`, `src/commands/compact/compact.ts:call (L55, L96)`, `src/services/compact/postCompactCleanup.ts:runPostCompactCleanup (L31)`。

## 核心文件清单

| 文件路径 | 角色 | 关键证据 |
|---|---|---|
| `src/query.ts` | query 主循环中串联 microcompact / autocompact / reactive fallback | `queryLoop (L412-L470, L1065-L1166)` |
| `src/query/deps.ts` | 把 `microcompactMessages` 与 `autoCompactIfNeeded` 注入 query 依赖 | `productionDeps (L33-L39)` |
| `src/services/compact/microCompact.ts` | cached/time-based microcompact 主实现与状态容器 | `microcompactMessages (L253)`, `cachedMicrocompactPath (L305)` |
| `src/services/api/claude.ts` | API 层 `cache_edits` 与 `cache_reference` 注入、去重、重放 | `paramsFromContext (L1538)`, `addCacheBreakpoints (L3063)` |
| `src/services/compact/autoCompact.ts` | 自动压缩阈值、禁用条件、session memory 优先策略 | `shouldAutoCompact (L160)`, `autoCompactIfNeeded (L241)` |
| `src/services/compact/compact.ts` | 传统 summarize compact、边界消息与附件重建 | `compactConversation (L387)`, `streamCompactSummary (L1136)` |
| `src/commands/compact/compact.ts` | `/compact` 入口与 reactive-only 分流 | `call (L40)`, `compactViaReactive (L139)` |
| `src/services/tokenEstimation.ts` | 粗略 token 估算（文本/工具/图像/文档） | `roughTokenCountEstimationForBlock (L391)` |
| `src/services/compact/timeBasedMCConfig.ts` | 间隔触发微压缩配置读取 | `getTimeBasedMCConfig (L36)` |
| `src/services/api/errors.ts` | 413 转用户可见 API 错误消息 | `createAssistantAPIErrorMessage branch (L657)` |

## CACHED_MICROCOMPACT：入口条件与状态机

cached microcompact 只在“主线程 + 支持模型 + 功能开启”条件下进入；否则 `microcompactMessages` 直接返回原 messages，不做本地重写。`src/services/compact/microCompact.ts:microcompactMessages (L272-L293)`

具体门控链路：

```ts
// src/services/compact/microCompact.ts:microcompactMessages (L276-L285)
if (feature('CACHED_MICROCOMPACT')) {
  const mod = await getCachedMCModule()
  const model = toolUseContext?.options.mainLoopModel ?? getMainLoopModel()
  if (
    mod.isCachedMicrocompactEnabled() &&
    mod.isModelSupportedForCacheEditing(model) &&
    isMainThreadSource(querySource)
  ) {
    return await cachedMicrocompactPath(messages, querySource)
  }
}
```

状态上分三块：
- `cachedMCState`：记录注册过的工具结果与 pinned edits；
- `pendingCacheEdits`：等待“下一个 API 请求”消费的一次性编辑块；
- `pinnedEdits`：历史编辑块在后续请求中按原位置回放，保证 cache hit 语义连续。`src/services/compact/microCompact.ts:ensureCachedMCState (L71)`, `src/services/compact/microCompact.ts:consumePendingCacheEdits (L88)`, `src/services/compact/microCompact.ts:getPinnedCacheEdits (L100)`, `src/services/compact/microCompact.ts:pinCacheEdits (L111)`

这也解释了为什么 query 里只保存 `pendingCacheEdits` 元信息，而不立即生成 boundary：真实删除 token 数要等 API usage 的累计字段回传后再计算差值。`src/query.ts:queryLoop (L420-L425)`, `src/query.ts:queryLoop (L866-L892)`

## CACHED_MICROCOMPACT：cache_edits 注入与前缀缓存保护

CACHED_MICROCOMPACT 的关键是“本地消息不动，API 参数动”。在 `cachedMicrocompactPath` 中，工具删除集合只转成 `pendingCacheEdits`，函数返回的 `messages` 仍是原数组。`src/services/compact/microCompact.ts:cachedMicrocompactPath (L300-L304, L369-L394)`

真正注入发生在 `claude.ts` 的 `addCacheBreakpoints`：
1. 先重放 pinned edits；
2. 再把新 edits 插入最后一个 user message；
3. 最后给缓存前缀内的 `tool_result` 添加 `cache_reference`。`src/services/api/claude.ts:addCacheBreakpoints (L3127-L3138, L3141-L3153, L3164-L3204)`

```ts
// src/services/api/claude.ts:addCacheBreakpoints (L3141-L3157)
if (newCacheEdits && result.length > 0) {
  const dedupedNewEdits = deduplicateEdits(newCacheEdits)
  if (dedupedNewEdits.edits.length > 0) {
    for (let i = result.length - 1; i >= 0; i--) {
      const msg = result[i]
      if (msg && msg.role === 'user') {
        insertBlockAfterToolResults(msg.content, dedupedNewEdits)
        pinCacheEdits(i, newCacheEdits)
        break
      }
    }
  }
}
```

为了避免重复删除，`addCacheBreakpoints` 用 `seenDeleteRefs` 做跨块去重；这既覆盖“历史回放 + 本轮新增”的重叠，也覆盖多轮重试下同一删除引用。`src/services/api/claude.ts:addCacheBreakpoints (L3112-L3125)`

## CACHED_MICROCOMPACT：本地消息不改写策略与告警抑制

该策略显式承诺“**不改写本地消息内容**”，因此不会像 time-based 路径那样把 `tool_result.content` 变成清空标记文本。`src/services/compact/microCompact.ts:cachedMicrocompactPath (L300-L304, L369-L371)`

压缩成功后会触发两个副作用：
- 抑制紧随其后的 compact warning，避免用户看到“刚压完又快满了”的错误体验；
- 告知 cache break detector：下一次 cache read 下降是预期行为，不应报警。`src/services/compact/microCompact.ts:cachedMicrocompactPath (L358-L367)`, `src/services/compact/compactWarningState.ts:suppressCompactWarning (L11)`

query 侧在拿到 API 响应后，使用 `cache_deleted_input_tokens` 的“累计值减基线”算出本次真实删除 token，再决定是否发 microcompact boundary。`src/query.ts:queryLoop (L870-L891)`

## REACTIVE_COMPACT：413 触发面与拦截位置

REACTIVE_COMPACT 是“错误后恢复”，触发前提不是阈值，而是模型调用已返回可识别错误。`query.ts` 会先在流式阶段“暂不向外吐出”可恢复错误，然后在无 follow-up 分支里尝试恢复。`src/query.ts:queryLoop (L788-L823)`, `src/query.ts:queryLoop (L1062-L1120)`

触发信号分两类：
- prompt too long（通常映射到 413 类超限语义）；
- 媒体体积/维度错误（图片与文档相关）。`src/query.ts:queryLoop (L1070-L1085)`

底层错误标准化处，`APIError.status === 413` 会被包装成统一用户提示文本，这也是 reactive 路径可识别的上游来源之一。`src/services/api/errors.ts:createAssistantAPIErrorMessage branch (L657-L664)`

## REACTIVE_COMPACT：懒压缩决策与执行路径（N/A 说明）

当 query 检测到 withheld 的 413/媒体错误后，会调用 `reactiveCompact.tryReactiveCompact(...)`；成功则产出一组 post-compact messages 并 `continue` 重试当前 query，失败则把 withheld 错误原样吐出并结束当前回合。`src/query.ts:queryLoop (L1119-L1175)`

```ts
// src/query.ts:queryLoop (L1119-L1166)
if ((isWithheld413 || isWithheldMedia) && reactiveCompact) {
  const compacted = await reactiveCompact.tryReactiveCompact({...})
  if (compacted) {
    const postCompactMessages = buildPostCompactMessages(compacted)
    for (const msg of postCompactMessages) yield msg
    state = { ...state, messages: postCompactMessages, hasAttemptedReactiveCompact: true }
    continue
  }
  yield lastMessage
  return { reason: isWithheldMedia ? 'image_error' : 'prompt_too_long' }
}
```

**N/A（实现体缺失）**：`reactiveCompact` 模块在本快照仅能看到动态加载与调用点，未找到实现文件，因此“内部分组算法、裁剪细节、重试上限”不能在本文件中下结论。可证据仅限调用契约与状态机。`src/query.ts:queryLoop (L15-L17, L1119-L1124)`, `src/commands/compact/compact.ts:compactViaReactive (L175-L194)`

## 标准 COMPACT：/compact 命令流程

`/compact` 命令入口在 `commands/compact/compact.ts:call`，流程是：

1. 先把 REPL 全量消息投影为“边界之后的有效消息”；
2. 无自定义指令时优先尝试 session memory compact；
3. 若处于 reactive-only 模式，改走 `compactViaReactive`；
4. 否则执行“microcompact 预处理 + compactConversation summarize”。`src/commands/compact/compact.ts:call (L44-L99, L101-L108)`

`compactConversation` 本体做的事：pre hooks、调用 summarizer、重建 boundary/summary/attachments/hookResults，并统一打点与后处理。`src/services/compact/compact.ts:compactConversation (L387-L749)`

失败处理上，manual `/compact` 会在 catch 分支做错误翻译（包含 user abort / incomplete response / not enough messages），并在必要时上抛。`src/commands/compact/compact.ts:call (L125-L135)`

## 标准 COMPACT：压缩提示词与多轮信息保留

标准 compact 的摘要提示词来自 `getCompactPrompt`，前置了强 no-tools 约束，避免摘要模型在单回合里浪费到工具调用。`src/services/compact/prompt.ts:getCompactPrompt (L293-L303)`, `src/services/compact/prompt.ts:NO_TOOLS_PREAMBLE (L19-L26)`

摘要结果会被 `formatCompactSummary` 处理：移除 `<analysis>` 草稿段，只保留 `<summary>` 内容；最终再包装为“从上次对话继续”的 user summary message。`src/services/compact/prompt.ts:formatCompactSummary (L311-L335)`, `src/services/compact/prompt.ts:getCompactUserSummaryMessage (L337-L374)`

多轮压缩信息保留依赖两层机制：
- `buildPostCompactMessages` 的稳定顺序（boundary → summary → keep → attachments → hooks）；
- `annotateBoundaryWithPreservedSegment` 在 boundary 里记录 preserved segment 链接，避免后续加载时丢失 keep 段。`src/services/compact/compact.ts:buildPostCompactMessages (L330-L338)`, `src/services/compact/compact.ts:annotateBoundaryWithPreservedSegment (L349-L366)`

此外，session memory compact 会在可行时把“已提炼记忆 + 最近窗口”组合输出，作为传统 summarize 的前置替代。`src/services/compact/sessionMemoryCompact.ts:trySessionMemoryCompaction (L514-L620)`

## 策略选择逻辑与优先级

### query 主循环优先级

在 query 内部，顺序是：`snip -> microcompact -> context collapse -> autocompact -> 模型调用 ->（必要时）reactive compact`。这意味着 reactive 是最后兜底，而 cached microcompact 是最早的轻量优化。`src/query.ts:queryLoop (L396-L447, L453-L468, L1065-L1166)`

### `/compact` 命令优先级

命令态顺序是：`session memory compact（若无 customInstructions） -> reactive-only 分支 -> 传统 summarize compact`。`src/commands/compact/compact.ts:call (L55-L99)`

### 自动压缩禁用条件

`shouldAutoCompact` 会在以下场景直接返回 false：
- `DISABLE_COMPACT` / `DISABLE_AUTO_COMPACT`；
- querySource 属于 `session_memory` 或 `compact`（防递归）；
- reactive-only 模式打开；
- context collapse 接管阈值策略。`src/services/compact/autoCompact.ts:shouldAutoCompact (L169-L223)`

这解释了“为什么同样是超长上下文，有时不会先走 autocompact，而会等 413 再走 reactive”。`src/services/compact/autoCompact.ts:shouldAutoCompact (L189-L209)`

## Token 估算与触发阈值

阈值核心来自 `autoCompact.ts`：
- `effectiveWindow = contextWindow - reservedOutput`；
- `autoCompactThreshold = effectiveWindow - 13000`；
- 阻断阈值保留额外 3000 给 manual compact。`src/services/compact/autoCompact.ts:getEffectiveContextWindowSize (L33-L49)`, `src/services/compact/autoCompact.ts:getAutoCompactThreshold (L72-L91)`, `src/services/compact/autoCompact.ts:calculateTokenWarningState (L122-L137)`

估算核心来自 `tokenEstimation.ts` 与 `microCompact.ts`：
- 文本按字符粗估；
- image/document 固定按 2000 token 计（避免明显低估）；
- tool_use 计 `name + input json`；
- message 级估算会累积 block 并用于 compact 决策。`src/services/tokenEstimation.ts:roughTokenCountEstimationForBlock (L391-L435)`, `src/services/compact/microCompact.ts:estimateMessageTokens (L164-L205)`

```ts
// src/services/compact/autoCompact.ts:getAutoCompactThreshold (L72-L77)
const effectiveContextWindow = getEffectiveContextWindowSize(model)
const autocompactThreshold = effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS
```

## Feature Flag 门控

本节仅给出 COMPACT 相关最小事实，三层门控的基础机制不重复展开，统一参考：[`../infra/20-feature-flag-arch.md`](../infra/20-feature-flag-arch.md)。

与 COMPACT 强相关的可观测门控点：
- `tengu_cobalt_raccoon`：reactive-only 模式在自动压缩判定中直接短路。`src/services/compact/autoCompact.ts:shouldAutoCompact (L195-L199)`
- `tengu_slate_heron`：time-based microcompact 配置来源。`src/services/compact/timeBasedMCConfig.ts:getTimeBasedMCConfig (L36-L42)`
- `tengu_compact_cache_prefix`：compact summarizer fork 是否启用 cache sharing。`src/services/compact/compact.ts:compactConversation (L435-L438)`, `src/services/compact/compact.ts:streamCompactSummary (L1155-L1158)`
- `tengu_compact_streaming_retry`：compact streaming fallback 是否重试。`src/services/compact/compact.ts:streamCompactSummary (L1251-L1256)`

## 限制、已知边界与技术亮点

### 已知边界

1. **Reactive 实现文件缺失**：仅能验证调用契约与状态迁移，无法验证内部压缩算法。`src/query.ts:queryLoop (L15-L17, L1119-L1124)`
2. **cached microcompact 依赖动态模块**：`cachedMicrocompact.js` 实现体未收录，当前可证据范围是状态接口与 API 注入层行为。`src/services/compact/microCompact.ts:getCachedMCModule (L62-L69)`
3. **CONTEXT_COLLAPSE / HISTORY_SNIP 协作逻辑可见、实现体不全**：query 有调用与分支，但对应实现模块并未在本目录可读。`src/query.ts:queryLoop (L115-L120, L401-L447)`

### 技术亮点（≤3）

1. **“本地不改写 + API 注入”微压缩模式**：通过 `cache_edits` 与 `cache_reference` 把删除行为下沉到请求层，兼顾上下文缩减与前缀复用。`src/services/compact/microCompact.ts:cachedMicrocompactPath (L300-L304)`, `src/services/api/claude.ts:addCacheBreakpoints (L3164-L3204)`
2. **错误后恢复的惰性策略**：把 413/媒体错误先 withheld，再单次 reactive compact 重试，成功则继续当前 query，失败才把错误暴露给用户。`src/query.ts:queryLoop (L788-L823, L1119-L1175)`
3. **统一后清理与状态复位**：manual / auto / reactive 路径最终都收敛到 post-compact cleanup，减少跨路径状态漂移。`src/services/compact/postCompactCleanup.ts:runPostCompactCleanup (L31-L77)`, `src/commands/compact/compact.ts:call (L118)`, `src/services/compact/autoCompact.ts:autoCompactIfNeeded (L326)`
