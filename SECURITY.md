# 安全说明（Security Policy）

## 报告漏洞 Reporting

请勿在公开 issue 中提交安全问题。通过 GitHub 私有漏洞报告（Security Advisories）提交，或直接邮件仓库维护者。

## 安全设计

### API Key 边界
- ASR API key **只存服务端**：`$DSH_HOME/voice-input.json`（默认 `~/.dsh/voice-input.json`），文件权限 owner-only（POSIX 0600）
- 浏览器页面 JS **永远拿不到** API key：`get-settings` 只返回 `hasKey` 布尔值
- 转写音频只经浏览器 → 本地 host → ASR 服务一条链路，不写日志、不落盘

### 路由护栏
- `/voice-input` 路由只接受回环地址（loopback）或配置的 trustedHosts 来源
- 拒绝跨站请求（`sec-fetch-site: cross-site`）与 origin 不匹配的请求
- 请求体限制 24 MB，超限返回 413

### 润色
- 复用 DSH 已配置的模型与凭据，不新增密钥
- 润色失败时回退原始转写，绝不丢失用户输入

## 已知边界

- 语音内容会发送给你配置的第三方 ASR 服务商（默认 Groq）——这是语音转文字的本质，无法避免
- 麦克风权限由浏览器强制，页面需在安全上下文（localhost / HTTPS）下
