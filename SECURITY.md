# 安全说明（Security Policy）

## 报告漏洞 Reporting

**安全问题也欢迎在公开处讨论**——只有真正的高危漏洞才建议走私有通道：

- **高危 / 可被利用的漏洞**（远程代码执行、密钥泄露、未授权访问、隐私数据外泄等）：请在**修复前**通过 GitHub 私有漏洞报告（[Security Advisories](https://github.com/PensiveFei/dsh-voice-scribe/security/advisories/new)）提交，避免细节提前公开被滥用。
- **一般问题、疑问、或拿不准是不是漏洞**：直接在 [Issues](https://github.com/PensiveFei/dsh-voice-scribe/issues) 公开提问即可——公开讨论没有问题，也欢迎先问再确认。

无论走哪条通道，请尽量提供：复现步骤、影响范围、DSH 版本与插件版本、环境（OS / Node / 浏览器）。

## 安全设计

### API Key 边界
- ASR API key **只存服务端**：`$DSH_HOME/voice-input.json`（默认 `~/.dsh/voice-input.json`），文件权限 owner-only（POSIX 0600）
- 浏览器页面 JS **永远拿不到** API key：`get-settings` 只返回每个 provider 的 `hasKey` 布尔值（url/model 可见，key 不可见）
- 云端服务链（多 provider）：每个 provider 的 key 独立存储在服务端设置文件中；保存时空字符串显式删除该行 key，未提供则保留原 key
- 转写链路分模式：**本地离线识别（默认）音频完全不出本机**；云端 ASR 模式仅经浏览器 → 本地 host → ASR 服务（按配置的服务链顺序尝试），不写日志、不落盘；Web Speech 模式由浏览器语音服务处理

### 路由护栏
- `/voice-input` 路由只接受回环地址（loopback）或配置的 trustedHosts 来源
- 拒绝跨站请求（`sec-fetch-site: cross-site`）与 origin 不匹配的请求
- 请求体限制 24 MB，超限返回 413

### 润色
- 复用 DSH 已配置的模型与凭据，不新增密钥
- 润色失败时回退原始转写，绝不丢失用户输入

## 已知边界

- **默认本地离线识别**：音频不出本机，不依赖任何第三方服务；模型从 hf-mirror.com / huggingface.co 下载（约 230MB），首次使用本地引擎时自动获取
- **云端 ASR（可选）**：若切换到云端引擎，语音会发送给你配置的第三方 ASR 服务商——这是云端转写的本质
- **浏览器 Web Speech（可选）**：语音由浏览器厂商（Google/Microsoft）的语音服务处理，可能离开本机
- 麦克风权限由浏览器强制，页面需在安全上下文（localhost / HTTPS）下
