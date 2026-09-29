# dsh-voice-scribe

[![MIT license](https://img.shields.io/github/license/PensiveFei/dsh-voice-scribe)](https://github.com/PensiveFei/dsh-voice-scribe/blob/main/LICENSE)
[![release](https://img.shields.io/github/v/release/PensiveFei/dsh-voice-scribe)](https://github.com/PensiveFei/dsh-voice-scribe/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/PensiveFei/dsh-voice-scribe/ci.yml)](https://github.com/PensiveFei/dsh-voice-scribe/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/dsh-voice-scribe)](https://www.npmjs.com/package/dsh-voice-scribe)
[![npm downloads](https://img.shields.io/npm/dm/dsh-voice-scribe)](https://www.npmjs.com/package/dsh-voice-scribe)
[![dsh.so risk](https://www.dsh.so/badge/dsh-voice-scribe.svg)](https://www.dsh.so/artifact/dsh-voice-scribe/)
[![dsh.so install](https://www.dsh.so/badge/install/dsh-voice-scribe.svg)](https://www.dsh.so/artifact/dsh-voice-scribe/)
[![Listed in awesome-dsh-plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com/p/PensiveFei/dsh-voice-scribe/)

DSH 专属语音输入插件：**点按或按住 Alt 说话、松开/再点按转文字**，结果追加到输入框草稿末尾（不覆盖已输入内容）。
Voice input for DeepSeek Harness: tap or hold Alt to talk, get text in the composer.

> ⚠️ 非官方插件，与 DeepSeek / 深度求索公司无关联。使用前请阅读 [SECURITY.md](./SECURITY.md)。

## 安装 Install

**官方插件面板（推荐）**：dsh 侧边栏 → **Plugins** → 安装，填入下面任一种 spec——插件管理器同时支持 npm 包名与 GitHub 地址：

```
dsh-voice-scribe                      # npm 包名
github:PensiveFei/dsh-voice-scribe    # 直接从 GitHub 仓库装（会先做一次 git ls-remote 预检）
```

**命令行**：

```bash
dsh plugin --profile web add dsh-voice-scribe   # 重启 dsh web 后生效
```

> 桌面端（Electron）跑的是与 web **同一套宿主与插件体系**（`@deepseek-ai/dsh-desktop-host` 依赖 `dsh-app-boot` / `dsh-host-webserver` / `dsh-home-paths`），同一个插件包两端通用。

## 使用 Usage

- **麦克风按钮**：输入框右侧 🎤 图标，点击开始说话、再点停止并转写（按钮录音中变红）
- **热键**：点输入框 → 按 **Alt** 开始说话 → 再按 **Alt** 结束并转写（备选 **Alt+空格**；设置 → 语音输入 → 热键可选「自定义」，录制任意组合键，如 **Ctrl+Shift+V**、**F9**、**Alt+Space**）
- **按住说话**：设置 → 语音输入 → 触发方式 可选「按住说话」——按住热键录音、松开自动转写（麦克风按钮同样支持）；自定义组合键在按住模式下同样生效（松开组合键中的任意一键即结束）
- **实时中间结果**：说话时识别文本实时出现在草稿里（浏览器引擎逐字、本地引擎每 3 秒刷新），停止后替换为最终结果
- **录音电平指示**：录音中状态条下方显示实时电平条
- **麦克风设备**：设置 → 语音输入 → 麦克风设备 可指定用哪一路输入，录音中状态条会显示**实际生效的设备名**（见下文「麦克风设备」）
- **最长录音时长**：本地引擎约 4 分钟、云端 10 分钟，到时长自动停止并转写
- **切窗取消**：录音中切到其他窗口自动取消本次录音（Alt+Tab 误触不会留下录音）

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

## 麦克风设备 Microphone

`getUserMedia({ audio: true })` 的「默认设备」由**浏览器**决定，不等于 Windows 的默认设备：Chrome 优先用站点在 `chrome://settings/content/microphone` 里的选择，没有选择时按它自己 profile 里的设备排序——而排序第一名可能是**纯静音的虚拟设备**（典型：装过 Steam 之后的 `Steam Streaming Microphone`）。症状极具误导性：状态条显示「🎙 录音中…」、电平条不动、转写结果为空，看起来像插件坏了。

现在的行为：

- 设置 → 语音输入 → **麦克风设备**：可选「系统默认（由浏览器决定）」或指定某一路输入（按浏览器持久化）；指定后以 `deviceId: { exact }` **精确请求**，不再交给浏览器解析；
- **录音中状态条会显示实际生效的设备名**（取自 `track.label`），设置页也会显示「上次录音实际使用的是：…」——设备选错一眼可见；
- 转写为空时，若这一轮采集到的峰值 ≈0，提示会追加「**输入电平≈0**」，把「录到了静音」和「识别没听清」区分开；
- 选定的设备被拔掉/禁用后会**自动回退**到系统默认设备并在状态条说明，不会卡在 `OverconstrainedError` 上；
- 设置页只用 `enumerateDevices()`，**不会为了列设备而打开麦克风**（未授权时显示占位名，授权一次后显示真实名称），并跟随蓝牙设备上下线自动刷新列表。

> 该设置作用于插件自己的录音路径（本地离线识别 / 云端 ASR，以及麦克风按钮在这些引擎下的录音）。**浏览器 Web Speech 由浏览器直接采集，插件无法指定其设备**——那条路径请改用浏览器的站点麦克风设置，或切换到本地/云端引擎。

排查顺序：

1. 先看设置页里的「实际使用的设备」是不是你想用的那一路，不是就直接选；
2. Chrome 用户再看一眼 `chrome://settings/content/microphone`（站点级选择优先于系统默认）；
3. Windows 还有**按应用的设备策略**：设置 → 隐私和安全性 → 麦克风 里给浏览器指定的设备**优先于系统默认**，且改系统默认无效，需要把该应用的选择清掉；
4. 电平条一动不动 + 提示「输入电平≈0」= 采集端本身就是静音（虚拟声卡、被静音的硬件、被独占占用），不是识别问题。

## 热词替换表 Hot Words（可选）

把识别错的人名、术语、项目名替换回来：编辑 `$DSH_HOME/voice/hot.txt`（每行一条，修改后下次转写生效）：

```
# 字面替换（不区分大小写）：正确词=错误词1|错误词2
DeepSeek=deep seek|迪普西克
王小明=王小铭

# 正则替换（标准 $1 语义；未写 flags 时默认全局替换，写 g/y 则按原样使用）
/老\s*师/老师/
/\{([^}]+)\}/【$1】/
/deep\s*seek/DeepSeek/gi
```

设置 → 语音输入 页面会显示热词表状态（规则条数 / 文件路径 / 解析错误）。云端与本地离线引擎的转写结果统一应用。

## 自定义润色提示词（可选）

设置 → 语音输入 → 开启润色后：

- **润色模型**：下拉选择复用的 DSH 模型（选项来自 DSH 已配置的 provider，首次开启自动选中第一个）
- **润色提示词**：可自定义（多行，保存在服务端）；留空或「恢复默认」使用内置的最小必要修正提示词

> 润色时会先做一步**本地规则预润色**（去「嗯/呃」等口头禅、折叠多余空格），再把更短更干净的文本交给 LLM，省 token；LLM 失败时仍保留原始转写。

## 隐私 Privacy

本地引擎音频不出本机；Web Speech 由浏览器语音服务处理；云端 ASR 的 key 只存服务端。

## 与官方语音输入对比 Compare with the official voice input

DSH 从 0.1.7 起自带一个**实验性**的官方语音输入 —— `@deepseek-ai/dsh-experimental-voice-input-bundle`，同样使用**本地 SenseVoice**。它**默认是关闭的**，启用方式：

1. dsh 侧边栏 → **Plugins** → 打开 **Voice Input**（蓝色波形图标）
2. 按提示进入 bundle 详情 → **Download and prepare** 下载模型（会显示磁盘 / 内存 / 耗时预估，下载源可选 Automatic / Hugging Face / HF-Mirror）
3. 点模型选择器与发送键之间的 🎤 → 录音 → 点 **Stop** 把转写写进草稿

两者都用本地 SenseVoice、音频都不出本机，取舍如下（官方一列取自其 README 与 `docs/subsystems/voice-input.md`，截至 2026-09）：

| | **dsh-voice-scribe**（本插件） | 官方 voice input（experimental） |
|---|---|---|
| 获取 | 第三方插件，Plugins 面板 / npm 安装 | 随 dsh 分发，**默认关闭**，Plugins 面板启用 |
| 识别引擎 | 本地 SenseVoice 离线默认 + 浏览器 Web Speech 回退 + **云端服务链（多 provider 故障切换）** | 本地 SenseVoice；**云端识别需自行注册 provider 与凭据** |
| 触发方式 | **Alt 热键（可自定义任意组合键）/ 按住说话 / 🎤 按钮** | 🎤 按钮 → 录音工具条 → 点 **Stop** |
| 实时上屏 | ✅ 边说边出（浏览器引擎逐字、本地引擎每 3 秒） | ❌ 官方列为未做（no streaming captions） |
| 热词 / 规则替换 | ✅ `hot.txt`（字面 + 正则，默认全量替换） | ❌ |
| 润色 | ✅ 复用 DSH 模型 + 本地规则预润色（省 token） | ❌ |
| 语言 | 中文 / English / 粤语 / 日本語 / 한국어 可切换 | 取决于 provider 声明的 languages |
| 设备与诊断 | 设备选择器 + 录音中显示实际设备名 + 电平峰值归因 | 工具条内有电平；未见设备选择 |
| 模型准备体验 | 首次使用后台下载 + 进度轮询 | **步骤清单 + 磁盘/内存/耗时预估 + 下载源可选** |
| 音频去向 | 本地引擎不出本机；云端走你自己配置的端点 | 本地＝**Host 机器**（官方注明可能与浏览器不是同一台） |

**怎么选**：只要「点一下说话、点一下停」并希望**官方原生集成** → 用官方；需要**热键 / 按住说话、边说边上屏、热词纠正、AI 润色、云端多 provider 故障切换、自定义组合键** → 用本插件。

**两者可以并存**：官方插件用它自己的 🎤 按钮，本插件用 Alt 热键和另一个 🎤 按钮（悬停提示会写明是哪个），互不冲突。

## 已知限制 Known limitations

- 输入框里含 `@` 引用芯片（如 `@文件`）时，插件目前通过「整段替换草稿」写入，会把芯片展开成纯文本；先发送或清空草稿再听写可避免。（DSH 0.1.7 起新增了可按选区插入、不覆盖引用芯片的 `insertText(span)` 接口，适配已记入待办。）
- 浏览器 Web Speech 依赖外部语音服务，国内网络下通常需要改用本地离线或云端引擎。

## 兼容性 Compatibility

- 需要 **DSH 0.1.0-rc.6 及以上**；peer 范围显式列出每条已发布的预发布线（`0.1.1-rc` / `0.1.2-alpha` / `0.1.3-alpha` / `0.1.5-alpha` / `0.1.6-alpha`），semver 的预发布规则要求逐条列出元组，否则该线宿主会一直收到 unmet-peer 告警。
- 输入框插槽 `conversation.input.right` 在 DSH **0.1.2** 起由 `<textarea>` 改为 Lexical `contenteditable`：0.4.8 起两种形态都支持（读取实时草稿走 `useInput`，写入走 `inputActions.setDraft`）。
- 界面没有麦克风按钮（旧壳子没有该插槽）时，**Alt 热键仍然可用**。
- **桌面端**：官方桌面应用是 Electron 外壳，跑的是与 web 同一套宿主与插件体系（`@deepseek-ai/dsh-desktop-host` 依赖 `dsh-app-boot` / `dsh-host-webserver` / `dsh-home-paths` / `dsh-client-connection`），**同一个插件包两端通用**。
- **0.1.7-rc.2 核对**：`inputActions.setDraft()` 与 `useInput(s => s.draft)` 均未变化，插件不受影响；同版本新增 `captureInsertion()` / `insertText(text, span)`（按选区插入、一步可撤销、不覆盖引用芯片），适配排期见仓库待办。
- **实测核对**：0.4.10 逐文件对照了 **DSH 0.1.5-rc.1** 与 0.1.2-rc.1 —— 宿主端 `dsh-host-webserver` 两份字节一致，`webServer` / `webRuntime` / `llm` 三个服务与 `ctx.llm.prepareCall` / 流式 `text-delta` / `finish.reason` 均无变化；客户端 `dsh-client-modules` / `dsh-client-ui-renderer` / `dsh-client-locale` / `dsh-client-ui-settings` 四份字节一致，插槽注册、`setDraft`、`useInput(s => s.draft)`、`[data-composer-card]` + contenteditable 的 DOM 形态全部不变。

## 开发 Dev

```bash
npm test          # 测试
npm run lint      # 语法检查
npm run security  # 密钥/路径泄露扫描
```

## License

MIT