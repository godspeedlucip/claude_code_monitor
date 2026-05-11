// 会话状态机：双数据源融合 — PID 文件轮询 + HTTP hooks/statusLine
//
// PID 文件 (~/.claude/sessions/<pid>.json) = 进程存活权威来源
// HTTP hooks/statusLine = 元信息 enrichment (model, cost, context%, tools)
// 转录 JSONL 尾随 = 权限检测 fallback (当 PID 文件无 status 字段时)
//
// 状态转换：
//   PID 文件出现               → active/idle/waiting (由 PID status 决定)
//   PID 文件消失 / 进程已死     → stopped
//   stopped + 10s              → 从内存清除
//   idle + 5 分钟               → 从内存清除
//   HTTP Stop 事件             → stopped (作为补充信号)
//   用户手动删除                → 从内存清除

const { EventEmitter } = require('events')
const fs = require('fs')
const path = require('path')
const os = require('os')

// ── 常量 ──────────────────────────────────────────────
const PID_DIR = path.join(os.homedir(), '.claude', 'sessions')
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects')
const TICK_MS = 500
const IDLE_THRESHOLD_MS = 30 * 1000
const EXPIRE_STOPPED_MS = 10 * 1000
const EXPIRE_IDLE_MS = 5 * 60 * 1000
const PID_FILENAME_RE = /^\d+\.json$/
const HTTP_BUFFER_MS = 2000

let _loggedStatusKeys = false
let _loggedHookKeys = false
let _loggedPidFields = false

// ── 转录路径 sanitize（与 CC 的 sanitizePath 对齐）────
function sanitizePath(cwd) {
  return cwd
    .replace(/^[A-Za-z]:\\?/, '')      // 去掉 Windows 盘符
    .replace(/\\/g, '/')               // 反斜杠 → 正斜杠
    .replace(/^\/+/, '')               // 去掉开头的 /
    .replace(/[^a-zA-Z0-9_\-/.]/g, '-') // 特殊字符 → -
    .replace(/-+/g, '-')               // 连续 - 合并
    .replace(/\/-|-(\/|$)/g, '/')      // 清理分隔符旁边的 -
    .replace(/\/+/g, '/')              // 连续 / 合并
    .replace(/^\/+|\/+$/g, '')         // 去掉首尾 /
}

// ── PidRecord 解析 ─────────────────────────────────
function parsePidRecord(text) {
  try {
    const obj = JSON.parse(text)
    if (!obj.sessionId) return null
    return {
      pid: obj.pid || 0,
      session_id: obj.sessionId,
      cwd: obj.cwd || '',
      started_at_ms: obj.startedAt || 0,
      updated_at_ms: obj.updatedAt || null,
      status: obj.status || null,          // "busy" | "idle" | "waiting" (BG_SESSIONS 开启时)
      waiting_for: obj.waitingFor || null,
      kind: obj.kind || null,
      name: obj.name || null,
      version: obj.version || null,
      entrypoint: obj.entrypoint || null
    }
  } catch (e) {
    return null
  }
}

// ── 进程存活检查 ──────────────────────────────────
function isProcessAlive(pid) {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return false
  }
}

// ── 转录路径解析 ──────────────────────────────────
function resolveTranscriptPath(cwd, sessionId) {
  const slug = sanitizePath(cwd)
  if (!slug) return null
  return path.join(PROJECTS_DIR, slug, `${sessionId}.jsonl`)
}

// ── 轻量 FileTail（从 EOF 开始读取新增行）─────────────
class FileTail {
  constructor(filePath) {
    this.path = filePath
    this.offset = 0
    this.lastSize = null
    this.wasPresent = false
  }

  poll() {
    let file
    try {
      file = fs.openSync(this.path, 'r')
    } catch (e) {
      if (e.code === 'ENOENT') {
        this.offset = 0
        this.lastSize = null
        return { newLines: [], rotated: false, missing: true }
      }
      return { newLines: [], rotated: false, missing: false }
    }

    try {
      const stat = fs.fstatSync(file)
      const curSize = stat.size
      let rotated = false

      if (this.lastSize !== null && curSize < this.offset) {
        rotated = true
        this.offset = 0
      }
      this.lastSize = curSize
      this.wasPresent = true

      if (curSize <= this.offset) {
        return { newLines: [], rotated, missing: false }
      }

      const buf = Buffer.alloc(curSize - this.offset)
      fs.readSync(file, buf, 0, buf.length, this.offset)
      fs.closeSync(file)

      const lastNewline = buf.lastIndexOf(0x0A)
      if (lastNewline < 0) {
        return { newLines: [], rotated, missing: false }
      }

      const complete = buf.subarray(0, lastNewline)
      const text = complete.toString('utf-8')
      this.offset += lastNewline + 1

      const lines = text
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0)

      return { newLines: lines, rotated, missing: false }
    } catch (e) {
      try { fs.closeSync(file) } catch (_) {}
      return { newLines: [], rotated: false, missing: false }
    }
  }

  close() { /* 无清理需要 */ }
}

// ── 简化版 StatusMachine（仅检测 permission-mode）─────
class StatusMachine {
  constructor() {
    this.fallbackWaiting = false
  }

  reset() {
    this.fallbackWaiting = false
  }

  ingestLine(line) {
    try {
      const obj = JSON.parse(line)
      const entryType = obj.type || ''

      if (entryType === 'permission-mode') {
        this.fallbackWaiting = true
      } else if (entryType === 'user' || entryType === 'assistant') {
        this.fallbackWaiting = false
      }
    } catch (_) {}
  }

  derivedStatus() {
    if (this.fallbackWaiting) return 'waiting'
    return null  // null = 让调用方使用基本启发式
  }
}

// ── SessionManager ────────────────────────────────
class SessionManager extends EventEmitter {
  constructor() {
    super()
    this.sessions = new Map()
    this.httpBuffer = new Map()        // sessionId → { data, ts, timer }
    this.fileTails = new Map()          // sessionId → FileTail
    this.statusMachines = new Map()     // sessionId → StatusMachine
    this._pollTimer = null
  }

  // ── 工具方法 ──────────────────────────────────────
  _safeGet(obj, pathArr, fallback) {
    return pathArr.reduce((acc, key) => (acc != null ? acc[key] : undefined), obj) ?? fallback
  }

  _now() { return Date.now() }

  // ── 启动 / 停止轮询 ──────────────────────────────
  startPolling() {
    if (this._pollTimer) return
    console.log('[sessions] starting PID poll + cleanup (every 500ms)')
    this._pollTimer = setInterval(() => {
      try { this._pollPidFiles() } catch (e) { console.error('[sessions] poll error:', e.message) }
      try { this._pollTranscriptTails() } catch (e) { console.error('[sessions] transcript error:', e.message) }
      try { this._cleanup() } catch (e) { console.error('[sessions] cleanup error:', e.message) }
    }, TICK_MS)
  }

  stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer)
      this._pollTimer = null
    }
    for (const tail of this.fileTails.values()) {
      tail.close()
    }
    this.fileTails.clear()
    this.statusMachines.clear()
  }

  // ═══════════════════════════════════════════════════
  // PID 文件轮询 — 进程存活的权威来源
  // ═══════════════════════════════════════════════════
  _pollPidFiles() {
    let entries
    try {
      entries = fs.readdirSync(PID_DIR)
    } catch (e) {
      if (e.code !== 'ENOENT') {
        console.error('[sessions] failed to read PID dir:', e.message)
      }
      // sessions 目录不存在 → 没有会话
      return
    }

    const liveIds = new Set()

    for (const filename of entries) {
      if (!PID_FILENAME_RE.test(filename)) continue

      const filePath = path.join(PID_DIR, filename)
      const pidFromName = parseInt(filename.replace('.json', ''), 10)

      let text
      try {
        text = fs.readFileSync(filePath, 'utf-8')
      } catch (e) {
        // 读取失败（可能正在写入）→ 跳过，下次重试
        continue
      }

      // 检查进程存活
      if (!isProcessAlive(pidFromName)) {
        // 进程已死 → 删除 PID 文件
        this._sweepPidFile(filePath)
        continue
      }

      const record = parsePidRecord(text)
      if (!record) continue  // JSON 解析失败 → 跳过（可能正在写入）

      record.pid = pidFromName  // 信任文件名中的 PID

      if (!_loggedPidFields) {
        _loggedPidFields = true
        console.log('[sessions] PID record keys:', Object.keys(JSON.parse(text)).join(', '))
      }

      liveIds.add(record.session_id)
      this._upsertFromPid(record)
    }

    // 当前 sessions map 中有，但 liveIds 中没有 → 进程已退出
    for (const [id, session] of this.sessions) {
      if (!liveIds.has(id) && session.status !== 'stopped') {
        console.log(`[sessions] PID vanished for ${id} → stopped`)
        session.status = 'stopped'
        session.stopped_at = this._now()
        session.stop_reason = session.stop_reason || 'process exited'
        session._just_stopped = true
        setTimeout(() => { session._just_stopped = false }, 3000)
        this.emit('changed', session)
      }
    }
  }

  _sweepPidFile(filePath) {
    try { fs.unlinkSync(filePath) } catch (_) {}
  }

  _upsertFromPid(record) {
    const sid = record.session_id
    let session = this.sessions.get(sid)

    if (!session) {
      session = this._createSession(sid, record)
      this.sessions.set(sid, session)
      // 清除此 session 的 HTTP 缓冲区
      this._flushHttpBuffer(sid)
      // 如果 PID 文件无 status → 开启转录尾随检测 permission-mode
      if (!record.status) {
        this._openTranscriptTail(sid, record.cwd)
      }
    }

    // 更新 PID 权威字段
    session.pid = record.pid
    session.cwd = record.cwd || session.cwd
    session.started_at_ms = record.started_at_ms || session.started_at_ms
    session.pid_status = record.status  // 'busy' | 'idle' | 'waiting' | null
    session.pid_waiting_for = record.waiting_for || null
    if (record.name) session.display_name = session.display_name || record.name

    // 用 PID 状态更新 session.status
    const prevStatus = session.status
    if (record.status === 'waiting') {
      if (session.status !== 'waiting') {
        session._just_waiting = true
        setTimeout(() => { session._just_waiting = false }, 3000)
      }
      session.status = 'waiting'
      session.last_update = this._now()
    } else if (record.status === 'busy') {
      session.status = 'active'
      session.last_update = this._now()
    } else if (record.status === 'idle') {
      session.status = 'idle'
    } else {
      // PID 无 status → 保持 current 或默认 active
      if (!session.pid_status && session.status === 'stopped') {
        session.status = 'active'
      }
    }

    if (prevStatus !== session.status) {
      this.emit('changed', session)
    }
  }

  _createSession(sid, record) {
    console.log(`[sessions] new session from PID: ${sid} (pid ${record.pid})`)
    return {
      session_id: sid,
      pid: record.pid,
      cwd: record.cwd || '',
      display_name: record.name || '',
      status: record.status === 'waiting' ? 'waiting'
            : record.status === 'idle' ? 'idle'
            : 'active',
      model: 'unknown',
      context_pct: 0,
      cost: '',
      duration: '',
      last_event: 'SessionStart',
      last_tool: '',
      recent_tools: [],
      stop_reason: '',
      last_update: this._now(),
      created_at: this._now(),
      stopped_at: null,
      // PID 权威字段
      pid_status: record.status,
      pid_waiting_for: record.waiting_for || null,
      started_at_ms: record.started_at_ms || 0,
      // HTTP 补充字段
      _just_stopped: false,
      _just_waiting: false
    }
  }

  // ═══════════════════════════════════════════════════
  // HTTP 数据 Enrichment（不创建 session）
  // ═══════════════════════════════════════════════════
  enrich(session_id, data) {
    if (!session_id) {
      console.warn('[sessions] ignored event missing session_id')
      return null
    }

    // 首次收到时打印所有 key
    if (data._event && !_loggedHookKeys) {
      _loggedHookKeys = true
      console.log('[sessions] hook keys:', Object.keys(data).join(', '))
    }
    if (!data._event && !_loggedStatusKeys) {
      _loggedStatusKeys = true
      console.log('[sessions] statusLine keys:', Object.keys(data).join(', '))
    }

    const session = this.sessions.get(session_id)

    if (!session) {
      this._bufferHttpEvent(session_id, data)
      return null
    }

    this._applyHttpData(session, data)
    this.emit('changed', session)
    return session
  }

  _bufferHttpEvent(session_id, data) {
    const existing = this.httpBuffer.get(session_id)
    if (existing) {
      clearTimeout(existing.timer)
    }

    const timer = setTimeout(() => {
      this.httpBuffer.delete(session_id)
    }, HTTP_BUFFER_MS)

    this.httpBuffer.set(session_id, { data, ts: this._now(), timer })
  }

  _flushHttpBuffer(session_id) {
    const buffered = this.httpBuffer.get(session_id)
    if (!buffered) return

    clearTimeout(buffered.timer)
    this.httpBuffer.delete(session_id)

    const session = this.sessions.get(session_id)
    if (session) {
      this._applyHttpData(session, buffered.data)
    }
  }

  _applyHttpData(session, data) {
    // 进程 PID 不覆盖，使用 _ppid 作为补充
    if (data._ppid && !session.pid) {
      console.log(`[sessions] pid captured from HTTP for ${session.session_id}: ${data._ppid}`)
      session.pid = data._ppid
    }

    // cwd（HTTP 作为补充，PID 优先）
    if (!session.cwd || session.cwd === '') {
      if (data.cwd) {
        session.cwd = data.cwd
      } else if (data.workspace?.current_dir) {
        session.cwd = data.workspace.current_dir
      }
    }

    // display_name
    const title = data.title || data.display_name || data.session_name
      || data.name || data.project_name || data.workspace_title
      || data.workspace?.title || data.workspace?.name
    if (title && (!session.display_name || session.display_name === '')) {
      session.display_name = title
    }

    // model
    const modelName = this._safeGet(data, ['model', 'display_name'], null)
    if (modelName) session.model = modelName

    // context%
    const pct = this._safeGet(data, ['context_window', 'used_percentage'], null)
    if (pct != null) session.context_pct = Math.round(pct)

    // cost
    if (data.cost != null) session.cost = data.cost
    else if (data.total_cost != null) session.cost = data.total_cost

    // duration
    if (data.duration != null) session.duration = data.duration
    else if (data.session_duration != null) session.duration = data.session_duration

    // hook 事件
    const event = data._event
    if (event) {
      session.last_event = event
      if (event === 'Stop') {
        session.status = 'stopped'
        session.stopped_at = session.stopped_at || this._now()
        session.stop_reason = data.reason || session.stop_reason || ''
        session._just_stopped = true
        setTimeout(() => { session._just_stopped = false }, 3000)
      }
    }

    // tool name
    const toolName = data.tool_name
    if (toolName) {
      session.last_tool = toolName
      session.recent_tools.push(toolName)
      if (session.recent_tools.length > 10) {
        session.recent_tools = session.recent_tools.slice(-10)
      }
    }

    session.last_update = this._now()
  }

  // ═══════════════════════════════════════════════════
  // 转录 JSONL 尾随 — 权限检测 fallback
  // ═══════════════════════════════════════════════════
  _openTranscriptTail(sessionId, cwd) {
    const tp = resolveTranscriptPath(cwd, sessionId)
    if (!tp) return

    const tail = new FileTail(tp)
    this.fileTails.set(sessionId, tail)
    this.statusMachines.set(sessionId, new StatusMachine())
  }

  _closeTranscriptTail(sessionId) {
    const tail = this.fileTails.get(sessionId)
    if (tail) tail.close()
    this.fileTails.delete(sessionId)
    this.statusMachines.delete(sessionId)
  }

  _pollTranscriptTails() {
    for (const [id, session] of this.sessions) {
      // 有 PID 权威状态 → 跳过转录检测
      if (session.pid_status && session.status !== 'stopped') continue
      if (session.status === 'stopped') continue

      const tail = this.fileTails.get(id)
      if (!tail) continue

      const progress = tail.poll()
      if (progress.missing) continue

      const machine = this.statusMachines.get(id)
      if (!machine) continue

      if (progress.rotated) {
        machine.reset()
      }

      for (const line of progress.newLines) {
        machine.ingestLine(line)
      }

      const derived = machine.derivedStatus()
      if (derived === 'waiting' && session.status !== 'waiting') {
        session.status = 'waiting'
        session.pid_waiting_for = 'permission required'
        session._just_waiting = true
        setTimeout(() => { session._just_waiting = false }, 3000)
        this.emit('changed', session)
      } else if (!derived && session.status === 'waiting' && !session.pid_status) {
        // waiting 解除 → 回退
        session.status = 'active'
        session.pid_waiting_for = null
        this.emit('changed', session)
      }

      session.last_update = this._now()
    }
  }

  // ═══════════════════════════════════════════════════
  // 定期清理
  // ═══════════════════════════════════════════════════
  _cleanup() {
    const now = this._now()
    for (const [id, session] of this.sessions) {
      // stopped → 过期清除
      if (session.status === 'stopped' && session.stopped_at) {
        if (now - session.stopped_at > EXPIRE_STOPPED_MS) {
          console.log(`[sessions] removing stopped: ${id}`)
          this._closeTranscriptTail(id)
          this.sessions.delete(id)
          this.emit('changed', null)
        }
        continue
      }

      // PID 不存在且非 stopped → 标记为 stopped
      if (session.pid && !isProcessAlive(session.pid)) {
        console.log(`[sessions] process ${session.pid} dead → stopping ${id}`)
        session.status = 'stopped'
        session.stopped_at = now
        session.stop_reason = 'process exited'
        session._just_stopped = true
        setTimeout(() => { session._just_stopped = false }, 3000)
        this.emit('changed', session)
        continue
      }

      // active → idle（仅当无 PID 权威状态）
      if (session.status === 'active' && !session.pid_status) {
        if (now - session.last_update > IDLE_THRESHOLD_MS) {
          session.status = 'idle'
          this.emit('changed', session)
        }
      }

      // idle → 过期清除
      if (session.status === 'idle') {
        if (now - session.last_update > EXPIRE_IDLE_MS) {
          console.log(`[sessions] removing idle: ${id}`)
          this._closeTranscriptTail(id)
          this.sessions.delete(id)
          this.emit('changed', null)
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════
  // 公开 API
  // ═══════════════════════════════════════════════════
  update(session_id, data) {
    // 保持向后兼容：update() → enrich()
    return this.enrich(session_id, data)
  }

  remove(session_id) {
    // 清除对应的 PID 文件
    const session = this.sessions.get(session_id)
    if (session && session.pid) {
      const pidFile = path.join(PID_DIR, `${session.pid}.json`)
      this._sweepPidFile(pidFile)
    }
    this._closeTranscriptTail(session_id)
    this.sessions.delete(session_id)
    this.emit('changed', null)
  }

  getAll() {
    this._cleanup()
    const list = Array.from(this.sessions.values())
    const order = { waiting: 0, active: 1, idle: 2, stopped: 3 }
    list.sort((a, b) => {
      const d = order[a.status] - order[b.status]
      if (d !== 0) return d
      return b.last_update - a.last_update
    })
    return list
  }
}

const manager = new SessionManager()

module.exports = manager
