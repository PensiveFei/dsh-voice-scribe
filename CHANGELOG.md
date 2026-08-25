# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/).

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