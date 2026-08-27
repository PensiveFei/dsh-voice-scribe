# dsh-voice-scribe

DSH 专属语音输入插件：**点按 Alt 说话、再点按转文字**，插入输入框光标处。
Voice input for DeepSeek Harness: tap Alt to talk, tap again to get text.

> ⚠️ 非官方插件，与 DeepSeek / 深度求索公司无关联。使用前请阅读 [SECURITY.md](./SECURITY.md)。

## 安装 Install

```bash
dsh plugin --profile web add dsh-voice-scribe   # 重启 dsh web 后生效
```

## 使用 Usage

点输入框 → 按 **Alt** 开始说话 → 再按 **Alt** 结束并转写（备选热键 **Alt+空格**，设置可切换）。

## 识别引擎 Engine（默认「自动」，零配置）

| 引擎 | 说明 |
|---|---|
| **自动（默认）** | 本地离线识别优先；不可用时自动回退浏览器识别 |
| 本地离线识别 | SenseVoice，零配置零 key、**音频不出本机**；首次使用自动下载模型（约 230MB，国内镜像，只需一次） |
| 浏览器 Web Speech | 零配置；依赖 Google/Microsoft 服务（国内 / Edge Stable 可能不可用） |
| 云端 ASR（可选） | OpenAI 兼容端点，需在设置中配置 API key |

> 浏览器识别依赖外部语音服务（Chrome 在大陆被墙、Edge Stable 有已知回归），故默认以本地识别为主。

## 识别语言 Languages

支持 **中文 / English / 粤语 / 日本語 / 한국어**（设置 → 语音输入 可选）。本地离线识别自动检测语言；所选语言作用于浏览器与云端识别。

## 隐私 Privacy

本地引擎音频不出本机；Web Speech 由浏览器语音服务处理；云端 ASR 的 key 只存服务端。

## 开发 Dev

```bash
npm test          # 测试
npm run lint      # 语法检查
npm run security  # 密钥/路径泄露扫描
```

## License

MIT