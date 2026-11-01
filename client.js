/**
 * dsh-command-context — Client half.
 *
 * 内置的命令结果卡片（GenericCommandCard）默认折叠，正文要点一下才展开。
 * 这里占用 `conversation.chat.commandview` 这个按命令名分发的 keyed slot，
 * 只接管 name === 'context' 的那一行，把它直接铺开——没有折叠状态，也就没有
 * 需要手点的那一步。
 *
 * 只读渲染：不订阅任何会话状态、不发请求、不持有跨组件状态。
 * 容器与文字颜色全部走宿主主题 token，不写死颜色。
 */

window.__ModuleLoader__.load({
  id: 'dsh-command-context',

  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 报告正文的排版：等宽、保留换行（列对齐靠的就是这个）、不截断。 */
    const REPORT_STYLE = {
      margin: 0,
      padding: '12px 16px',
      border: '0.5px solid var(--dsw-alias-border-l1)',
      borderRadius: '8px',
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: '12px',
      lineHeight: '1.5',
      whiteSpace: 'pre-wrap',
      overflowWrap: 'anywhere',
      overflow: 'visible',
    }

    /** 命令名那一行，和内置卡片保持同样的信息（哪条命令产生了这段输出）。 */
    const TITLE_STYLE = {
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: '12px',
      margin: '0 0 4px 4px',
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
    }

    function ContextCommandCard({ node }) {
      const outcome = node?.outcome ?? null
      const title = h('div', { style: TITLE_STYLE }, `/${node?.name ?? 'context'}`)

      // 还没结算（命令正在跑）：留一个占位，不假装有结果。
      if (outcome === null) {
        return h(
          'div',
          null,
          title,
          h(
            'pre',
            { style: { ...REPORT_STYLE, color: 'var(--dsw-alias-label-secondary)' } },
            '\u2026',
          ),
        )
      }

      const text = outcome.text ?? ''
      const style =
        outcome.kind === 'error'
          ? { ...REPORT_STYLE, color: 'var(--dsw-alias-state-error-primary)' }
          : REPORT_STYLE

      return h('div', null, title, h('pre', { style }, text))
    }

    return {
      inject: ['slots'],

      apply(ctx) {
        ctx.slots.inject('conversation.chat.commandview', () =>
          ctx.slots.register(
            {
              name: 'conversation.chat.commandview',
              key: 'context',
            },
            ContextCommandCard,
          ),
        )
      },
    }
  },
})
