# Claude Code Monitor

Windows 桌面悬浮窗，统一监控本机所有 Claude Code 会话状态。

无论从 VS Code Terminal、JetBrains Terminal、Windows Terminal、CMD 还是 PowerShell 启动 Claude Code，会话状态都会自动出现在同一个悬浮窗中。

## 工作原理

```
Claude Code 会话
  ├─ statusLine → 上报模型、context%、费用、耗时
  ├─ hooks     → 上报 SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Stop
  ▼
localhost:4317 (内嵌 Express)
  ▼
悬浮窗 (Electron, 置顶 + 半透明 + 可拖拽)
```

核心思路：**不抓屏识别进度**，利用 Claude Code 自带的 statusLine + hooks 机制上报数据。

## 快速开始

### 环境要求

- Windows 10 1809+ (build 17763+)
- Node.js >= 18
- Claude Code 已安装

### 安装

```powershell
cd claude-monitor
powershell -ExecutionPolicy Bypass -File install.ps1
```

安装脚本会：
1. 检测 Node.js 环境
2. 部署 PowerShell 上报脚本到 `~/.claude/`
3. 合并 hooks 和 statusLine 配置到 `~/.claude/settings.json`
4. 安装 npm 依赖
5. 可选创建桌面快捷方式和开机自启

### 启动

```powershell
npm start
```

悬浮窗将出现在屏幕右上角。系统托盘中也会显示图标，右键可显示/隐藏/退出。

## 使用

- **拖拽**：窗口标题栏区域可拖拽移动
- **调整大小**：窗口边缘可拖拽调整
- **透明度**：鼠标移出时半透明，移入时完全显示
- **托盘**：最小化到系统托盘，双击托盘图标恢复显示
- **重置位置**：`Ctrl+Shift+M` 强制将窗口重置到主显示器右上角；或托盘右键菜单选择 "Reset Window Position"
- **多显示器**：窗口位置持久化，断开显示器后自动回退到主显示器

## 卡片展示

每个 Claude Code 会话显示为一张卡片：

- **active** (绿●) — 正在活跃的会话
- **idle** (黄○) — 超过 30 秒无事件
- **stopped** (灰○) — 会话已停止（5 分钟后自动清除）

卡片内容：项目目录、模型、context 使用率、费用、耗时、当前阶段、最近工具调用流。

## 文件结构

```
claude-monitor/
├── package.json
├── main.js              # Electron 主进程 (Express + 窗口 + 托盘)
├── preload.js           # 预加载脚本 (contextBridge)
├── sessions.js          # 会话状态机
├── ui/
│   ├── index.html       # 悬浮窗
│   ├── style.css        # 样式
│   └── renderer.js      # 轮询 + 渲染
├── scripts/
│   ├── report-status.ps1  # statusLine 上报
│   └── report-hook.ps1    # hooks 上报
└── install.ps1          # 一键安装
```

## 故障排查

| 问题 | 解决方案 |
|------|----------|
| 悬浮窗无会话 | `curl http://127.0.0.1:4317/api/sessions` 检测服务 |
| 某会话不显示 | 检查项目 `.claude/settings.local.json` 是否覆盖了 hooks |
| 脚本执行被阻止 | `Set-ExecutionPolicy RemoteSigned -Scope CurrentUser` |
| 端口 4317 被占用 | `netstat -ano \| findstr 4317` |
| 窗口不可见 | `Ctrl+Shift+M` 重置位置，或删除 `%APPDATA%/claude-monitor/config.json` |

### Debug 日志

在 hook command 末尾加 `-Debug` 开关，日志写入 `~/.claude/monitor-debug.log`。
