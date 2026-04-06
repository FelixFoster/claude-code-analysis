import { defineConfig } from 'vitepress'

const base = process.env.VITEPRESS_BASE ?? '/'

export default defineConfig({
  lang: 'zh-CN',
  title: 'Claude Code 未上线功能深度分析',
  description: 'Claude Code 隐藏/未上线功能的深度研究文档（按 Tier 分组）',
  head: [['link', { rel: 'icon', href: 'data:,' }]],
  base,
  appearance: true,
  cleanUrls: false,
  markdown: {
    lineNumbers: true,
    theme: {
      light: 'github-light',
      dark: 'github-dark'
    },
    config: (md) => {
      const defaultFence = md.renderer.rules.fence
      md.renderer.rules.fence = (tokens, idx, options, env, self) => {
        const token = tokens[idx]
        const info = (token.info || '').trim()
        if (info === 'mermaid') {
          const escaped = md.utils.escapeHtml(token.content)
          return `<div class="mermaid-wrapper"><pre class="mermaid-src" style="display:none">${escaped}</pre><div class="mermaid-chart"></div></div>`
        }
        return defaultFence ? defaultFence(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options)
      }
    }
  },
  themeConfig: {
    search: {
      provider: 'local'
    },
    nav: [
      { text: '首页', link: '/' },
      { text: '总览', link: '/features/README' }
    ],
    docFooter: {
      prev: '上一页',
      next: '下一页'
    },
    returnToTopLabel: '回到顶部',
    sidebarMenuLabel: '菜单',
    darkModeSwitchLabel: '主题',
    outline: {
      level: [2, 3],
      label: '页面导航'
    },
    sidebar: [
      {
        text: '基础架构',
        collapsed: false,
        items: [
          { text: 'Feature Flag 三层架构', link: '/features/infra/20-feature-flag-arch' }
        ]
      },
      {
        text: 'S-Tier',
        collapsed: false,
        items: [
          { text: '01 - KAIROS', link: '/features/s-tier/01-kairos' },
          { text: '02 - TRANSCRIPT_CLASSIFIER', link: '/features/s-tier/02-transcript-classifier' },
          { text: '03a - BRIDGE_MODE Core', link: '/features/s-tier/03-bridge-mode-core' },
          { text: '03b - BRIDGE_MODE Auth', link: '/features/s-tier/03-bridge-mode-auth' },
          { text: '03c - BRIDGE_MODE Sessions', link: '/features/s-tier/03-bridge-mode-sessions' },
          { text: '03d - BRIDGE_MODE IDE', link: '/features/s-tier/03-bridge-mode-ide' }
        ]
      },
      {
        text: 'A-Tier',
        collapsed: false,
        items: [
          { text: '04 - COORDINATOR_MODE', link: '/features/a-tier/04-coordinator-mode' },
          { text: '05 - VOICE_MODE', link: '/features/a-tier/05-voice-mode' },
          { text: '06 - Attribution', link: '/features/a-tier/06-attribution' },
          { text: '07 - Context Mgmt', link: '/features/a-tier/07-context-mgmt' },
          { text: '08 - Daemon', link: '/features/a-tier/08-daemon' },
          { text: '09 - Compact', link: '/features/a-tier/09-compact' },
          { text: '10 - ULTRAPLAN', link: '/features/a-tier/10-ultraplan' },
          { text: '11 - Chicago MCP', link: '/features/a-tier/11-chicago-mcp' },
          { text: '12 - TeamMem', link: '/features/a-tier/12-teammem' }
        ]
      },
      {
        text: 'B-Tier',
        collapsed: false,
        items: [
          { text: '13 - Agent Triggers', link: '/features/b-tier/13-agent-triggers' },
          { text: '14 - Buddy', link: '/features/b-tier/14-buddy' },
          { text: '15 - Workflow Scripts', link: '/features/b-tier/15-workflow-scripts' },
          { text: '16 - Background Sessions', link: '/features/b-tier/16-bg-sessions' },
          { text: '17 - Lodestone', link: '/features/b-tier/17-lodestone' },
          { text: '18 - Ultrathink', link: '/features/b-tier/18-ultrathink' },
          { text: '19 - MCP Skills', link: '/features/b-tier/19-mcp-skills' }
        ]
      }
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/FelixFoster/claude-code' }
    ]
  }
})
