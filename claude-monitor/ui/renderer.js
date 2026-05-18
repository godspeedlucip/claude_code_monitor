// 悬浮窗前端 — IPC 推送驱动 (无轮询)

let unsubscribe = null

// ── 提示音 (Web Audio API) ─────────────────
let audioCtx = null
function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)()
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume()
  }
}

function playBeep() {
  try {
    ensureAudio()
    const ctx = audioCtx
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.type = 'sine'
    osc.frequency.setValueAtTime(660, ctx.currentTime)
    osc.frequency.setValueAtTime(880, ctx.currentTime + 0.12)
    gain.gain.setValueAtTime(0.3, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.35)
    osc.start(ctx.currentTime)
    osc.stop(ctx.currentTime + 0.35)
  } catch (e) { /* 静默 */ }
}

// ── 时间格式化 ─────────────────────────────
function relativeTime(ts) {
  const diff = Date.now() - ts
  const sec = Math.floor(diff / 1000)
  if (sec < 5) return 'just now'
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  return `${hr}h ${min % 60}m ago`
}

function formatDuration(val) {
  if (!val) return ''
  if (typeof val === 'number') {
    const min = Math.floor(val / 60)
    if (min < 60) return `${min}m`
    return `${Math.floor(min / 60)}h ${min % 60}m`
  }
  return String(val)
}

function formatCost(val) {
  if (!val) return ''
  if (typeof val === 'number') return `$${val.toFixed(2)}`
  if (typeof val === 'object' && val.total_cost_usd != null) return `$${val.total_cost_usd.toFixed(2)}`
  return String(val)
}

// ── 卡片渲染 ───────────────────────────────
function renderCard(session) {
  const {
    session_id, cwd, status, model, context_pct,
    cost, duration, last_event, last_tool,
    recent_tools, stop_reason, last_update, stopped_at,
    pid_waiting_for, _just_stopped
  } = session

  const statusLabel = status === 'active' ? 'active'
    : status === 'idle' ? 'idle'
    : status === 'waiting' ? 'waiting'
    : 'stopped'
  const dirName = cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() || cwd : 'unknown'
  const title = session.display_name || dirName

  const toolsStr = recent_tools && recent_tools.length > 0
    ? recent_tools.slice(-5).join(' → ') : ''

  const relTime = status === 'stopped' && stopped_at
    ? `stopped ${relativeTime(stopped_at)}`
    : relativeTime(last_update)

  const stageText = status === 'stopped' && stop_reason
    ? `${last_event} (${stop_reason})`
    : last_event + (last_tool ? `: ${last_tool}` : '')

  const waitingText = (status === 'waiting' && pid_waiting_for)
    ? `<div class="card-waiting">Awaiting: ${escHtml(pid_waiting_for)}</div>`
    : ''

  const extraClasses = []
  if (_just_stopped) extraClasses.push('just-stopped')
  if (status === 'waiting') extraClasses.push('waiting')
  const extraClassStr = extraClasses.length > 0 ? ' ' + extraClasses.join(' ') : ''

  return `
    <div class="card ${status}${extraClassStr}"
         data-session-id="${session_id}">
      <div class="card-header">
        <span class="status-indicator ${statusLabel}"></span>
        <span class="card-title">${statusLabel} ${escHtml(title)}</span>
        ${status === 'stopped' ? '<span class="expand-hint">▼</span>' : ''}
        <button class="dismiss-btn" title="Remove">×</button>
      </div>
      ${waitingText}
      <div class="card-details">
        <div class="card-path">${escHtml(cwd || '')}</div>
        <div class="card-stats">
          ${model && model !== 'unknown' ? `<span>${escHtml(model)}</span>` : ''}
          ${context_pct != null ? `<span>context ${context_pct}%</span>` : ''}
          ${cost ? `<span>${escHtml(formatCost(cost))}</span>` : ''}
          ${duration ? `<span>${escHtml(formatDuration(duration))}</span>` : ''}
        </div>
        <div class="card-stage">${stageText}</div>
        ${toolsStr ? `<div class="card-tools">${escHtml(toolsStr)}</div>` : ''}
        <div class="card-time">${relTime}</div>
      </div>
    </div>
  `
}

function escHtml(s) {
  const m = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  return String(s).replace(/[&<>"']/g, c => m[c])
}

function setupCardEvents() {
  const container = document.getElementById('cards-container')
  if (!container._eventsSetup) {
    container._eventsSetup = true
    container.addEventListener('click', async (event) => {
      const dismissBtn = event.target.closest('.dismiss-btn')
      if (dismissBtn) {
        event.stopPropagation()
        const card = dismissBtn.closest('.card')
        if (card) {
          await window.monitorAPI.removeSession(card.dataset.sessionId)
        }
        return
      }
      const card = event.target.closest('.card.stopped')
      if (card) {
        card.classList.toggle('expanded')
      }
    })
  }
}

// ── 渲染 ───────────────────────────────────
function render(sessions) {
  const container = document.getElementById('cards-container')
  const statusDot = document.getElementById('status-dot')
  statusDot.className = 'dot connected'

  if (!sessions || sessions.length === 0) {
    container.innerHTML = `
      <div class="empty">
        <p>等待 Claude Code 会话...</p>
        <p class="hint">启动 Claude Code 后，会话卡片将自动出现</p>
      </div>`
    return
  }

  // 保留 stopped 卡片的展开状态
  const expandedIds = new Set()
  container.querySelectorAll('.card.stopped.expanded').forEach(el => {
    expandedIds.add(el.dataset.sessionId)
  })

  // 检测新停止或新等待 → 提示音
  let hasAlert = false
  for (const s of sessions) {
    if (s._just_stopped) { hasAlert = true; break }
    if (s.status === 'waiting' && s._just_waiting) { hasAlert = true; break }
  }
  if (hasAlert) playBeep()

  container.innerHTML = sessions.map(renderCard).join('')
  setupCardEvents()

  expandedIds.forEach(id => {
    const el = container.querySelector(`.card[data-session-id="${id}"]`)
    if (el) el.classList.add('expanded')
  })
}

// ── 启动 ───────────────────────────────────
async function init() {
  // 初始加载
  const sessions = await window.monitorAPI.getSessions()
  render(sessions)

  // 订阅推送
  unsubscribe = window.monitorAPI.onSessionsUpdated((sessions) => {
    render(sessions)
  })
}

init()
