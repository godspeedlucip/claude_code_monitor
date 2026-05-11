# Claude Code 悬浮管理窗 — 实现方案

## 目标

做一个 Windows 桌面悬浮窗，统一监控本机所有 Claude Code 会话的状态（来自 VS Code Terminal / JetBrains Terminal / Windows Terminal / CMD / PowerShell 等任意入口）。

> **与 readme 的关系**：readme 是目标规格说明，本文档是其细化实现方案。readme 的四条关键警告已全部纳入设计：
> 1. 不用窗口标题/进程名判断进度 → 核心架构前提（statusLine + hooks 驱动）
> 2. 用 session_id 聚合 → 会话状态机（第二层）
> 3. 不上报完整 prompt/文件内容/diff → 数据安全原则（第一层末尾）
> 4. 进度条改为阶段+活动流 → 不做 0-100% 进度条（UI 设计）
>
> **与 readme 的主要差异及原因**：
> - readme 推荐 Tauri 优先；本方案采用 Electron MVP → Tauri v1.0 两阶段策略（先快速验证，再轻量化）
> - readme 将 localhost 服务与 UI 分为独立组件；本方案 MVP 阶段合并为一个进程（简化部署），概念层保持分离
> - readme 的 settings.json hook 格式使用了 plugin 双层嵌套（`hooks.json` 格式）；本方案修正为 User Settings 单层格式
> - readme 的 matcher 为 `".*"`（匹配所有工具）；本方案缩小为关键工具子集（减少 80%+ PowerShell 调用）

---

## 环境要求

| 组件 | 要求 | 说明 |
|------|------|------|
| Windows | 10 1809+ (build 17763+) 或 Server 2019+ | Claude Code 官方支持的最低版本 |
| Git for Windows | 推荐安装 | Claude Code 优先使用 Git Bash；无 Git Bash 时回退 PowerShell |
| Node.js | >= 18（MVP）/ v1.0 Tauri 无需 | Electron 运行时依赖 |
| Claude Code | 已安装，`claude` 命令可用 | 否则无数据来源 |
| PowerShell | 5.1+ | Windows 10 内置，无需额外安装 |

---

## 架构概览

```
任意入口启动 claude
VS Code Terminal / JetBrains Terminal / Windows Terminal / CMD / PowerShell
        │
        ▼
Claude Code 会话
        │
        ├─ statusLine：事件驱动上报目录、模型、context%、费用、耗时
        ├─ hooks：上报 SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Stop
        ▼
本机 localhost HTTP 服务 (127.0.0.1:4317)
按 session_id 聚合，维护会话状态机
        │
        ▼
悬浮窗 UI (置顶 + 半透明 + 可拖拽 + 托盘)
每秒轮询 GET /api/sessions 刷新卡片
```

核心思路：**不抓屏识别进度**，而是利用 Claude Code 自带的 statusLine + hooks 机制上报数据。

> **实现合并**：readme 中 localhost 服务与悬浮窗 UI 是独立组件。为简化部署（减少一个独立进程），本方案将 HTTP 服务内嵌于 Electron 主进程。两者在**概念上分离**（服务层可独立测试），在**部署上合并**（一个 .exe 包含全部）。若后续切换到 Tauri，服务层需独立为 Rust HTTP server。

### 组件映射

| 概念层 | readme 描述 | 本方案实现 |
|--------|-----------|-----------|
| 数据上报 | PowerShell 脚本 | `report-status.ps1` + `report-hook.ps1` |
| localhost 服务 | 独立 Node.js/Python/Go 进程 | Electron 主进程内嵌 Express |
| 悬浮窗 UI | Tauri/Electron/AHK/WPF | Electron BrowserWindow |
| 会话管理 | 按 session_id 聚合 | sessions.js 状态机 |

---

## 分层设计

### 第一层 — 数据上报

#### 配置 `~/.claude/settings.json`

**重要**：用户级 settings.json 使用 User Settings 格式，事件数组内**不需要** plugin 格式的 `"hooks"` 双层嵌套 wrapper。每个事件直接映射到 hook 配置对象数组。

```json
{
  "statusLine": {
    "type": "command",
    "command": "powershell -NoProfile -ExecutionPolicy Bypass -File C:/Users/<用户名>/.claude/report-status.ps1"
  },
  "hooks": {
    "SessionStart": [
      {
        "type": "command",
        "shell": "powershell",
        "command": "powershell -NoProfile -ExecutionPolicy Bypass -File C:/Users/<用户名>/.claude/report-hook.ps1 SessionStart",
        "timeout": 10
      }
    ],
    "UserPromptSubmit": [
      {
        "type": "command",
        "shell": "powershell",
        "command": "powershell -NoProfile -ExecutionPolicy Bypass -File C:/Users/<用户名>/.claude/report-hook.ps1 UserPromptSubmit",
        "timeout": 10
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Write|Edit|Bash|TaskCreate|Agent|NotebookEdit",
        "type": "command",
        "shell": "powershell",
        "command": "powershell -NoProfile -ExecutionPolicy Bypass -File C:/Users/<用户名>/.claude/report-hook.ps1 PreToolUse",
        "timeout": 10
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Write|Edit|Bash|TaskCreate|Agent|NotebookEdit",
        "type": "command",
        "shell": "powershell",
        "command": "powershell -NoProfile -ExecutionPolicy Bypass -File C:/Users/<用户名>/.claude/report-hook.ps1 PostToolUse",
        "timeout": 10
      }
    ],
    "Stop": [
      {
        "type": "command",
        "shell": "powershell",
        "command": "powershell -NoProfile -ExecutionPolicy Bypass -File C:/Users/<用户名>/.claude/report-hook.ps1 Stop",
        "timeout": 15
      }
    ]
  }
}
```

**与 readme 原方案的关键区别：**
- 去掉了事件数组内多余的 `"hooks"` wrapper（那是 plugin 格式，用于 `hooks.json`，不用于用户 `settings.json`）
- `matcher` 从 `".*"` 缩小为 `"Write|Edit|Bash|TaskCreate|Agent|NotebookEdit"`，避免每次 Read/Grep 都启动 PowerShell
- 所有 hook 显式加了 `timeout`（秒），防止脚本 hang 阻塞 Claude Code

#### statusLine 更新频率说明

statusLine **不是持续轮询**，而是事件驱动触发：
- 新 assistant 消息产生时
- context compaction 完成时
- 权限模式变更时

在 Claude Code 长时间思考或执行工具期间，statusLine 不会更新。悬浮窗需通过 hooks 事件（PreToolUse/PostToolUse）来判断会话仍在活跃。

#### PowerShell 上报脚本

`report-status.ps1` — statusLine 数据上报（带 debug 日志和 stdin 超时保护）：

```powershell
param([switch]$Debug)

# 读取 stdin，最多等 2 秒防止永久阻塞
$inputJson = $null
try {
  $stdinTask = [System.Threading.Tasks.Task]::Run({ [Console]::In.ReadToEnd() })
  if ($stdinTask.Wait(2000)) {
    $inputJson = $stdinTask.Result
  } else {
    if ($Debug) {
      $logDir = "$env:USERPROFILE\.claude"
      Add-Content "$logDir\monitor-debug.log" "[$(Get-Date -Format 's')] statusLine stdin timeout"
    }
    Write-Output "Claude monitor"
    exit 0
  }
} catch {
  if ($Debug) {
    Add-Content "$env:USERPROFILE\.claude\monitor-debug.log" "[$(Get-Date -Format 's')] statusLine read error: $_"
  }
  Write-Output "Claude monitor"
  exit 0
}

# HTTP 上报
try {
  Invoke-RestMethod `
    -Uri "http://127.0.0.1:4317/claude/status" `
    -Method Post `
    -ContentType "application/json" `
    -Body $inputJson `
    -TimeoutSec 1 | Out-Null
} catch {
  if ($Debug) {
    Add-Content "$env:USERPROFILE\.claude\monitor-debug.log" "[$(Get-Date -Format 's')] statusLine HTTP fail: $_"
  }
}

# 返回 Claude Code statusLine 显示内容
try {
  $data = $inputJson | ConvertFrom-Json
  $model = $data.model.display_name
  $dir = Split-Path $data.workspace.current_dir -Leaf
  $pct = [int]($data.context_window.used_percentage)
  Write-Output "[$model] $dir | context ${pct}%"
} catch {
  Write-Output "Claude monitor active"
}
```

`report-hook.ps1` — 生命周期事件上报（带 debug 日志和 stdin 超时保护）：

```powershell
param(
  [string]$EventName,
  [switch]$Debug
)

$inputJson = $null
try {
  $stdinTask = [System.Threading.Tasks.Task]::Run({ [Console]::In.ReadToEnd() })
  if ($stdinTask.Wait(2000)) {
    $inputJson = $stdinTask.Result
  } else {
    if ($Debug) {
      Add-Content "$env:USERPROFILE\.claude\monitor-debug.log" "[$(Get-Date -Format 's')] hook $EventName stdin timeout"
    }
    exit 0
  }
} catch {
  if ($Debug) {
    Add-Content "$env:USERPROFILE\.claude\monitor-debug.log" "[$(Get-Date -Format 's')] hook $EventName read error: $_"
  }
  exit 0
}

try {
  $obj = $inputJson | ConvertFrom-Json
  $obj | Add-Member -NotePropertyName "_event" -NotePropertyValue $EventName -Force
  $body = $obj | ConvertTo-Json -Depth 20 -Compress

  Invoke-RestMethod `
    -Uri "http://127.0.0.1:4317/claude/hook" `
    -Method Post `
    -ContentType "application/json" `
    -Body $body `
    -TimeoutSec 1 | Out-Null
} catch {
  if ($Debug) {
    Add-Content "$env:USERPROFILE\.claude\monitor-debug.log" "[$(Get-Date -Format 's')] hook $EventName HTTP fail: $_"
  }
}

exit 0
```

**数据安全原则**：脚本只传元信息（session_id、cwd、事件类型、工具名），不上报完整 prompt、文件内容、diff。

**编码处理**：Windows 中文用户名或项目路径含非 ASCII 字符时，PowerShell 默认编码可能不一致。两个上报脚本开头应显式设置：

```powershell
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
```

`Invoke-RestMethod` 也需显式指定 `-ContentType "application/json; charset=utf-8"`。需在中文用户名和含空格路径的环境下测试通过。

---

### 第二层 — 本地 HTTP 服务（内嵌于 Electron 主进程）

与 readme 中独立 Node.js 服务的方案不同，此处将 Express 服务**集成进 Electron 主进程**，减少一个独立进程和部署复杂度。

- 监听 `127.0.0.1:4317`
- 两个接收端点：
  - `POST /claude/status` — 接收 statusLine 数据
  - `POST /claude/hook` — 接收 hook 事件数据
- 一个查询端点：
  - `GET /api/sessions` — 返回所有会话快照（供前端轮询）
- 核心逻辑：按 `session_id` 聚合，维护每个会话的状态

#### 会话状态机

```
SessionStart 事件  → status = "active", last_event_at = now
任意 hook/status   → status = "active", last_event_at = now
超过 30s 无事件    → status = "idle"
Stop 事件          → status = "stopped", stopped_at = now
stopped + 5 分钟   → 从内存清除
```

#### 会话状态字段

| 字段 | 来源 | 说明 |
|------|------|------|
| session_id | hooks/statusLine 公共字段 | 唯一标识 |
| cwd | workspace.current_dir | 项目目录 |
| status | hooks 推断（状态机） | active / idle / stopped |
| model | statusLine | 当前模型 display_name |
| context_pct | statusLine | context 使用百分比 |
| cost | statusLine | 累计费用 |
| duration | statusLine | 会话耗时 |
| last_event | hooks _event 字段 | 最近事件类型 |
| last_tool | PreToolUse/PostToolUse | 最近工具名 |
| recent_tools | hooks（最近 10 条） | 工具调用序列 |
| stop_reason | Stop 事件的 reason 字段 | 停止原因（如有） |
| last_update | 本地时间戳 | 最后更新时间 |
| ide_source | 父进程链探测（实验性） | VS Code / JetBrains / Terminal / Unknown |

#### IDE / 终端来源检测

Claude Code 不原生暴露启动 IDE 信息。MVP 阶段采用**父进程链启发式探测**：在 `report-hook.ps1` 的 SessionStart 事件中，通过 PowerShell 获取父进程名：

```powershell
$parentPid = (Get-CimInstance Win32_Process -Filter "ProcessId=$pid").ParentProcessId
$grandparentPid = (Get-CimInstance Win32_Process -Filter "ProcessId=$parentPid").ParentProcessId
$grandparentName = (Get-Process -Id $grandparentPid -ErrorAction SilentlyContinue).ProcessName
```

匹配规则：`code` / `code-oss` → VS Code，`idea64` / `jetbrains` → JetBrains，`WindowsTerminal` → Windows Terminal，`cmd` → CMD，`powershell` / `pwsh` → PowerShell。无法识别时显示 "Unknown terminal"。此功能标记为**实验性**，不影响核心数据链路。

---

### 第三层 — 悬浮窗 UI

#### 技术选型

readme 中技术栈优先级为 **Tauri > Electron > WPF > AutoHotkey**。本方案遵循此优先级，采用**两阶段策略**：

**阶段 A — MVP（Electron，v0.5）**：快速验证数据链路和交互设计。
**阶段 B — 正式版（Tauri，v1.0）**：轻量化常驻悬浮窗。

| 维度 | Tauri (v1.0 目标) | Electron (v0.5 MVP) | 结论 |
|------|-------------------|---------------------|------|
| 内存占用 | 低（Rust 原生，~30MB） | 较高（Chromium，~150MB） | Tauri 更适合常驻悬浮窗 |
| Windows 兼容 | WebView2（Win10 1809+ 已内置） | 自带 Chromium | 目标 Windows 版本均支持 WebView2 |
| 开发速度 | 需 Rust 工具链 + HTTP crate | JS/HTML/CSS 直接开发 | Electron 更快出 MVP |
| HTTP 服务 | 需独立 Rust HTTP server（axum/actix-web） | 直接复用 Node.js Express | Electron 内嵌更简单 |
| 打包体积 | ~5-10MB | ~150MB | Tauri 显著更小 |
| 社区生态 | Tauri 2.0 已稳定（2025+） | 最成熟 | 差距缩小中 |

**选择两阶段策略的理由**：
- **MVP 用 Electron**：可在 1-2 天内完成数据链路验证和 UI 迭代；Express 内嵌无需额外引入 Rust HTTP 库
- **v1.0 切 Tauri**：前端 HTML/CSS/JS 可直接复用（Tauri 同样使用 Web 前端）；仅需将 Express 服务逻辑重写为 Rust HTTP server（约 200 行）
- 两者前端代码完全共享，切换成本集中在服务层重写

#### MVP 安全配置（Electron）

```js
// main.js — BrowserWindow 创建
const mainWindow = new BrowserWindow({
  webPreferences: {
    contextIsolation: true,    // 渲染进程隔离
    nodeIntegration: false,    // 禁止渲染进程访问 Node API
    sandbox: true,             // 沙箱模式
    preload: path.join(__dirname, 'preload.js')
  }
})
```

- preload.js 仅通过 `contextBridge.exposeInMainWorld` 暴露 `window.monitorAPI.fetchSessions()` 轮询函数
- index.html 添加 CSP meta 标签：`<meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src http://127.0.0.1:4317; style-src 'self' 'unsafe-inline'">`
- 禁用 `remote` 模块，禁用 `webSecurity: false`

> **v1.0 Tauri**：安全模型更强。Tauri 2.0 默认禁用 Node.js，CSP 通过 `tauri.conf.json` 配置，IPC 通过 `invoke` 以白名单暴露。

#### 关键实现点

**窗口属性（Electron MVP → Tauri v1.0 均支持）：**
- 窗口置顶 (`alwaysOnTop: true` / Tauri: `alwaysOnTop: true`)
- 半透明背景、无边框 (`frame: false`)；默认透明度 0.92，鼠标悬停 CSS transition 过渡到 1.0
- 默认窗口尺寸：340×480px；最小尺寸：280×300px；最大高度：`screen.availHeight * 0.7`
- 可拖拽（CSS `-webkit-app-region: drag`）
- 系统托盘图标，右键菜单：显示/隐藏/退出
- 窗口位置持久化（关闭时保存到 `%APPDATA%/claude-monitor/config.json`；Tauri 通过 `tauri-plugin-store` 实现）

**多显示器处理：**
- 启动时用 `screen.getAllDisplays()` 校验保存的窗口位置；若所在显示器已断开，回退到主显示器右上角
- 首次启动定位到主显示器右上角（`x: screen.primaryDisplay.workAreaSize.width - 360, y: 20`）
- 恢复快捷键 `Ctrl+Shift+M`：强制将窗口重置到主显示器（Electron: `globalShortcut.register` / Tauri: `tauri-plugin-global-shortcut`）
- 禁用 DPI 感知或显式设置 `highDpiSupport` 以确保跨缩放比例渲染正常

**单实例锁（Electron MVP）：**
```js
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })
}
```

> **v1.0 Tauri**：Tauri 2.0 内置单实例支持，通过 `tauri.conf.json` 中 `"identifier"` 自动处理，无需手动编码。

**前端刷新（Electron MVP / Tauri v1.0 通用）：**
- 每秒轮询 `GET /api/sessions` 刷新卡片
- Tauri 可选改为 `invoke` IPC（减少 HTTP 开销），但 HTTP 轮询在两平台均可用
- 轮询失败时显示"服务不可用"提示，而非白屏

**端口冲突检测（Electron MVP / Tauri v1.0 通用）：**
- 启动时先检测 4317 端口是否被占用
- 若被占用且非本进程，弹窗提示用户

#### UI 设计

- 窗口置顶 + 半透明背景 + 无边框可拖拽
- 系统托盘图标，右键菜单：显示/隐藏/退出
- 前端每秒轮询 `GET /api/sessions` 刷新
- 每个会话一张卡片：

```
Claude Code Monitor

● active  my-project
  C:\repo\my-project
  Sonnet 4.5 | context 37% | $0.42 | 12m
  当前阶段：PostToolUse: Edit
  最近工具：Read → Edit → Bash
  最后更新：3s ago

○ idle  backend-api
  D:\work\backend-api
  context 64%
  当前阶段：Stop (reason: Task complete)
```

#### 卡片展示字段

| 字段 | 可行性 | 说明 |
|------|--------|------|
| 会话状态指示灯 | 高 | active(绿●) / idle(黄○) / stopped(灰○) |
| 项目目录 | 高 | 来自 cwd |
| 模型 + context% + 费用 + 耗时 | 高 | statusLine 原生支持 |
| 当前阶段 | 高 | hooks 事件推断 |
| 最近工具调用流 | 中高 | PreToolUse/PostToolUse 提取工具名 |
| 停止原因 | 中 | Stop 事件的 reason 字段 |
| 最后更新时间 | 高 | 本地时间戳 |

**不做 0-100% 进度条** — Claude Code 没有暴露任务总长度，百分比容易误导。用阶段 + 活动流代替。

#### 卡片排序与布局

- **排序**：active(绿●) > idle(黄○) > stopped(灰○)，同状态按 `last_update` 降序排列
- **窗口布局**：标题栏固定 (`position: sticky`)，卡片区域 `overflow-y: auto`
- **stopped 会话**：默认折叠为单行（`● stopped my-project — 3 min ago`），点击展开查看详情
- **配置化**：config.json 预留 `sortOrder` 和 `showStopped` 偏好项

#### 格式兼容性（防御性解析）

Claude Code 未来可能调整 JSON schema。sessions.js 和 PowerShell 脚本应使用防御性属性访问：

```js
// sessions.js — 安全提取
const model = data?.model?.display_name ?? 'unknown'
const cwd = data?.workspace?.current_dir ?? ''
const pct = data?.context_window?.used_percentage ?? 0
```

- 最低要求：收到的 JSON 必须有 `session_id` 字段，否则记录警告并忽略
- PowerShell 脚本已有的 try/catch 继续保留
- 若 Claude Code 大版本更新改变 schema，需同步更新字段路径

---

## 关键设计决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 服务架构 | MVP: Electron 内嵌 Express / v1.0: Tauri + Rust HTTP | 两阶段：先快速验证，再轻量化 |
| 前端框架 | 原生 JS/HTML/CSS | 无需构建工具链，Tauri/Electron 均直接复用 |
| 通信方式 | HTTP + 前端轮询 1s | 足够轻量，无需 WebSocket |
| hooks 格式 | User Settings 格式（无双层嵌套） | 与 Claude Code settings.json 文档一致 |
| matcher 范围 | Write\|Edit\|Bash\|TaskCreate\|Agent\|NotebookEdit | 过滤高频低价值工具（Read/Grep），减少 80%+ PowerShell 调用 |
| 会话状态判定 | 事件驱动的状态机 | 明确 active/idle/stopped 边界 |
| 会话过期策略 | stopped 5 分钟后自动清除 | 避免卡片堆积 |
| 窗口方案 | 置顶 + 无边框 + 可拖拽 + 托盘 | 悬浮窗标准做法 |
| 单实例 | app.requestSingleInstanceLock() | 防止多实例端口冲突 |
| 排除的 hooks | 不含 Notification / PreCompact / PostCompact / Result | Notification 仅 UI 通知无结构化数据；PreCompact/PostCompact 因 statusLine 已提供 context% 并在 compact 完成后自动更新；Result 因 Stop 事件已覆盖会话终止。v2 可加入 compact 可视化 |

---

## 项目结构

### MVP（Electron，v0.5）

```
claude-monitor/
├── package.json              # Electron + Express 依赖
├── main.js                   # Electron 主进程：Express 服务 + 窗口管理 + 托盘 + 单实例锁
├── preload.js                # 预加载脚本
├── sessions.js               # 会话状态管理（状态机 + 按 session_id 聚合 + 过期清理）
├── ui/
│   ├── index.html            # 悬浮窗 UI
│   ├── style.css             # 卡片样式
│   └── renderer.js           # 轮询 + 渲染卡片
├── scripts/
│   ├── report-status.ps1     # statusLine 上报脚本
│   └── report-hook.ps1       # hooks 上报脚本
├── install.ps1               # 一键安装脚本
└── README.md                 # 使用说明
```

### v1.0 目标（Tauri）

```
claude-monitor/
├── src-tauri/                # Tauri Rust 后端
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── src/
│       ├── main.rs           # Tauri 入口 + HTTP server（axum）+ 会话状态机
│       └── sessions.rs       # 会话管理（从 sessions.js 移植）
├── ui/                       # 前端（从 MVP 直接复用）
│   ├── index.html
│   ├── style.css
│   └── renderer.js
├── scripts/                  # PowerShell 上报脚本（不变）
│   ├── report-status.ps1
│   └── report-hook.ps1
├── install.ps1               # 一键安装脚本
└── README.md
```

### 依赖清单

**MVP（Electron）**：

| 包名 | 版本范围 | 用途 |
|------|---------|------|
| electron | ^28.0.0 | 桌面窗口 + 系统托盘 |
| express | ^4.18.0 | 内嵌 HTTP 服务 |

仅 2 个运行时依赖。`body-parser` 已内置于 Express 4.16+，无需额外安装。

**v1.0（Tauri）**：

| 包名 | 版本范围 | 用途 |
|------|---------|------|
| tauri | ^2.0 | 桌面框架 |
| axum | ^0.7 | Rust HTTP 服务 |
| serde / serde_json | ^1 | JSON 序列化 |
| tokio | ^1 | 异步运行时 |

前端零 npm 依赖（Tauri 通过 Rust 暴露 API 到 WebView）。

---

## 实现顺序

### MVP（Electron，目标 1-2 天）

1. **数据链路验证** — 写 PowerShell 脚本 + Express 服务（先独立运行）+ 手动 curl 测试
2. **Electron 集成** — 将 Express 嵌入 Electron 主进程，实现空窗口 + 轮询 + 展示原始 JSON
3. **会话状态机** — 实现 sessions.js，处理 SessionStart → active → idle → Stop → 过期清理
4. **打磨 UI** — 卡片布局、状态指示灯、置顶/拖拽/半透明/托盘/位置记忆
5. **安装脚本** — install.ps1：检测环境、合并 settings.json、部署脚本、可选开机自启
6. **异常处理完善** — 服务未启动悬浮窗提示、端口冲突检测、轮询失败降级 UI

### v1.0（Tauri，MVP 验证后）

7. **Rust 服务层** — axum HTTP server 替代 Express，sessions.js → sessions.rs 移植
8. **Tauri 集成** — 窗口管理、托盘、单实例锁用 Tauri Rust API
9. **前端适配** — renderer.js 中 `fetch` 改为 Tauri `invoke`（或保留 HTTP 轮询）
10. **打包发布** — `tauri build` 生成 .msi，GitHub Releases 发布

---

## 验证与测试计划

### 单元测试（sessions.js 状态机）

| 测试用例 | 输入 | 期望输出 |
|---------|------|---------|
| 新会话启动 | POST SessionStart hook（新 session_id） | status=active，创建会话记录 |
| 会话变空闲 | 超过 30s 无任何事件 | status 从 active 变为 idle |
| 会话停止 | POST Stop hook | status=stopped，记录 stopped_at |
| 过期清除 | stopped 状态超过 5 分钟 | 从内存中移除 |
| 未知 session_id 收到 statusLine | POST /claude/status（未见过 session_id） | 新建会话（首次 statusLine 可能先于 SessionStart） |
| 缺少 session_id | POST 无 session_id 字段的 JSON | 记录警告，忽略该条数据 |

### 集成测试（curl）

```bash
# 测试 statusLine 端点
curl -X POST http://127.0.0.1:4317/claude/status \
  -H "Content-Type: application/json" \
  -d '{"session_id":"test-1","model":{"display_name":"Sonnet 4.5"},"workspace":{"current_dir":"C:/test"},"context_window":{"used_percentage":42}}'

# 测试 hook 端点
curl -X POST http://127.0.0.1:4317/claude/hook \
  -H "Content-Type: application/json" \
  -d '{"session_id":"test-1","cwd":"C:/test","_event":"PreToolUse","tool_name":"Write"}'

# 验证查询端点
curl http://127.0.0.1:4317/api/sessions
# 期望：返回包含 test-1 会话的 JSON 数组
```

### 手动验证清单

1. 启动 Electron 应用，确认悬浮窗出现
2. curl 模拟 statusLine + hook POST，确认卡片出现并显示正确数据
3. 停止 POST 30s，确认卡片状态变为 idle（黄○）
4. 发送 Stop 事件，确认卡片变为 stopped（灰○）
5. 等待 5 分钟，确认 stopped 卡片自动清除
6. 关闭重开应用，确认窗口位置恢复
7. 使用真实 Claude Code 会话测试端到端链路

### 验收标准

- [ ] 悬浮窗可正常启动、置顶、拖拽、最小化到托盘
- [ ] 多会话卡片正确显示和排序
- [ ] 会话状态机 active/idle/stopped 转换正确
- [ ] 安装脚本一键部署成功（干净环境和已配置环境均测试）
- [ ] 不影响 Claude Code 正常运行（脚本不 hang、不超时阻塞）

## 错误处理矩阵

| 场景 | 处理方式 |
|------|----------|
| localhost 服务未启动 | 悬浮窗显示"服务未启动 — 请运行 claude-monitor" |
| PowerShell ExecutionPolicy 阻止脚本 | install.ps1 检测并提示用户修改策略 |
| settings.json 格式错误 | install.ps1 做 JSON 语法校验 + 备份 |
| 端口 4317 被占用 | 启动时检测，弹窗提示关闭占用进程 |
| stdin 无输入（脚本被空调用） | PowerShell 脚本 2s 超时静默退出 |
| HTTP 请求超时/失败 | PowerShell 静默处理（catch {}），debug 模式写日志 |
| 多实例启动 | 单实例锁拒绝，聚焦已有窗口 |
| 多个会话同目录 | 按 session_id 区分，卡片显示完整路径 |
| 用户已有自定义 statusLine | install.ps1 检测冲突，不覆盖，交互式提示用户选择 |
| 项目级 settings.local.json 覆盖了 hooks | install.ps1 扫描常见项目路径，警告可能冲突 |
| 中文用户名/路径编码异常 | PowerShell 脚本强制 UTF-8 编码 |

---

## 与项目级配置的交互

Claude Code 支持 settings 层级：项目级 `.claude/settings.json` / `.claude/settings.local.json` 会覆盖用户级 `~/.claude/settings.json`。

- **风险**：若某项目的 `.claude/settings.json` 也配置了 hooks，则全局 monitor hooks **不会**对该项目生效（项目级完全替换用户级 hooks）
- **缓解**：install.ps1 安装后提示用户："若项目有自己的 `.claude/settings.local.json` 且含 hooks 配置，请手动将 monitor hooks 追加到该项目配置中"
- **诊断**：`GET /api/sessions` 的返回可辅助判断——若某已知活跃的 Claude Code 会话未出现在列表中，大概率是项目级配置覆盖了全局 hooks

---

## install.ps1 设计

```
install.ps1 执行流程：
1. 检测 Node.js >= 18（MVP 需要；若已安装 Tauri 版则可跳过）
2. 检测 PowerShell ExecutionPolicy，RemoteSigned 以下给出警告和修改建议
3. 读取 ~/.claude/settings.json：
   - 不存在 → 创建新文件
   - 已存在 → 备份为 settings.json.bak.<timestamp>，深度合并 monitor 配置
4. JSON 语法校验（合并后）
5. 复制 report-status.ps1、report-hook.ps1 到 ~/.claude/
6. npm install（MVP Electron 依赖；v1.0 Tauri 版不需要此步骤）
7. 询问是否创建桌面快捷方式
8. 询问是否设为开机自启（写入 HKCU\Software\Microsoft\Windows\CurrentVersion\Run）
9. 启动 claude-monitor
```

合并逻辑核心原则：**只添加 monitor 需要的配置项，不覆盖用户已有的其他 hooks/statusLine 配置**。

**hooks 合并规则**：
- 若用户已有同名 hook 事件配置 → 将 monitor 的 hook 追加到数组末尾
- 若用户无该事件配置 → 创建新数组

**statusLine 合并规则**（重要 — statusLine 是单对象，非数组）：
- 若用户 settings.json 无 `statusLine` key → 添加 monitor 的 statusLine 配置
- 若用户已有 `statusLine` → **不覆盖**。交互式提示用户：
  1. **Skip** — 保留用户现有 statusLine，monitor 仍可通过 hooks 获取部分信息（推荐）
  2. **Overwrite** — 用 monitor 的 statusLine 替换（会丢失用户原有 statusLine）
  3. **Abort** — 终止安装，用户自行决定

**项目级配置扫描**（可选步骤）：
- 扫描 `~/projects/` 等常见路径下的 `.claude/settings.json` 和 `.claude/settings.local.json`
- 若发现含 hooks 或 statusLine 配置的文件，提示用户手动追加 monitor 配置

---

## 分发与打包

| 阶段 | 方式 | 说明 |
|------|------|------|
| MVP | 源码分发 + install.ps1 | 用户需 Node.js >= 18；install.ps1 运行 `npm install && npm start` |
| v1.0 | Tauri `tauri build` 生成 .msi/.exe | 免除 Node.js 运行时依赖；单文件 ~10MB |
| v1.0+ | Tauri updater 自动更新 | 从 GitHub Releases 拉取新版本 |

## Electron → Tauri 迁移地图

MVP 验证完数据链路和 UI 交互后，v1.0 切换路径：

| MVP 组件 | v1.0 替代 | 迁移量 |
|---------|----------|--------|
| `main.js`（窗口+托盘） | `src-tauri/src/main.rs` + `tauri.conf.json` | 约 150 行 Rust |
| Express 路由 (`/claude/status`, `/claude/hook`, `/api/sessions`) | axum Router | 约 100 行 Rust |
| `sessions.js`（状态机） | `src-tauri/src/sessions.rs` | 逻辑 1:1 移植 |
| `ui/`（HTML/CSS/JS） | 直接复用 | 零改动 |
| `preload.js` | Tauri `invoke` / `window.__TAURI__` | 约 10 行适配 |
| `scripts/*.ps1` | 不变 | 零改动 |

---

## 托盘通知（v2 增强）

- Stop 事件收到时弹出托盘气泡通知："Session 'my-project' stopped (reason: Task complete)"
- config.json 控制：`{"notifications": {"onStop": true, "onIdle": false}}`
- Electron: `Tray.displayBalloon()` 或 `Notification` API / Tauri: `tauri-plugin-notification`

---

## 故障排查

### 启用 Debug 日志

在 `~/.claude/settings.json` 的 hook command 中添加 `-Debug` 开关：
```
"command": "powershell ... -File C:/Users/<用户名>/.claude/report-hook.ps1 SessionStart -Debug"
```

日志写入 `~/.claude/monitor-debug.log`。

### 常见问题

| 症状 | 可能原因 | 解决步骤 |
|------|---------|---------|
| 悬浮窗无任何会话卡片 | 服务未启动或端口被占用 | `curl http://127.0.0.1:4317/api/sessions` 检测服务是否响应 |
| 某已知会话不出现 | 项目级 settings 覆盖了 hooks | 检查项目 `.claude/settings.local.json` 是否含 hooks 配置 |
| PowerShell 脚本报错 | ExecutionPolicy 阻止 | `Get-ExecutionPolicy`；若 Restricted，运行 `Set-ExecutionPolicy RemoteSigned -Scope CurrentUser` |
| 中文路径乱码 | 编码不一致 | 确认脚本中已设置 UTF-8 编码；检查 `monitor-debug.log` |
| 悬浮窗在屏幕外不可见 | 保存的位置对应已断开显示器 | 按 `Ctrl+Shift+M` 重置窗口到主显示器；或删除 `%APPDATA%/claude-monitor/config.json` |
| settings.json 语法错误 | JSON 格式问题 | install.ps1 生成备份 `.bak.<timestamp>`，用 VS Code 格式化检查 |
| 端口 4317 被占用 | 其他进程占用 | `netstat -ano | findstr 4317` 查找占用进程 PID |
