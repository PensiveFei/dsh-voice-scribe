# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [0.1.2] — 2026-08-26

### Fixed

- **超大请求体不再挂起**：`readJsonBody` 超限时以哨兵值返回（不再 destroy 流后永久不 resolve），服务端真正返回 413 并关闭连接（此前 SECURITY.md 声称返回 413，实际请求会挂到客户端超时）
- **润色失败不再卡状态条**：浏览器端 `polish()` 内部吞掉网络异常并回退原始转写；`finishWebSpeech` 的调用链补上防御性 `.catch`，杜绝“✨ 润色中…”永久停留与 unhandledrejection
- **cordis.patch.yml 名称同步为 dsh-voice-scribe**（`id: voice-scribe` / `name: 'dsh-voice-scribe'`，与客户端注册 id、服务端 name 一致；此前文件仍是 dsh-voice-input）
- **trustedHosts 校验移到启动期一次完成**：非法配置条目不再让每次 API 请求抛异常（此前在请求热路径里 assert 且位于 try 之外，一条坏配置即 500/挂起全部请求）
- **语言码不再截断**：`zh-CN`→`zh`、`en-US`→`en`，三字母码（如粤语 `yue`）保持完整（此前 `slice(0,2)` 会截成无效的 `yu`）
- **热键不再误触非 composer 输入框**：焦点在搜索框/设置输入框等可编辑元素时按 Alt 不会触发录音；`Alt+空格` 按住重复触发已过滤
- **设置写入校验**：`asrUrl` 必须是 http(s):// 开头；空/纯空白字符串删除对应字段（可借此清除已存 API key）

### Added

- 云端 ASR 配置区新增 **“清除已保存 Key”** 按钮；Base URL 非法时内联报错
- 设置页引擎相关内联警告：浏览器不支持 Web Speech / 云端引擎未配置 key 时提示
- 客户端 abort 信号透传服务端：浏览器断开时立即取消进行中的 ASR / 润色调用
- 状态条增加 `role=status` + `aria-live` 无障碍属性

### Changed

- 纯逻辑（设置读写、信任围栏、请求体读取、ASR 调用、语言码归一化）抽到 `lib/host-utils.js`（零依赖），离线测试改为**真实行为测试**（413 路径、语言码、ASR 错误映射、设置回写等），不再只做源码正则匹配
- `@deepseek-ai/dsh-llm` 改为 **polishText 内懒加载**（首次润色时才 import，Node 缓存其后零开销），`lib/index.js` 不再有顶层外部依赖——离线测试可直接导入它，新增 `polishText` / `handleApi` 行为测试（405/415/400/404/413、设置读写、转写缺 key、润色回退等）

## [0.1.1] — 2026-08-25

### Added

- **设置页 UI**（设置 → 语音输入 / Voice Input）：识别引擎、语言、热键、润色开关，中文/英文双语
- **云端 ASR 配置界面**：切换到云端引擎后显示 Base URL / 模型 / API Key 输入 + 保存按钮（key 只存服务端）

### Fixed

- 设置页显示英文：locale 字典改为按语言嵌套（`{ zh, en }`），label 硬编码中文
- 点击设置选项无反应：设置行加 `useState` tick，变更后立即重渲染
- 客户端注册 id 从 `dsh-voice-input` 改为 `dsh-voice-scribe`（浏览器加载报 “loaded without registering” 的根因）
- 插件自带 cordis.patch.yml 与 tgz 同步为 `dsh-voice-scribe`（避免重装带回旧名）
- 服务端 `name` 从 `dsh-voice-input` 改为 `dsh-voice-scribe`

## [0.1.0] — 2026-08-25

### Added

- 首版：点按 Alt 语音输入（备选 Alt+空格，设置可切换）
- **默认引擎：浏览器内置 Web Speech**（Chrome/Edge，零配置零 key，开箱即用）
- 可选引擎：OpenAI 兼容 ASR 端点（Groq / 硅基流动等，服务端存 key）
- 可选润色：复用 DSH 已配置模型（默认关闭）
- 文本插入输入框光标处，保留草稿
- 持久状态条：录音中/转写中持续显示，插入后自动消失
- 服务端存 key + 路由护栏 + 免责声明 + SECURITY.md

### Fixed

- readJsonBody 兼容 string chunk（DSH 环境 req 流编码差异导致 400）
- Web Speech 转写在 onend 读取结果（避免 stop() 异步竞态取到空文本）
