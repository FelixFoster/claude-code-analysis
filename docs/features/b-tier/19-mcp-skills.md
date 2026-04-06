# MCP_SKILLS — MCP 服务器技能发现与集成

```
Source Commit: 4b9d30f
分析日期: 2026-04-04
Tier: B
```

---

## 1. 功能概述

MCP_SKILLS 功能将 MCP（Model Context Protocol）服务器的 **资源（resources）** 转化为可被 SkillTool 调用的技能命令。当 MCP 服务器通过 `skill://` URI scheme 暴露资源时，系统自动将其解析为 `PromptCommand` 类型的 skill，使模型可以像调用本地 SKILL.md 文件一样调用 MCP 服务器提供的技能。

核心价值：
- 将 MCP 资源协议桥接到 Claude Code 技能系统
- 让 MCP 服务器开发者可以通过标准 `resources` 能力发布技能
- 与本地/bundled/plugin 技能统一暴露在 SkillTool 的命令列表中

该功能通过 `feature('MCP_SKILLS')` 门控，属于实验性/渐进上线阶段。

---

## 2. 架构总览（含 Mermaid 图）

```mermaid
flowchart TD
    MCP_SERVER["MCP Server<br/>(exposes skill:// resources)"]
    CLIENT["src/services/mcp/client.ts<br/>connectToServer / setupServers"]
    FETCH["fetchMcpSkillsForClient<br/>(src/skills/mcpSkills.ts, 运行时 require)"]
    BUILDERS["src/skills/mcpSkillBuilders.ts<br/>getMCPSkillBuilders()"]
    LOAD["src/skills/loadSkillsDir.ts<br/>createSkillCommand / parseSkillFrontmatterFields"]
    APPSTATE["AppState.mcp.commands<br/>(mcpSkills merged with mcpCommands)"]
    SKILLTOOL["src/tools/SkillTool/SkillTool.ts<br/>getAllCommands()"]
    ATTACH["src/utils/attachments.ts<br/>getMcpSkillCommands()"]
    CMDS["src/commands.ts<br/>getMcpSkillCommands()"]
    MODEL["Model / LLM"]

    MCP_SERVER -->|resources/list| CLIENT
    CLIENT -->|feature MCP_SKILLS| FETCH
    FETCH -->|getMCPSkillBuilders| BUILDERS
    BUILDERS -->|registered at init| LOAD
    FETCH -->|返回 Command[]| CLIENT
    CLIENT -->|merge mcpSkills + mcpCommands| APPSTATE
    APPSTATE --> SKILLTOOL
    APPSTATE --> ATTACH
    ATTACH -->|skill listing in system prompt| MODEL
    MODEL -->|tool_use: Skill| SKILLTOOL
    SKILLTOOL -->|getAllCommands filter loadedFrom=mcp| APPSTATE
    CMDS -->|getMcpSkillCommands filter| APPSTATE
```

核心数据流：MCP 服务器暴露 `skill://` 资源 → `fetchMcpSkillsForClient` 读取并解析为 `Command` → 合并进 `AppState.mcp.commands` → SkillTool 通过 `getAllCommands()` 合并本地与 MCP 技能 → 模型可调用。

---

## 3. 核心文件清单

| 文件 | 职责 |
|------|------|
| `src/skills/mcpSkillBuilders.ts` | 依赖图叶子节点，提供 `registerMCPSkillBuilders` / `getMCPSkillBuilders` 注册中心 |
| `src/skills/mcpSkills.ts` | MCP 技能发现核心逻辑（运行时 require，源码不在 snapshot 中，通过 `mcpSkills.js` 引用） |
| `src/skills/loadSkillsDir.ts` | 注册 `createSkillCommand` 和 `parseSkillFrontmatterFields` 到 builders 注册中心 (L1083-1086) |
| `src/services/mcp/client.ts` | MCP 连接管理，在 `setupServers` / `connectToServer` 中调用 `fetchMcpSkillsForClient` (L117-121, L2171-2179) |
| `src/services/mcp/useManageMCPConnections.ts` | React hook 管理 MCP 连接，处理 `resources/list_changed` 通知刷新 MCP skills (L718-738) |
| `src/tools/SkillTool/SkillTool.ts` | `getAllCommands()` 合并 MCP skills 到本地命令 (L81-94) |
| `src/commands.ts` | `getMcpSkillCommands()` 过滤函数 (L547-559) |
| `src/utils/attachments.ts` | 系统提示中的 skill listing 合并 MCP skills (L2675-2683) |
| `src/tools/SkillTool/constants.ts` | 工具名常量 `SKILL_TOOL_NAME = 'Skill'` |
| `src/tools/SkillTool/prompt.ts` | SkillTool 提示词与预算管理 |

---

## 4. 启动与初始化流程

1. **Builder 注册（模块初始化）**：`src/skills/loadSkillsDir.ts` 在模块顶层执行 `registerMCPSkillBuilders({ createSkillCommand, parseSkillFrontmatterFields })`（`loadSkillsDir.ts:registerMCPSkillBuilders` L1083-1086）。该模块通过 `commands.ts` 的静态 import 在启动时立即求值。

2. **条件加载 fetchMcpSkillsForClient**：`src/services/mcp/client.ts` 在模块顶层通过 `feature('MCP_SKILLS')` 门控 `require('../../skills/mcpSkills.js')`（`client.ts:fetchMcpSkillsForClient` L117-121）。当 flag 关闭时，`fetchMcpSkillsForClient` 为 `null`。

3. **MCP 服务器连接**：当 MCP 服务器连接成功后，`setupServers` 或 `connectAndFetch` 并行获取 tools/commands/skills/resources（`client.ts:setupServers` L2171-2179）。`fetchMcpSkillsForClient` 仅在服务器支持 `resources` 能力时调用。

4. **合并到 AppState**：获取的 `mcpSkills` 与 `mcpCommands`（来自 MCP prompts）合并为 `commands` 数组（`client.ts` L2179），存入 `AppState.mcp.commands`。

---

## 5. 运行时行为

### 技能发现

`fetchMcpSkillsForClient` 从 MCP 服务器的 `resources/list` 响应中过滤 `skill://` URI scheme 的资源，使用 `getMCPSkillBuilders()` 获取 `createSkillCommand` 和 `parseSkillFrontmatterFields`，将资源内容解析为标准 `PromptCommand`。结果被 memoize 缓存（按服务器名）。

### 技能调用

当模型通过 SkillTool 调用技能时：
1. `getAllCommands()` 从 `AppState.mcp.commands` 过滤 `loadedFrom === 'mcp'` 的命令（`SkillTool.ts:getAllCommands` L81-94）
2. 与本地命令合并，通过 `uniqBy` 去重（本地优先）
3. `findCommand()` 定位目标命令
4. 根据命令的 `context` 属性决定 inline 或 fork 执行模式

### 动态刷新

当 MCP 服务器发送 `resources/list_changed` 通知时，`useManageMCPConnections` 清除 `fetchMcpSkillsForClient` 缓存并重新获取（`useManageMCPConnections.ts` L718-738），同时清除 skill-search 索引缓存。

---

## 6. Feature Flag 门控

MCP_SKILLS 使用 `feature('MCP_SKILLS')` 进行编译时门控。详见 [Feature Flag 架构文档](../infra/20-feature-flag-arch.md)。

门控点：
- `src/services/mcp/client.ts` L117：条件 require `mcpSkills.js`
- `src/services/mcp/client.ts` L1392、L1670：缓存清除
- `src/services/mcp/client.ts` L2174、L2348：服务器连接时的 skill 获取
- `src/services/mcp/useManageMCPConnections.ts` L684、L718：list_changed 通知处理
- `src/commands.ts` L550：`getMcpSkillCommands()` 过滤函数

当 flag 关闭时，所有 MCP skill 获取代码被 DCE（Dead Code Elimination）移除，`fetchMcpSkillsForClient` 为 `null`，`getMcpSkillCommands()` 返回空数组。

---

## 7. 关键代码片段

### 片段 1：Builder 注册中心（避免循环依赖）

```typescript
// src/skills/mcpSkillBuilders.ts L26-44
export type MCPSkillBuilders = {
  createSkillCommand: typeof createSkillCommand
  parseSkillFrontmatterFields: typeof parseSkillFrontmatterFields
}

let builders: MCPSkillBuilders | null = null

export function registerMCPSkillBuilders(b: MCPSkillBuilders): void {
  builders = b
}

export function getMCPSkillBuilders(): MCPSkillBuilders {
  if (!builders) {
    throw new Error(
      'MCP skill builders not registered — loadSkillsDir.ts has not been evaluated yet',
    )
  }
  return builders
}
```

### 片段 2：条件加载 fetchMcpSkillsForClient

```typescript
// src/services/mcp/client.ts L117-121
const fetchMcpSkillsForClient = feature('MCP_SKILLS')
  ? (
      require('../../skills/mcpSkills.js') as typeof import('../../skills/mcpSkills.js')
    ).fetchMcpSkillsForClient
  : null
```

### 片段 3：并行获取 tools/commands/skills/resources

```typescript
// src/services/mcp/client.ts L2171-2179
const [tools, mcpCommands, mcpSkills, resources] = await Promise.all([
  fetchToolsForClient(client),
  fetchCommandsForClient(client),
  feature('MCP_SKILLS') && supportsResources
    ? fetchMcpSkillsForClient!(client)
    : Promise.resolve([]),
  supportsResources ? fetchResourcesForClient(client) : Promise.resolve([]),
])
const commands = [...mcpCommands, ...mcpSkills]
```

### 片段 4：SkillTool 合并 MCP skills

```typescript
// src/tools/SkillTool/SkillTool.ts L81-94
async function getAllCommands(context: ToolUseContext): Promise<Command[]> {
  const mcpSkills = context
    .getAppState()
    .mcp.commands.filter(
      cmd => cmd.type === 'prompt' && cmd.loadedFrom === 'mcp',
    )
  if (mcpSkills.length === 0) return getCommands(getProjectRoot())
  const localCommands = await getCommands(getProjectRoot())
  return uniqBy([...localCommands, ...mcpSkills], 'name')
}
```

### 片段 5：getMcpSkillCommands 过滤函数

```typescript
// src/commands.ts L547-559
export function getMcpSkillCommands(
  mcpCommands: readonly Command[],
): readonly Command[] {
  if (feature('MCP_SKILLS')) {
    return mcpCommands.filter(
      cmd =>
        cmd.type === 'prompt' &&
        cmd.loadedFrom === 'mcp' &&
        !cmd.disableModelInvocation,
    )
  }
  return []
}
```

### 片段 6：resources/list_changed 处理 MCP skills 刷新

```typescript
// src/services/mcp/useManageMCPConnections.ts L718-738
if (feature('MCP_SKILLS')) {
  fetchMcpSkillsForClient!.cache.delete(client.name)
  fetchCommandsForClient.cache.delete(client.name)
  const [newResources, mcpPrompts, mcpSkills] =
    await Promise.all([
      fetchResourcesForClient(client),
      fetchCommandsForClient(client),
      fetchMcpSkillsForClient!(client),
    ])
  updateServer({
    ...client,
    resources: newResources,
    commands: [...mcpPrompts, ...mcpSkills],
  })
  clearSkillIndexCache?.()
}
```

---

## 8. 状态管理

MCP skills 的状态通过以下路径管理：

- **AppState.mcp.commands**：MCP prompts 与 MCP skills 的合并数组，是 SkillTool 和 attachments 系统的数据源
- **fetchMcpSkillsForClient.cache**：lodash memoize 缓存，按服务器名键控。在连接关闭（`onclose`）、显式断开（`disconnectServer`）、或 `list_changed` 通知时清除
- **skill-search 索引缓存**：当 MCP skills 变更时通过 `clearSkillIndexCache?.()` 失效

状态流向：MCP server → memoize cache → AppState.mcp.commands → SkillTool/attachments 消费。

---

## 9. 安全与权限模型

MCP skills 的权限控制与本地技能一致，由 `SkillTool.checkPermissions()` 统一处理（`SkillTool.ts:checkPermissions` L432-578）：

1. **deny 规则优先**：检查 `getRuleByContentsForTool` 中的 deny 规则
2. **allow 规则**：检查 allow 规则（支持精确匹配和 `:*` 前缀匹配）
3. **安全属性自动放行**：`skillHasOnlySafeProperties()` 检查命令是否仅包含 `SAFE_SKILL_PROPERTIES` 集合内的属性（`SkillTool.ts:skillHasOnlySafeProperties` L910-933）。MCP skills 可能携带 `allowedTools` 或自定义属性，若超出安全集合则需用户确认
4. **默认行为**：不匹配任何规则时，向用户请求权限（`behavior: 'ask'`）

MCP skills 还受限于 `disableModelInvocation` 检查（`SkillTool.ts:validateInput` L411-418）和 `getMcpSkillCommands` 中的过滤（`commands.ts` L553-555）。

---

## 10. 与其他功能的交互

- **SkillTool / Skill System**：MCP skills 通过 `loadedFrom === 'mcp'` 标记，与本地/bundled/plugin skills 在 `getAllCommands()` 中统一合并，共享 SkillTool 的 inline/fork 执行模式和权限模型。
- **attachments / 系统提示**：`src/utils/attachments.ts` 的 skill listing 逻辑调用 `getMcpSkillCommands()` 将 MCP skills 合并到模型可见的技能列表中（`attachments.ts:getMcpSkillCommands` L2677-2683）。
- **EXPERIMENTAL_SKILL_SEARCH**：当技能搜索功能启用时，MCP skills 变更会触发 `clearSkillIndexCache?.()` 失效搜索索引。

---

## 11. 错误处理与恢复

- **Builder 未注册**：`getMCPSkillBuilders()` 在 builders 为 null 时抛出明确错误（`mcpSkillBuilders.ts:getMCPSkillBuilders` L38-43），提示 `loadSkillsDir.ts` 尚未求值
- **连接断开恢复**：`onclose` 回调清除 `fetchMcpSkillsForClient.cache`（`client.ts` L1392-1394），下次操作自动重连并重新获取
- **显式断开恢复**：`disconnectServer` 同样清除缓存（`client.ts` L1670-1672）
- **list_changed 通知**：catch 块记录错误但不中断连接（`useManageMCPConnections.ts` L744-748）
- **获取失败**：`setupServers` 中的 skill 获取与 tools/resources 并行，单个失败由 `Promise.all` 传播，外层 catch 记录错误并返回部分结果

---

## 12. UI/UX

MCP skills 在 UI 层面与本地技能无区别：

- **Skill listing**：通过 `formatCommandsWithinBudget()`（`prompt.ts:formatCommandsWithinBudget` L70-171）在系统提示中展示，受 1% 上下文窗口预算限制
- **权限请求**：`SkillPermissionRequest` 组件（`src/components/permissions/SkillPermissionRequest/SkillPermissionRequest.tsx`）统一处理所有技能的权限提示
- **执行结果**：`SkillTool/UI.tsx` 的 `renderToolResultMessage` 显示 "Successfully loaded skill" 或 forked 执行结果

MCP skills 对用户透明——用户无法从 UI 区分一个技能是来自本地文件还是 MCP 服务器。

---

## 13. 限制与已知问题

1. **mcpSkills.ts 不在源码快照中**：核心发现逻辑 `fetchMcpSkillsForClient` 通过运行时 `require('../../skills/mcpSkills.js')` 加载，该文件在当前源码快照中不存在（可能被构建流程生成或位于未公开路径），无法分析其具体的 `skill://` URI 解析实现
2. **资源能力依赖**：`fetchMcpSkillsForClient` 仅在 MCP 服务器声明 `resources` 能力（`client.capabilities?.resources`）时调用，不支持 resources 的服务器无法发布 skills
3. **本地优先去重**：`uniqBy([...localCommands, ...mcpSkills], 'name')` 使本地同名技能优先，MCP skill 被静默覆盖，无告警
4. **缓存粒度**：memoize 按服务器名缓存，单个 MCP 服务器内的部分技能更新需整体刷新

---

## 14. 技术亮点

1. **循环依赖破解**：`mcpSkillBuilders.ts` 作为依赖图叶子节点（仅 import types），通过 write-once 注册模式解决 `client.ts → mcpSkills.ts → loadSkillsDir.ts → … → client.ts` 的循环依赖。同时规避了 Bun 打包的 `bunfs` 路径解析问题（变量动态 import 在打包后无法解析模块）和 dependency-cruiser 的循环检测。

2. **统一技能抽象**：MCP 服务器资源、本地 SKILL.md 文件、bundled 技能、plugin 技能在 `PromptCommand` 类型下统一，SkillTool 通过 `loadedFrom` 字段区分来源但提供完全一致的调用、权限、UI 体验。

3. **细粒度缓存失效**：`list_changed` 通知处理中同时失效 resources、commands、skills 三类缓存（`useManageMCPConnections.ts` L717-738），防止并发通知导致的 stale 数据覆盖新鲜数据。
