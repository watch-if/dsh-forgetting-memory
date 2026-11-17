import React from 'react'

const API = '/api/forgetting-memory/admin'
const PAGE_SIZE = 200
export const inject = ['slots']

async function request(body, query) {
  const params = query ? new URLSearchParams({
    view: query.view,
    offset: String(query.offset || 0),
    ...(query.detail ? { detail: query.detail } : {}),
  }) : null
  const url = params ? API + '?' + params.toString() : API
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET',
    credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || '管理接口暂不可用')
  return payload
}

function MemoryAdminCard(props) {
  const [data, setData] = React.useState(null)
  const [view, setView] = React.useState('forgotten')
  const [selected, setSelected] = React.useState(() => new Set())
  const [expanded, setExpanded] = React.useState({})
  const [offset, setOffset] = React.useState(0)
  const [busy, setBusy] = React.useState(false)
  const [notice, setNotice] = React.useState('')
  const [error, setError] = React.useState('')
  const [projectionScore, setProjectionScore] = React.useState(0.7)
  const [projectionReinforcements, setProjectionReinforcements] = React.useState(0)

  const refresh = React.useCallback(async (nextOffset = offset, nextView = view) => {
    setBusy(true)
    setError('')
    try {
      const result = await request(null, { view: nextView, offset: nextOffset })
      setData(result)
      setOffset(nextOffset)
      setSelected(new Set())
      setExpanded({})
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem))
    } finally {
      setBusy(false)
    }
  }, [offset, view])

  React.useEffect(() => { void refresh(0, 'forgotten') }, [])

  if (props.view === 'summary') return '管理遗忘记录、笔记和日记；日记全文只在展开时读取。'

  const rows = data?.[view] || []
  const projection = data?.forgettingProjection
  const effectiveHalfLife = projection
    ? projection.configuredHalfLifeDays * (1 + 2 * Math.min(6, projectionReinforcements))
    : 0
  const daysTo = threshold => projectionScore <= threshold || threshold <= 0
    ? 0
    : effectiveHalfLife * Math.log2(projectionScore / threshold)
  const toggle = id => setSelected(old => {
    const next = new Set(old)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const loadDetail = async id => {
    setBusy(true)
    setError('')
    try {
      const result = await request(null, { view, offset, detail: id })
      setExpanded(old => ({ ...old, [id]: result.detail || '（无详情）' }))
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem))
    } finally {
      setBusy(false)
    }
  }
  const act = async (action, status) => {
    if (action !== 'sleep' && !selected.size) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const result = await request({ action, ids: [...selected], status, pinned: status })
      setNotice(action === 'sleep'
        ? '休眠整理已完成，处理 ' + (result.processed || 0) + ' 条消息。'
        : action === 'corner'
          ? '已把所选时间段的总体摘要移入日记角落。'
          : '已处理 ' + (result.changed ?? result.deleted ?? 0) + ' 条记录。')
      await refresh(0, view)
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem))
      setBusy(false)
    }
  }
  const clearAll = async () => {
    if (!window.confirm('清空整个遗忘记录文件？此操作无法撤销。')) return
    setBusy(true)
    setError('')
    try {
      const result = await request({ action: 'clear' })
      setNotice('已清理 ' + (result.changed || 0) + ' 条遗忘记录。')
      await refresh(0, 'forgotten')
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem))
      setBusy(false)
    }
  }
  const el = (tag, props, ...children) => React.createElement(tag, props, ...children)
  const button = (label, onClick, disabled = false, active = false) => el('button', {
    type: 'button', onClick, disabled: disabled || busy,
    'aria-pressed': active,
    style: { margin: '0 8px 8px 0', padding: '6px 10px', cursor: disabled || busy ? 'default' : 'pointer' },
  }, label)
  const tabs = el('div', { style: { margin: '12px 0' } },
    ...[
      ['forgotten', '遗忘记录'],
      ['corner', '日记角落'],
      ['diary', '日记'],
      ['notebook', '笔记'],
      ['relationships', '关系圈'],
    ].map(([id, label]) => button(label, () => {
      setView(id); setOffset(0); setSelected(new Set()); setExpanded({}); void refresh(0, id)
    }, false, view === id)),
    button('刷新', () => { void refresh(0, view) }),
  )
  let toolbar
  if (view === 'forgotten') {
    toolbar = el('div', null,
      button('现在休眠整理', () => { void act('sleep') }),
      button('选中转入日记角落', () => { void act('corner') }, selected.size === 0),
      button('删除选中项', () => { void act('delete') }, selected.size === 0),
      button('清空整个遗忘文件', () => { void clearAll() }),
    )
  } else if (view === 'notebook') {
    toolbar = el('div', null,
      button('标记完成', () => { void act('setNotebookStatus', 'completed') }, selected.size === 0),
      button('取消任务', () => { void act('setNotebookStatus', 'cancelled') }, selected.size === 0),
      button('重新激活', () => { void act('setNotebookStatus', 'active') }, selected.size === 0),
    )
  } else if (view === 'relationships') {
    toolbar = el('div', null,
      button('固定为核心', () => { void act('pinRelation', true) }, selected.size === 0),
      button('取消固定', () => { void act('pinRelation', false) }, selected.size === 0),
    )
  } else {
    toolbar = el('div', null,
      button('删除选中项', () => { void act(view === 'corner' ? 'deleteCorner' : 'deleteDiary') }, selected.size === 0),
    )
  }
  const list = rows.length
    ? el('div', { role: 'list', style: { maxHeight: 420, overflowY: 'auto', margin: '12px 0' } },
      ...rows.map(row => el('div', {
        key: row.id,
        role: 'listitem',
        style: { padding: '8px 4px', borderTop: '1px solid var(--dsw-border-subtle, #8884)' },
      },
      el('label', null,
        el('input', {
          type: 'checkbox', checked: selected.has(row.id), disabled: busy,
          onChange: () => toggle(row.id), style: { marginRight: 8 },
        }),
        el('strong', null, new Date(row.occurredAt || 0).toLocaleString()),
        el('span', { style: { marginLeft: 8, opacity: 0.7 } }, row.scope || ''),
        row.status ? el('span', { style: { marginLeft: 8, opacity: 0.7 } }, '状态：' + row.status) : null,
        row.interactions ? el('span', { style: { marginLeft: 8, opacity: 0.7 } }, '跨时段互动：' + row.interactions) : null,
      ),
      el('div', { style: { whiteSpace: 'pre-wrap', margin: '4px 0 0 24px' } }, row.summary || '（无摘要）'),
      view === 'diary' ? button(expanded[row.id] ? '收起全文' : '展开日记全文', () => {
        if (expanded[row.id]) setExpanded(old => { const next = { ...old }; delete next[row.id]; return next })
        else void loadDetail(row.id)
      }, busy) : null,
      expanded[row.id] ? el('pre', { style: { whiteSpace: 'pre-wrap', marginLeft: 24 } }, expanded[row.id]) : null,
      )))
    : el('p', null, data ? '这一页没有记录。' : '正在读取记录…')
  const hasMore = Boolean(data?.[view + 'HasMore'])
  const paging = el('div', null,
    offset > 0 ? button('回到较新记录', () => { void refresh(Math.max(0, offset - PAGE_SIZE), view) }) : null,
    hasMore ? button('查看更早记录', () => { void refresh(offset + PAGE_SIZE, view) }) : null,
  )

  return el('section', { style: { padding: 12 } },
    el('p', null, '数据目录：', data?.dataDir || '读取中…'),
    el('p', null, '遗忘记录文件：', data?.forgottenPath || '读取中…'),
    ...(data?.warnings || []).map((warning, index) => el('p', { key: 'warning-' + index, role: 'status', style: { color: 'var(--dsw-alias-warning, #9a6700)' } }, warning)),
    el('p', { style: { opacity: 0.72 } }, '遗忘文件保存每个整理时间段的总体短摘要，不参与 AI 自动检索。转入角落也只转入这条摘要；日记详情按需展开。'),
    projection ? el('details', null,
      el('summary', null, '查看遗忘曲线预估'),
      el('label', null, '初始权重 ' + projectionScore.toFixed(2) + ' ',
        el('input', { type: 'range', min: 0, max: 1, step: 0.01, value: projectionScore, onChange: event => setProjectionScore(Number(event.target.value)) }),
      ),
      el('label', { style: { display: 'block', marginTop: 8 } }, '已累积强化次数 ' + projectionReinforcements + ' ',
        el('input', { type: 'range', min: 0, max: 6, step: 1, value: projectionReinforcements, onChange: event => setProjectionReinforcements(Number(event.target.value)) }),
      ),
      el('p', null, '当前有效半衰期：' + effectiveHalfLife.toFixed(1) + ' 天；不再强化时，约 ' + daysTo(projection.cornerThreshold).toFixed(1) + ' 天进入日记角落，约 ' + daysTo(projection.forgetThreshold).toFixed(1) + ' 天进入遗忘文件。'),
      el('code', null, projection.formula),
      el('p', { style: { opacity: 0.72 } }, '这是按当前设置做的数学推算。未来重复提及会再次强化，实际保留时间会随之变化。'),
    ) : null,
    tabs,
    toolbar,
    notice ? el('p', { role: 'status' }, notice) : null,
    error ? el('p', { role: 'alert', style: { color: 'var(--dsw-alias-error, #c33)' } }, error) : null,
    list,
    paging,
  )
}

export function apply(ctx) {
  ctx.effect(
    () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
      name: 'plugins.item',
      id: 'forgetting-memory',
      order: 60,
      label: () => '记忆管理',
      inject: () => ({}),
    }, MemoryAdminCard)),
    'forgetting-memory: settings page',
  )
}
