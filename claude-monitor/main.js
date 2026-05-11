const { app, BrowserWindow, Tray, Menu, screen, globalShortcut, nativeImage, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')
const express = require('express')
const sessions = require('./sessions')

// ── 配置路径 ──────────────────────────────────────────────
const CONFIG_DIR = path.join(process.env.APPDATA || '', 'claude-monitor')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')
const PORT = 4317

let mainWindow = null
let tray = null
let isQuitting = false

// ── 配置持久化 ────────────────────────────────────────────
function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true })
  }
}

function loadConfig() {
  try {
    ensureConfigDir()
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'))
    }
  } catch (e) {
    console.error('[config] failed to load:', e.message)
  }
  return {}
}

function saveConfig(config) {
  try {
    ensureConfigDir()
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8')
  } catch (e) {
    console.error('[config] failed to save:', e.message)
  }
}

function saveWindowBounds() {
  if (!mainWindow) return
  const bounds = mainWindow.getBounds()
  const config = loadConfig()
  config.windowBounds = bounds
  saveConfig(config)
}

// ── 窗口创建 ──────────────────────────────────────────────
function getWindowPosition() {
  const config = loadConfig()
  const displays = screen.getAllDisplays()

  if (config.windowBounds) {
    const { x, y, width, height } = config.windowBounds
    for (const display of displays) {
      const { x: dx, y: dy, width: dw, height: dh } = display.workArea
      if (x >= dx && x < dx + dw && y >= dy && y < dy + dh) {
        return { x, y, width, height }
      }
    }
  }

  const primary = screen.getPrimaryDisplay()
  const { width: sw } = primary.workAreaSize
  return { x: sw - 360, y: 20, width: 340, height: 480 }
}

function createWindow() {
  const pos = getWindowPosition()

  mainWindow = new BrowserWindow({
    x: pos.x,
    y: pos.y,
    width: pos.width,
    height: pos.height,
    minWidth: 280,
    minHeight: 300,
    maxHeight: Math.floor(screen.getPrimaryDisplay().workAreaSize.height * 0.7),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js')
    }
  })

  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'))

  mainWindow.on('resize', () => saveWindowBounds())
  mainWindow.on('move', () => saveWindowBounds())

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      mainWindow.hide()
    }
  })
}

// ── 系统托盘 ──────────────────────────────────────────────
function createTray() {
  const icon = buildTrayIcon()
  tray = new Tray(icon)
  tray.setToolTip('Claude Code Monitor')

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show/Hide',
      click: () => {
        if (mainWindow) {
          if (mainWindow.isVisible()) { mainWindow.hide() }
          else { mainWindow.show(); mainWindow.focus() }
        }
      }
    },
    { label: 'Reset Window Position', click: resetWindowPosition },
    { type: 'separator' },
    {
      label: 'Exit',
      click: () => { isQuitting = true; app.quit() }
    }
  ])

  tray.setContextMenu(contextMenu)
  tray.on('double-click', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus() }
  })
}

// 生成 16x16 绿色托盘图标
function buildTrayIcon() {
  const zlib = require('zlib')
  const W = 16, H = 16
  const raw = Buffer.alloc(H * (1 + W * 4))
  for (let y = 0; y < H; y++) {
    const rowOff = y * (1 + W * 4)
    raw[rowOff] = 0
    for (let x = 0; x < W; x++) {
      const p = rowOff + 1 + x * 4
      raw[p] = 0x4C; raw[p + 1] = 0xAF; raw[p + 2] = 0x50; raw[p + 3] = 0xFF
    }
  }
  const deflated = zlib.deflateSync(raw)
  function crc32(buf) {
    let c = 0xFFFFFFFF
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i]
      for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xEDB88320 : 0)
    }
    return (c ^ 0xFFFFFFFF) >>> 0
  }
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
    const t = Buffer.from(type, 'ascii')
    const crcData = Buffer.concat([t, data])
    const c = Buffer.alloc(4); c.writeUInt32BE(crc32(crcData), 0)
    return Buffer.concat([len, t, data, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflated), chunk('IEND', Buffer.alloc(0))
  ])
  return nativeImage.createFromBuffer(png)
}

function resetWindowPosition() {
  if (!mainWindow) return
  const primary = screen.getPrimaryDisplay()
  const { width: sw } = primary.workAreaSize
  mainWindow.setBounds({ x: sw - 360, y: 20, width: 340, height: 480 })
  saveWindowBounds()
  mainWindow.show(); mainWindow.focus()
}

// ── IPC: 前端请求初始数据 ─────────────────────────────────
function setupIPC() {
  ipcMain.handle('get-sessions', () => sessions.getAll())

  ipcMain.handle('remove-session', (event, session_id) => {
    sessions.remove(session_id)
  })

  // 会话变化时推送到前端 (事件驱动, 无轮询)
  sessions.on('changed', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sessions-updated', sessions.getAll())
    }
  })
}

// ── HTTP 服务 ─────────────────────────────────────────────
function startServer() {
  const server = express()
  server.use(express.json({ limit: '512kb' }))

  server.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:4317')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    if (req.method === 'OPTIONS') return res.sendStatus(204)
    next()
  })

  server.post('/claude/status', (req, res) => {
    try {
      sessions.update(req.body.session_id, req.body)
      res.json({ ok: true })
    } catch (e) {
      console.error('[server] /claude/status error:', e.message)
      res.status(400).json({ ok: false, error: e.message })
    }
  })

  server.post('/claude/hook', (req, res) => {
    try {
      sessions.update(req.body.session_id, req.body)
      res.json({ ok: true })
    } catch (e) {
      console.error('[server] /claude/hook error:', e.message)
      res.status(400).json({ ok: false, error: e.message })
    }
  })

  server.get('/api/sessions', (req, res) => {
    try {
      const list = sessions.getAll()
      res.json({ ok: true, sessions: list, count: list.length })
    } catch (e) {
      console.error('[server] /api/sessions error:', e.message)
      res.status(500).json({ ok: false, error: e.message })
    }
  })

  return new Promise((resolve, reject) => {
    const srv = server.listen(PORT, '127.0.0.1', () => {
      console.log(`[server] listening on http://127.0.0.1:${PORT}`)
      resolve(srv)
    })
    srv.on('error', (err) => {
      if (err.code === 'EADDRINUSE') reject(new Error(`Port ${PORT} is already in use`))
      else reject(err)
    })
  })
}

// ── 单实例锁 ──────────────────────────────────────────────
function setupSingleInstance() {
  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) { app.quit() }
  else {
    app.on('second-instance', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.show(); mainWindow.focus()
      }
    })
  }
}

// ── 快捷键 ────────────────────────────────────────────────
function setupShortcuts() {
  globalShortcut.register('Ctrl+Shift+M', resetWindowPosition)
}

// ── 应用生命周期 ──────────────────────────────────────────
app.whenReady().then(async () => {
  setupSingleInstance()
  setupIPC()

  try {
    await startServer()
  } catch (e) {
    console.error('[app] failed to start server:', e.message)
  }

  createWindow()
  createTray()
  setupShortcuts()
})

app.on('window-all-closed', () => {})
app.on('activate', () => { if (mainWindow) mainWindow.show() })

app.on('before-quit', () => {
  isQuitting = true
  saveWindowBounds()
  globalShortcut.unregisterAll()
})
