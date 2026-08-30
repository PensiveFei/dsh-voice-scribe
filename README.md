# dsh-voice-scribe

[![MIT license](https://img.shields.io/github/license/PensiveFei/dsh-voice-scribe)](https://github.com/PensiveFei/dsh-voice-scribe/blob/main/LICENSE)
[![release](https://img.shields.io/github/v/release/PensiveFei/dsh-voice-scribe)](https://github.com/PensiveFei/dsh-voice-scribe/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/PensiveFei/dsh-voice-scribe/ci.yml)](https://github.com/PensiveFei/dsh-voice-scribe/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/dsh-voice-scribe)](https://www.npmjs.com/package/dsh-voice-scribe)
[![npm downloads](https://img.shields.io/npm/dw/dsh-voice-scribe)](https://www.npmjs.com/package/dsh-voice-scribe)
[![dsh.so risk](https://www.dsh.so/badge/dsh-voice-scribe.svg)](https://www.dsh.so/artifact/dsh-voice-scribe/)
[![dsh.so install](https://www.dsh.so/badge/install/dsh-voice-scribe.svg)](https://www.dsh.so/artifact/dsh-voice-scribe/)
[![Listed in awesome-dsh-plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com/p/PensiveFei/dsh-voice-scribe/)

DSH 专属语音输入插件：**点按或按住 Alt 说话、松开/再点按转文字**，插入输入框光标处。
Voice input for DeepSeek Harness: tap or hold Alt to talk, get text in the composer.

> ⚠️ 非官方插件，与 DeepSeek / 深度求索公司无关联。使用前请阅读 [SECURITY.md](./SECURITY.md)。

## 安装 Install

```bash
dsh plugin --profile web add dsh-voice-scribe   # 重启 dsh web 后生效
```

## 使用 Usage

- **麦克风按钮**：输入框右侧 🎤 图标，点击开始说话、再点停止并转写（按钮录音中变红）
- **热键**：点输入框 → 按 **Alt** 开始说话 → 再按 **Alt** 结束并转写（备选 **Alt+空格**，设置可切换）
- **按住说话**：设置 → 语音输入 → 触发方式 可选「按住说话」——按住热键录音、松开自动转写（麦克风按钮同样支持）
- **实时中间结果**：说话时识别文本实时出现在草稿里（浏览器引擎逐字、本地引擎每 3 秒刷新），停止后替换为最终结果
- **录音电平指示**：录音中状态条下方显示实时电平条

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

## 热词替换表 Hot Words（可选）

把识别错的人名、术语、项目名替换回来：编辑 `$DSH_HOME/voice/hot.txt`（每行一条，修改后下次转写生效）：

```
# 字面替换（不区分大小写）：正确词=错误词1|错误词2
DeepSeek=deep seek|迪普西克
王小明=王小铭

# 正则替换（标准 $1 语义）
/老\s*师/老师/
/\{(\w+)\}/【$1】/
```

设置 → 语音输入 页面会显示热词表状态（规则条数 / 文件路径 / 解析错误）。云端与本地离线引擎的转写结果统一应用。

## 自定义润色提示词（可选）

设置 → 语音输入 → 开启润色后，可自定义润色提示词（多行，保存在服务端）；留空或「恢复默认」使用内置的最小必要修正提示词。

> 润色时会先做一步**本地规则预润色**（去「嗯/呃」等口头禅、折叠多余空格），再把更短更干净的文本交给 LLM，省 token；LLM 失败时仍保留原始转写。

## 隐私 Privacy

本地引擎音频不出本机；Web Speech 由浏览器语音服务处理；云端 ASR 的 key 只存服务端。

## 与同类插件对比 Compare

同为 DSH 的语音 / 输入增强插件，主要差异（截至 2026-08）：

| | **dsh-voice-scribe**（本插件） | [dsh-better-input](https://github.com/DIAG5/dsh-better-input) |
|---|---|---|
| 定位 | 专注语音输入 | 输入增强套件（语音 + 提示词优化 + 文件转 Markdown 等） |
| 本地离线识别 | ✅ SenseVoice，零 key，音频不出本机 | ❌ 仅浏览器原生识别 |
| 浏览器 Web Speech | ✅ 回退 | ✅ |
| 云端 ASR 服务链 | ✅ 多 provider 故障切换 | ❌ |
| 热词替换表 hot.txt | ✅ | ❌ |
| 本地规则预润色（省 token） | ✅ 0.4.2 起 | ❌ |
| AI 润色（复用 DSH 模型） | ✅ | ✅ |
| 按住说话 / 录音电平 | ✅ | 录音自动停止（无电平） |
| 提示词优化 / 文件转 Markdown | ❌ | ✅ |

只想要**更省心、更私密的语音输入** → dsh-voice-scribe；需要**一整套输入增强**（提示词优化、文件转 Markdown） → dsh-better-input。两者可并存。

## 开发 Dev

```bash
npm test          # 测试
npm run lint      # 语法检查
npm run security  # 密钥/路径泄露扫描
```

## License

MIT