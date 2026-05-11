// 会话状态机：按 session_id 聚合，维护每个 Claude Code 会话状态
//
// 状态转换：
//   SessionStart / 任意事件  → active (记录父进程 PID)
//   超过 30s 无事件           → idle
//   Stop 事件 / 进程已死      → stopped (Ctrl+C / kill / exit 均立即生效)
//   stopped + 10s            → 从内存清除
//   idle + 3 分钟             → 从内存清除

const { EventEmitter } = require('events')

const IDLE_THRESHOLD_MS = 30 * 1000
const EXPIRE_STOPPED_MS = 10 * 1000        // Stop 后 10 秒清除 (留时间给闪烁+提示音)
const EXPIRE_IDLE_MS = 3 * 60 * 1000       // 闲置 3 分钟清除 (终端强关等无 Stop 的场景)
let _loggedStatusKeys = false
let _loggedHookKeys = false

class SessionManager extends EventEmitter {
  constructor() {
    super()
    this.sessions = new Map()
  }

  _safeGet(obj, path, fallback) {
    return path.reduce((acc, key) => (acc != null ? acc[key] : undefined), obj) ?? fallback
  }

  _now() { return Date.now() }

  update(session_id, data) {
    if (!session_id) {
      console.warn('[sessions] ignored event missing session_id')
      return null
    }

    // 首次收到 statusLine/hook 时打印所有 key, 方便确认 /rename 实际字段名
    if (data._event && !_loggedHookKeys) {
      _loggedHookKeys = true
      console.log('[sessions] hook keys:', Object.keys(data).join(', '))
    }
    if (!data._event && !_loggedStatusKeys) {
      _loggedStatusKeys = true
      console.log('[sessions] statusLine keys:', Object.keys(data).join(', '))
    }

    let session = this.sessions.get(session_id)

    if (!session) {
      session = {
        session_id,
        cwd: '',
        display_name: '',
        status: 'active',
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
        pid: 0
      }
      this.sessions.set(session_id, session)
    }

    if (data._ppid) {
      if (!session.pid) console.log(`[sessions] pid captured for ${session_id}: ${data._ppid}`)
      session.pid = data._ppid
    }

    if (data.cwd) {
      session.cwd = data.cwd
    } else if (data.workspace?.current_dir) {
      session.cwd = data.workspace.current_dir
    }

    // /rename 支持: 尝试所有可能字段名
    const title = data.title || data.display_name || data.session_name
      || data.name || data.project_name || data.workspace_title
      || data.workspace?.title || data.workspace?.name
    if (title) {
      session.display_name = title
    }

    const modelName = this._safeGet(data, ['model', 'display_name'], null)
    if (modelName) session.model = modelName

    const pct = this._safeGet(data, ['context_window', 'used_percentage'], null)
    if (pct != null) session.context_pct = Math.round(pct)

    if (data.cost != null) session.cost = data.cost
    else if (data.total_cost != null) session.cost = data.total_cost

    if (data.duration != null) session.duration = data.duration
    else if (data.session_duration != null) session.duration = data.session_duration

    const event = data._event
    const prevStatus = session.status
    if (event) {
      session.last_event = event

      if (event === 'Stop') {
        session.status = 'stopped'
        session.stopped_at = this._now()
        session.stop_reason = data.reason || ''
      } else {
        session.status = 'active'
        session.last_update = this._now()
      }
    } else {
      session.last_update = this._now()
    }

    const toolName = data.tool_name
    if (toolName) {
      session.last_tool = toolName
      session.recent_tools.push(toolName)
      if (session.recent_tools.length > 10) {
        session.recent_tools = session.recent_tools.slice(-10)
      }
    }

    // 如果转为 stopped，标记为新停止
    if (prevStatus !== 'stopped' && session.status === 'stopped') {
      session._just_stopped = true
      // 2.5s 后清除标记 (给前端足够时间取走标记)
      setTimeout(() => { session._just_stopped = false }, 3000)
    }

    this.emit('changed', session)
    return session
  }

  _cleanup() {
    const threshold = this._now()
    for (const [id, session] of this.sessions) {
      // 1. 已停止 → 过期清除
      if (session.status === 'stopped' && session.stopped_at) {
        if (threshold - session.stopped_at > EXPIRE_STOPPED_MS) {
          this.sessions.delete(id)
          this.emit('changed', null)
        }
        continue
      }

      // 2. 检查进程是否还活着 (处理 Ctrl+C / kill 等非正常退出)
      if (session.pid && !this._processAlive(session.pid)) {
        console.log(`[sessions] process ${session.pid} dead → stopping ${id}`)
        session.status = 'stopped'
        session.stopped_at = this._now()
        session.stop_reason = 'process exited'
        session._just_stopped = true
        setTimeout(() => { session._just_stopped = false }, 3000)
        this.emit('changed', session)
        continue
      }

      // 3. active → idle
      if (session.status === 'active') {
        if (threshold - session.last_update > IDLE_THRESHOLD_MS) {
          session.status = 'idle'
          this.emit('changed', session)
        }
      }

      // 4. idle → 过期清除
      if (session.status === 'idle') {
        if (threshold - session.last_update > EXPIRE_IDLE_MS) {
          this.sessions.delete(id)
          this.emit('changed', null)
        }
      }
    }
  }

  _processAlive(pid) {
    if (!pid || pid <= 0) return true // 没有 PID 信息，假定存活
    try {
      // process.kill(pid, 0) 在 Windows 上检查进程是否存在，不发送信号
      process.kill(pid, 0)
      return true
    } catch (e) {
      return false
    }
  }

  remove(session_id) {
    this.sessions.delete(session_id)
    this.emit('changed', null)
  }

  getAll() {
    this._cleanup()
    const list = Array.from(this.sessions.values())
    const order = { active: 0, idle: 1, stopped: 2 }
    list.sort((a, b) => {
      const d = order[a.status] - order[b.status]
      if (d !== 0) return d
      return b.last_update - a.last_update
    })
    return list
  }
}

const manager = new SessionManager()

// 每 5 秒清理过期会话
setInterval(() => manager._cleanup(), 5000)

module.exports = manager
