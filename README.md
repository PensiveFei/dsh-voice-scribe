# dsh-voice-scribe

[![MIT license](https://img.shields.io/github/license/PensiveFei/dsh-voice-scribe)](https://github.com/PensiveFei/dsh-voice-scribe/blob/main/LICENSE)
[![release](https://img.shields.io/github/v/release/PensiveFei/dsh-voice-scribe)](https://github.com/PensiveFei/dsh-voice-scribe/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/PensiveFei/dsh-voice-scribe/ci.yml)](https://github.com/PensiveFei/dsh-voice-scribe/actions/workflows/ci.yml)

DSH 专属语音输入插件：**点按 Alt 说话、再点按转文字**，插入输入框光标处。
Voice input for DeepSeek Harness: tap Alt to talk, tap again to get text.

> ⚠️ 非官方插件，与 DeepSeek / 深度求索公司无关联。使用前请阅读 [SECURITY.md](./SECURITY.md)。

## 安装 Install

```bash
dsh plugin --profile web add dsh-voice-scribe   # 重启 dsh web 后生效
```

## 使用 Usage

- **麦克风按钮**：输入框右侧 🎤 图标，点击开始说话、再点停止并转写（按钮录音中变红）
- **热键**：点输入框 → 按 **Alt** 开始说话 → 再按 **Alt** 结束并转写（备选 **Alt+空格**，设置可切换）
- **实时中间结果**：说话时识别文本实时出现在草稿里（浏览器引擎逐字、本地引擎每 3 秒刷新），停止后替换为最终结果

## 识别引擎 Engine（默认「自动」，零配置）

| 引擎 | 说明 |
|---|---|
| **自动（默认）** | 本地离线识别优先；不可用时自动回退浏览器识别 |
| 本地离线识别 | SenseVoice，零配置零 key、**音频不出本机**；首次使用自动下载模型（约 230MB，国内镜像，只需一次） |
| 浏览器 Web Speech | 零配置；依赖 Google/Microsoft 服务（国内 / Edge Stable 可能不可用） |
| 云端 ASR（可选） | **服务链**：可配置多个 OpenAI 兼容端点按序尝试、失败自动切换；需在设置中配置 API key |

> 浏览器识别依赖外部语音服务（Chrome 在大陆被墙、Edge Stable 有已知回归），故默认以本地识别为主。
>
> 云端 ASR 服务链示例：Groq（免费层）→ 硅基流动 SenseVoice → 阿里云百炼，任一失败自动尝试下一个（设置 → 语音输入 → 云端 ASR）。

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