# dsh-voice-scribe

DSH 专属语音输入插件：**点按 Alt 说话、再点按结束转文字**，文本直接插入输入框光标处。
Voice input for DeepSeek Harness: tap **Alt** to start recording, tap again to stop — the transcript lands in the composer.

> ⚠️ **非官方插件（unofficial）**：本插件由社区成员开发，与 DeepSeek / 深度求索公司无任何关联。
> 使用前请阅读 [免责声明](#免责声明disclaimer) 与 [SECURITY.md](./SECURITY.md)。

---

## 功能 Features

- 🎙️ **点按 Alt 切换录音**（默认）；若浏览器拦截 Alt，可切换为 **Alt+空格**（设置中可选）
- 🎧 **转写**：默认用浏览器内置 Web Speech 识别（Chrome/Edge 自带，**零配置、零 API key**）；可选 OpenAI 兼容 ASR 端点
- ✨ **可选润色**：默认关闭；开启后转写文本通过 **DSH 已配置的模型** 清理口头禅、补标点——**无需额外配置 API key**
- 🔒 **隐私设计**：默认 Web Speech 模式音频不出浏览器；ASR API key（如启用云端引擎）只存服务端，浏览器端不可见

## 为什么默认用浏览器内置识别（Web Speech）

DSH 用户大多只有 DeepSeek 原生 API key，而 DeepSeek 模型是**纯文本模型**，无法直接"听"音频做语音转文字。
为了让插件**开箱即用、无需额外注册任何服务**，默认引擎用 Chrome/Edge 内置的 Web Speech 识别——浏览器原生支持中文，不需要任何 key。
如果你已有 OpenAI 兼容的 ASR 服务（Groq / 硅基流动 / 其他），可以在设置中切换为云端引擎获得更高准确率。

## 安装 Install

```bash
# 打包
pnpm pack
# 安装到你的 DSH web profile
dsh plugin --profile web add ./dsh-voice-scribe-0.1.1.tgz
# 重启 dsh web 后刷新页面
```

## 使用 Usage

1. 点击输入框，**按一下 Alt** 开始说话；**再按一下 Alt** 结束并转写（默认引擎零配置，直接可用）
2. 转写文本出现在输入框光标处，检查后按回车发送

### 热键 Hotkeys

| 热键 | 说明 |
|---|---|
| `Alt`（默认） | 点按开始 / 再点按结束 |
| `Alt+空格` | 备选；当浏览器把 Alt 单键用于菜单聚焦时使用 |

### 识别引擎 Engine

- **Web Speech（默认）**：浏览器内置，零配置零 key，中文友好。音频由浏览器语音服务处理。
- **OpenAI 兼容 ASR（可选）**：任意 `/v1/audio/transcriptions` 端点（Groq / 硅基流动 / 自建等），需在 `~/.dsh/voice-input.json` 配置 `asrUrl` / `asrModel` / `asrApiKey`

### 润色 Polish（可选，默认关闭）

开启后，转写文本会通过 **DSH 设置 → 模型** 里已配置的某个模型做最小修正（删口头禅、改同音错字、补标点）。
复用 DSH 的模型与 key——**你不需要为润色额外配置任何东西**。

## 数据与隐私 Privacy

- **Web Speech 模式**：音频在浏览器内由浏览器语音服务处理，不经过 DSH host，不落盘、不打日志
- **云端 ASR 模式**（可选）：音频经浏览器 → 本地 host → ASR 服务一条链路；API key 只存在 `~/.dsh/voice-input.json`（服务端），页面 JS 拿不到
- 润色：转写文本 + 系统提示词发给所选 DSH 模型，失败时回退原始转写，不丢失内容
- 首次使用需在浏览器授予麦克风权限（DSH 默认 127.0.0.1 属安全上下文，支持）

## 免责声明（Disclaimer）

**使用本插件即表示你理解并同意：**

1. **浏览器识别**：默认 Web Speech 模式下，语音由浏览器及其语音服务（Chrome/Edge 厂商）处理，可能离开本机。请自行评估隐私风险。
2. **第三方服务**：若切换云端 ASR 引擎，语音会发送给你配置的第三方服务商。请确认其数据处理政策。
3. **非官方**：本插件非 DeepSeek 官方产品，不提供任何官方支持或 SLA。
4. **无保证**：插件按"原样"提供，不对转写准确性、服务可用性、数据安全作任何明示或暗示的保证。
5. **风险自担**：因使用本插件（包括但不限于语音内容泄露、误转写、第三方服务故障）造成的任何损失，开发者不承担责任。
6. **敏感信息**：请勿在语音中输入密码、密钥、身份证号等敏感信息。

## 开发 Dev

```bash
npm test         # 离线单元测试
npm run lint     # 语法检查
npm run security # 密钥/路径泄露扫描
```

## License

MIT