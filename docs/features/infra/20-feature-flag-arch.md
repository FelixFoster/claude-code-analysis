# Feature Flag 三层架构深度分析

> **Source Commit**: `4b9d30f`
> **分析日期**: 2026-04-04
> **复杂度等级**: A-Tier（基础架构）
> **涉及文件数**: ~30
> **相关 Feature Flags**: 全部 tengu_* flags

## 概述

Claude Code 的 feature flag 不是“单点开关”，而是一个明确分层的三层门控体系：

1. **Build-time DCE 层**：`bun:bundle` 的 `feature()` 在构建期决定代码是否进入产物。
2. **Runtime 层**：GrowthBook 在运行期按用户属性评估 `tengu_*` gate/config。
3. **Entitlement 层**：对订阅、OAuth profile、组织信息、安全策略再做“能力可用性”判定。

这三层在 Claude Code 中形成“先删代码、再判配置、后判资格”的防线组合：

- 没被 build flag 编进包的能力，不存在运行期绕过空间；
- 编进包但 gate 关闭时，逻辑会走默认值或降级路径；
- gate 打开后仍可被 entitlement/security gate 拒绝（例如 remote control、bypass 权限、trusted device）。

关键入口与实现：`src/commands.ts`、`src/tools.ts`、`src/services/analytics/growthbook.ts`、`src/bridge/bridgeEnabled.ts`、`src/utils/permissions/permissionSetup.ts`。

## 架构图

```mermaid
flowchart TD
  A[Build System bun:bundle feature()] -->|DCE keep/remove| B[Compiled CLI Binary]
  B --> C[Runtime Feature Read API]
  C -->|getFeatureValue_CACHED_MAY_BE_STALE| D[Disk Cache ~/.claude.json cachedGrowthBookFeatures]
  C -->|initializeGrowthBook + remoteEval| E[GrowthBook API]
  E --> F[remoteEval payload features]
  F --> G[processRemoteEvalPayload]
  G --> H[in-memory Map remoteEvalFeatureValues]
  G --> D
  C --> I[Entitlement/Security checks]
  I --> J[Subscription/OAuth/Profile/Org/Policy]
  I --> K[Final allow/deny/diagnostic]
```

图中路径对应：`src/services/analytics/growthbook.ts:initializeGrowthBook (L622)`、`src/services/analytics/growthbook.ts:processRemoteEvalPayload (L327)`、`src/services/analytics/growthbook.ts:getFeatureValue_CACHED_MAY_BE_STALE (L734)`、`src/bridge/bridgeEnabled.ts:isBridgeEnabledBlocking (L50)`。

## 核心文件清单

| 文件 | 行数 | 职责 |
|---|---:|---|
| `src/services/analytics/growthbook.ts` | 1155 | GrowthBook 客户端、缓存、refresh、gate API 主实现 |
| `src/commands.ts` | 754 | command 注册时的 build-time `feature()` DCE |
| `src/tools.ts` | 389 | tool 注册时的 build-time `feature()` DCE |
| `src/entrypoints/init.ts` | 340 | 启动时初始化 1P logging + GrowthBook refresh listener |
| `src/constants/keys.ts` | 11 | GrowthBook client key 分流（ant/dev/external） |
| `src/utils/user.ts` | 194 | GrowthBook 用户属性来源（subscription/rate tier/org/account） |
| `src/bridge/bridgeEnabled.ts` | 202 | bridge 的 runtime + entitlement 复合门控 |
| `src/bridge/trustedDevice.ts` | 210 | elevated session trusted-device gate |
| `src/utils/permissions/permissionSetup.ts` | 1532 | auto mode / bypass 权限 gate（含安全限制） |
| `src/services/mcp/channelAllowlist.ts` | 76 | `tengu_harbor` 与 allowlist config gate |
| `src/services/mcp/channelPermissions.ts` | 240 | channel permission relay runtime gate |
| `src/services/settingsSync/index.ts` | 581 | 上传/下载设置同步 gate 分离 |

## 启动与初始化流程

### 1) 启动阶段并不阻塞业务路径

`src/entrypoints/init.ts:init (L57)` 中，GrowthBook 以动态 import 方式被并行拉起，不阻塞主路径：

- `initialize1PEventLogging()` 使用当前缓存配置启动日志批处理；
- `onGrowthBookRefresh()` 监听后续 flag/config 刷新，必要时重建 provider。

引用：`src/entrypoints/init.ts:init (L94-L105)`。

### 2) GrowthBook 客户端构建

`src/services/analytics/growthbook.ts:getGrowthBookClient (L490)` 做了几个关键决策：

- client key 由 `src/constants/keys.ts:getGrowthBookClientKey (L5)` 按 ant/dev/external 分流；
- 属性由 `src/services/analytics/growthbook.ts:getUserAttributes (L454)` 构建，底层来自 `src/utils/user.ts:getUserForGrowthBook (L133)`；
- 仅在 trust established 后注入 auth header（避免早期触发 apiKeyHelper）。

### 3) 初始化后双缓存写入

初始化成功后 `processRemoteEvalPayload()` 先更新内存 Map，再 `syncRemoteEvalToDisk()` 落盘，随后 `refreshed.emit()` 通知订阅者。

引用：`src/services/analytics/growthbook.ts:getGrowthBookClient (L554-L590)`。

## 运行时行为

### 1) 读取优先级（核心）

`src/services/analytics/growthbook.ts:getFeatureValue_CACHED_MAY_BE_STALE (L734)` 的读取序：

1. env override（`CLAUDE_INTERNAL_FC_OVERRIDES`）
2. config override（`growthBookOverrides`）
3. in-memory `remoteEvalFeatureValues`
4. disk `cachedGrowthBookFeatures`
5. default

这让它既快（同步、常驻缓存），又支持 ant 内部实时 override。

### 2) 刷新策略

- external：6 小时；ant：20 分钟。
- 轻刷新走 `refreshFeatures()`，不重建 client；auth 变更走 `refreshGrowthBookAfterAuthChange()` 完整重建。

引用：`src/services/analytics/growthbook.ts:setupPeriodicGrowthBookRefresh (L1087)`、`src/services/analytics/growthbook.ts:refreshGrowthBookAfterAuthChange (L943)`。

### 3) remoteEval payload 兼容修正

当前 API 返回 `value`，SDK 预期 `defaultValue`，代码做了 payload transform，并缓存“服务端预评估结果”。

引用：`src/services/analytics/growthbook.ts:processRemoteEvalPayload (L330-L391)`。

## Feature Flag 门控

这是本文核心。Claude Code 的门控是三层叠加，而非二选一。

### 层 1：Build-time DCE（编译期删代码）

由 `feature('...') ? require(...) : null` 模式驱动，典型在 command/tool 注册面。

- `src/commands.ts`：`KAIROS`、`BRIDGE_MODE`、`VOICE_MODE`、`WORKFLOW_SCRIPTS` 等。
- `src/tools.ts`：`AGENT_TRIGGERS`、`MONITOR_TOOL`、`WEB_BROWSER_TOOL`、`COORDINATOR_MODE` 等。

该层决定**代码是否存在于产物**，是最强门控。

### 层 2：Runtime Gate（运行时评估）

通过 `getFeatureValue_CACHED_MAY_BE_STALE` / `getDynamicConfig_CACHED_MAY_BE_STALE` / `checkStatsigFeatureGate_CACHED_MAY_BE_STALE` 使用 `tengu_*`。

该层负责 rollout、kill switch、参数化配置（JSON config），示例：

- `tengu_ccr_bridge`：bridge 可用；
- `tengu_harbor`：channels 总开关；
- `tengu_auto_mode_config`：auto mode 枚举态（enabled/disabled/opt-in）。

### 层 3：Entitlement / Security Gate（资格层）

即使 runtime flag 为 true，也要过资格检查：

- 订阅/身份：`isClaudeAISubscriber()`、`hasProfileScope()`；
- 组织信息：`organizationUuid` 可用性；
- 安全策略：`checkSecurityRestrictionGate('tengu_disable_bypass_permissions_mode')`；
- trusted-device：`tengu_sessions_elevated_auth_enforcement` + token 流程。

这层典型出现在用户可见能力（Remote Control、Bypass 模式）上。

## 关键代码片段

### 片段 A：Build-time DCE（command 注册）

来源：`src/commands.ts`。

```ts
import { feature } from 'bun:bundle'

const bridge = feature('BRIDGE_MODE')
  ? require('./commands/bridge/index.js').default // ← 关键点
  : null

const voiceCommand = feature('VOICE_MODE')
  ? require('./commands/voice/index.js').default // ← 关键点
  : null

const workflowsCmd = feature('WORKFLOW_SCRIPTS')
  ? require('./commands/workflows/index.js').default
  : null
```

对应：`src/commands.ts` 顶部条件导入段。

### 片段 B：Build-time DCE（tool 注册）

来源：`src/tools.ts`。

```ts
const MonitorTool = feature('MONITOR_TOOL')
  ? require('./tools/MonitorTool/MonitorTool.js').MonitorTool // ← 关键点
  : null

const WebBrowserTool = feature('WEB_BROWSER_TOOL')
  ? require('./tools/WebBrowserTool/WebBrowserTool.js').WebBrowserTool
  : null

const SnipTool = feature('HISTORY_SNIP')
  ? require('./tools/SnipTool/SnipTool.js').SnipTool
  : null
```

对应：`src/tools.ts` 条件导入段。

### 片段 C：Runtime 读取优先级

来源：`src/services/analytics/growthbook.ts:getFeatureValue_CACHED_MAY_BE_STALE`。

```ts
export function getFeatureValue_CACHED_MAY_BE_STALE<T>(
  feature: string,
  defaultValue: T,
): T {
  const overrides = getEnvOverrides()
  if (overrides && feature in overrides) return overrides[feature] as T // ← 关键点

  const configOverrides = getConfigOverrides()
  if (configOverrides && feature in configOverrides) {
    return configOverrides[feature] as T // ← 关键点
  }

  if (remoteEvalFeatureValues.has(feature)) {
    return remoteEvalFeatureValues.get(feature) as T // ← 关键点
  }

  const cached = getGlobalConfig().cachedGrowthBookFeatures?.[feature]
  return cached !== undefined ? (cached as T) : defaultValue
}
```

对应：`src/services/analytics/growthbook.ts:getFeatureValue_CACHED_MAY_BE_STALE (L734)`。

### 片段 D：Entitlement + Runtime 复合门控（Bridge）

来源：`src/bridge/bridgeEnabled.ts:isBridgeEnabledBlocking`。

```ts
export async function isBridgeEnabledBlocking(): Promise<boolean> {
  return feature('BRIDGE_MODE')
    ? isClaudeAISubscriber() &&
        (await checkGate_CACHED_OR_BLOCKING('tengu_ccr_bridge')) // ← 关键点
    : false
}
```

对应：`src/bridge/bridgeEnabled.ts:isBridgeEnabledBlocking (L50)`。

## 状态管理

GrowthBook 状态分成 4 类：

1. **客户端状态**：`client`, `clientCreatedWithAuth`, `reinitializingPromise`。
2. **flag 值缓存**：`remoteEvalFeatureValues`（内存）+ `cachedGrowthBookFeatures`（磁盘）。
3. **实验曝光状态**：`experimentDataByFeature`, `pendingExposures`, `loggedExposures`。
4. **刷新订阅状态**：`refreshed` signal + listener 集合。

`resetGrowthBook()` 会清理 client/interval/cache/exposure，但不会清理外部注册意图（通过 signal 重新挂载）。

引用：`src/services/analytics/growthbook.ts:resetGrowthBook (L987)`。

## 安全与权限模型

### 1) 信任边界

- build-time：由发布产物决定能力“是否存在”；
- runtime：由 GrowthBook 与本地缓存决定“默认行为”；
- entitlement：由 OAuth/订阅/组织/策略决定“最终可用性”。

### 2) 风险控制点

- trust 未建立前不带 auth header 初始化 GrowthBook（避免过早执行敏感 helper）；
- `checkSecurityRestrictionGate()` 在 reinit 期间可等待，降低认证切换窗口的 stale 风险；
- bypass 权限使用专门安全 gate。

引用：`src/services/analytics/growthbook.ts:getGrowthBookClient (L514-L521)`、`src/services/analytics/growthbook.ts:checkSecurityRestrictionGate (L851)`、`src/utils/permissions/permissionSetup.ts:shouldDisableBypassPermissions (L1265)`。

## 完整 tengu_* Flag 清单

> 说明：本表聚焦“门控用 flag”，不展开每个功能实现细节。默认值来自调用点默认参数；“条件”表示默认行为受 build flag / entitlement /环境变量联合影响。

| Flag | 对应功能 | 默认值 |
|---|---|---|
| `tengu_ccr_bridge` | Remote Control 总 gate | 关 |
| `tengu_ccr_bridge_multi_session` | bridge 多会话能力 | 关 |
| `tengu_ccr_bundle_seed_enabled` | remote session bundle seed | 关 |
| `tengu_bridge_repl_v2` | env-less bridge v2 | 关 |
| `tengu_bridge_repl_v2_cse_shim_enabled` | cse shim | 开 |
| `tengu_bridge_min_version` | v1 bridge 最低版本配置 | 条件 |
| `tengu_bridge_repl_v2_config` | v2 bridge 参数配置 | 条件 |
| `tengu_bridge_poll_interval_config` | bridge polling 参数配置 | 条件 |
| `tengu_cobalt_harbor` | CCR auto-connect default | 关 |
| `tengu_ccr_mirror` | CCR mirror | 关 |
| `tengu_sessions_elevated_auth_enforcement` | trusted device 强化认证 | 关 |
| `tengu_harbor` | MCP channels 总开关 | 关 |
| `tengu_harbor_ledger` | channels allowlist 配置 | 条件 |
| `tengu_harbor_permissions` | channels permission relay | 关 |
| `tengu_enable_settings_sync_push` | settings upload | 关 |
| `tengu_strap_foyer` | settings download | 关 |
| `tengu_amber_quartz_disabled` | voice kill switch（反向） | 关（即 voice 不被杀） |
| `tengu_chomp_inflection` | prompt suggestion | 关 |
| `tengu_session_memory` | session memory | 关 |
| `tengu_sm_config` | session memory 配置 | 条件 |
| `tengu_sm_compact` | session memory compact | 关 |
| `tengu_sm_compact_config` | session memory compact 配置 | 条件 |
| `tengu_passport_quail` | extract memories 主 gate | 关 |
| `tengu_slate_thimble` | 非交互 extract memories | 关 |
| `tengu_moth_copse` | memory index skip 行为 | 关 |
| `tengu_bramble_lintel` | memory extraction 频率 | 条件 |
| `tengu_herring_clock` | team memory | 关 |
| `tengu_coral_fern` | past context 搜索提示 | 关 |
| `tengu_lodestone_enabled` | deep link 自动注册 | 关 |
| `tengu_disable_bypass_permissions_mode` | 禁用 bypass 权限模式 | 关 |
| `tengu_auto_mode_config` | auto mode 配置（enabled/opt-in） | 条件 |
| `tengu_tool_pear` | strict tool schema/beta | 关 |
| `tengu_fgts` | fine-grained tool streaming | 关 |
| `tengu_amber_json_tools` | token-efficient tools beta | 关 |
| `tengu_scratch` | scratchpad gate（statsig 兼容路径） | 关 |
| `tengu_otk_slot_v1` | API 相关策略 gate | 关 |
| `tengu_event_sampling_config` | 1P analytics sampling config | 条件 |
| `tengu_1p_event_batch_config` | 1P analytics batch config | 条件 |
| `tengu_frond_boric` | analytics sink killswitch config | 条件 |

## 与其他功能的交互

### 1) Commands / Tools 与 flag 的交互

- build-time：`src/commands.ts` 与 `src/tools.ts` 决定模块是否参与运行时。
- runtime：各功能模块按需读取 `tengu_*` 值，常见为“先 build gate 后 runtime gate”。

### 2) 典型交互索引（仅门控维度）

- Bridge：`src/bridge/bridgeEnabled.ts`、`src/bridge/trustedDevice.ts`。
- Session/Memory：`src/services/SessionMemory/sessionMemory.ts`、`src/services/extractMemories/extractMemories.ts`、`src/memdir/paths.ts`、`src/memdir/teamMemPaths.ts`、`src/memdir/memdir.ts`。
- MCP Channels：`src/services/mcp/channelAllowlist.ts`、`src/services/mcp/channelPermissions.ts`。
- Settings Sync：`src/services/settingsSync/index.ts`。
- API Tool Schema：`src/utils/api.ts`。

## 错误处理与恢复

### 1) fail-open / fail-safe 组合

- runtime config 解析失败通常回退默认值（例如 poll config、allowlist）；
- remote payload 空对象会被拒绝，避免写空缓存导致全局 blackout；
- auth 改变触发 reset+reinit，并在中间态主动 `refreshed.emit()` 让订阅方重读。

引用：`src/services/analytics/growthbook.ts:processRemoteEvalPayload (L338)`、`src/bridge/pollConfig.ts:getPollIntervalConfig (L102)`。

### 2) stale 场景策略

- 性能敏感路径偏向 `_CACHED_MAY_BE_STALE`；
- 对“误拒绝成本高”的 entitlement 使用 `checkGate_CACHED_OR_BLOCKING`（cached true 快返，cached false 触发阻塞刷新）。

引用：`src/services/analytics/growthbook.ts:checkGate_CACHED_OR_BLOCKING (L904)`。

## UI/UX

N/A（内部基础设施）。

## 限制与已知问题

1. **SDK/API 兼容补丁仍在**：`value`→`defaultValue` 的 payload workaround 说明服务端/SDK 形态未完全统一。见 `src/services/analytics/growthbook.ts:processRemoteEvalPayload (L330)`。
2. **stale 语义是刻意设计**：大量调用走 `_CACHED_MAY_BE_STALE`，意味着“快响应优先于强一致”；需要 entitlement 的地方再用 blocking gate 补齐。
3. **Statsig 兼容路径仍存在**：`checkStatsigFeatureGate_CACHED_MAY_BE_STALE` 仍用于部分 gate（如 `tengu_scratch`、`tengu_tool_pear`），迁移尚未完全收敛到单一 API。

## 技术亮点

1. **三层门控职责清晰**：build-time 负责“是否存在”，runtime 负责“如何开关”，entitlement 负责“谁可用”。
2. **缓存与刷新策略工程化**：内存+磁盘双缓存，轻刷新与重建区分，兼顾启动延迟与长会话一致性。
3. **资格判定前置为用户可解释错误**：如 bridge disabled reason 将 profile scope / org uuid 缺失转换为可执行提示，而非笼统“不可用”。
