# Claude Code 未上线功能深度分析

> Source Commit: 4b9d30f | 分析日期: 2026-04-04

## 概述

本文档索引 Claude Code 隐藏功能分析资料，按 Tier 分组整理，便于快速定位各模块的深度研究内容。

## 文档索引

### 基础架构

| 文件 | 字符数 | 说明 |
|------|--------|------|
| [infra/20-feature-flag-arch.md](infra/20-feature-flag-arch.md) | 12,766 | Feature Flag 三层架构深度分析 |

### S-Tier（重点功能）

| 文件 | 字符数 | 说明 |
|------|--------|------|
| [s-tier/01-kairos.md](s-tier/01-kairos.md) | 12,687 | KAIROS 智能任务调度与知识管理 |
| [s-tier/02-transcript-classifier.md](s-tier/02-transcript-classifier.md) | 14,598 | TRANSCRIPT_CLASSIFIER 安全分类器 |
| [s-tier/03-bridge-mode-core.md](s-tier/03-bridge-mode-core.md) | 7,080 | BRIDGE_MODE 核心通信协议 |
| [s-tier/03-bridge-mode-auth.md](s-tier/03-bridge-mode-auth.md) | 5,945 | BRIDGE_MODE 认证链路 |
| [s-tier/03-bridge-mode-sessions.md](s-tier/03-bridge-mode-sessions.md) | 5,239 | BRIDGE_MODE 会话管理 |
| [s-tier/03-bridge-mode-ide.md](s-tier/03-bridge-mode-ide.md) | 5,580 | BRIDGE_MODE IDE 集成 |

### A-Tier（主要功能）

| 文件 | 字符数 | 说明 |
|------|--------|------|
| [a-tier/04-coordinator-mode.md](a-tier/04-coordinator-mode.md) | 11,657 | COORDINATOR_MODE 多智能体协调 |
| [a-tier/05-voice-mode.md](a-tier/05-voice-mode.md) | 8,870 | VOICE_MODE 语音输入 |
| [a-tier/06-attribution.md](a-tier/06-attribution.md) | 11,831 | ATTRIBUTION 贡献归因 |
| [a-tier/07-context-mgmt.md](a-tier/07-context-mgmt.md) | 15,471 | CONTEXT_MGMT 上下文管理 |
| [a-tier/08-daemon.md](a-tier/08-daemon.md) | 11,407 | DAEMON 守护进程 |
| [a-tier/09-compact.md](a-tier/09-compact.md) | 13,007 | COMPACT 上下文压缩 |
| [a-tier/10-ultraplan.md](a-tier/10-ultraplan.md) | 11,573 | ULTRAPLAN 超级计划模式 |
| [a-tier/11-chicago-mcp.md](a-tier/11-chicago-mcp.md) | 15,811 | CHICAGO_MCP 计算机控制 |
| [a-tier/12-teammem.md](a-tier/12-teammem.md) | 13,215 | TEAMMEM 团队记忆同步 |

### B-Tier（辅助功能）

| 文件 | 字符数 | 说明 |
|------|--------|------|
| [b-tier/13-agent-triggers.md](b-tier/13-agent-triggers.md) | 13,979 | AGENT_TRIGGERS 智能体触发器 |
| [b-tier/14-buddy.md](b-tier/14-buddy.md) | 11,809 | BUDDY 伴侣精灵 |
| [b-tier/15-workflow-scripts.md](b-tier/15-workflow-scripts.md) | 11,370 | WORKFLOW_SCRIPTS 工作流脚本 |
| [b-tier/16-bg-sessions.md](b-tier/16-bg-sessions.md) | 11,667 | BG_SESSIONS 后台会话 |
| [b-tier/17-lodestone.md](b-tier/17-lodestone.md) | 12,600 | LODESTONE 深度链接协议 |
| [b-tier/18-ultrathink.md](b-tier/18-ultrathink.md) | 9,274 | ULTRATHINK 超级思考模式 |
| [b-tier/19-mcp-skills.md](b-tier/19-mcp-skills.md) | 11,278 | MCP_SKILLS 技能即MCP工具 |

### 索引附录

| 文件 | 字符数 | 说明 |
|------|--------|------|
| [README.md](README.md) | - | 本索引页汇总全部分析目录与分组。 |

## 统计

- 文档数：24
- 总字符数：258,714
