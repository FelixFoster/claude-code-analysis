import DefaultTheme from 'vitepress/theme'
import './custom.css'

import { nextTick, onMounted, watch } from 'vue'
import { useRoute } from 'vitepress'
import mermaid from 'mermaid'

async function renderMermaid() {
  await nextTick()
  const wrappers = document.querySelectorAll('.mermaid-wrapper:not([data-mermaid-processed])')
  if (!wrappers.length) return
  const hasDark = document.documentElement.classList.contains('dark')
  mermaid.initialize({
    startOnLoad: false,
    theme: hasDark ? 'dark' : 'default'
  })
  for (const wrapper of wrappers) {
    const src = wrapper.querySelector('.mermaid-src')
    const chart = wrapper.querySelector('.mermaid-chart')
    if (!src || !chart) continue
    const code = src.textContent || ''
    try {
      const { svg } = await mermaid.render(`mermaid-${Math.random().toString(36).slice(2)}`, code)
      chart.innerHTML = svg
      wrapper.setAttribute('data-mermaid-processed', 'true')
    } catch (e) {
      console.warn('Mermaid render failed:', e)
      chart.innerHTML = `<pre style="color:red;white-space:pre-wrap">${code}</pre>`
      wrapper.setAttribute('data-mermaid-processed', 'error')
    }
  }
}

export default {
  ...DefaultTheme,
  setup() {
    const route = useRoute()
    onMounted(renderMermaid)
    watch(
      () => route.path,
      () => {
        renderMermaid()
      }
    )
  }
}
