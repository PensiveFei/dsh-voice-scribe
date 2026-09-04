# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [0.4.7] — 2026-09-04

### Fixed

- **Web Speech 无草稿通道时终稿与中间结果叠加（文本重复）**：`finishWebSpeech` 的兜底路径此前把终稿追加到已写入 textarea 的 interim 之后——0.4.4 修的是 MediaRecorder 路径，这是同款 bug 的 Web Speech 孪生。现在兜底路径同样从 `wsDraftBase` 基线重建，不再依赖草稿通道。
- **「自动」语言实际强制中文**：`recognition.lang` 在未选择语言时硬编码 `zh-CN`，英文浏览器用户永远得到中文识别结果。现在回退到 `navigator.language`。
- **本地引擎超长录音中途 413 失败**：本地引擎上传 16 kHz float32 原始 PCM（4 字节/采样点），约 4.7 分钟后请求体就会超过宿主 24 MB 上限，超长录音在转写中途失败。现在录音到达安全时长自动停止（本地约 4.3 分钟、云端 10 分钟），状态条提示后直接转写。
- **Alt+Tab 误触录音且麦克风不释放**（tap 模式）：Alt 的 keydown 会先触发录音，随后切走窗口，录音继续在后台运行、麦克风常亮，回来还会插入一段用户并不想要的转写。现在窗口失焦时**取消**录音（回滚预览、不插入文本）；按住说话模式维持原「松开结束」行为。
- **设置页文本域被当成输入框**：无草稿通道时的 textarea 兜底查找可能命中设置页「润色提示词」文本框，把转写文本插进设置里。该文本框现在带标记并被兜底查找排除。
- **`holdStopPending` 残留会瞬间掐断下一次点按录音**：按住模式下模型下载完成后启动失败会留下过期的 stop 标记；若用户切回点按模式，下一次录音一启动就被立刻停止。点按路径现在先清除该标记。
- **润色调用对已断开客户端空跑 30 秒**：`polishText` 没有像 ASR 一样把「调用前就已 abort」的信号同步到超时控制器——客户端断开后润色仍会跑满 30 秒。现已显式转发（已 abort 的信号不会为后注册的监听器再次触发 abort，同 host-utils 的坑）。
- **未知流块把 `undefined` 拼进润色结果**：`out += chunk.text` 对非 `text-delta` 块（如 tool-use）或非字符串内容追加 `undefined`。现在只接受字符串型 `text-delta`。
- **`buildTrustedHosts` 对非数组配置直接抛错**：宿主若未提供 `trustedHosts`，插件启动即失败。现在按空列表兜底（仅允许回环）。
- **停止录音的兜底状态「已停止」永不消失**：改回自动淡出的瞬时提示。

### Changed

- **`scripts/lint.cjs` 不再使用 `child_process` / `execSync`**：语法检查改用 `node:vm` 编译（tests、scripts 与 client bundle），ESM 的 lib 模块由测试套件导入覆盖。仓库中不再有任何进程派生产物，静态扫描（npm 包或 git 源码）都不会因此命中高风险信号。
- 删除未使用的 `TextRow` 组件与 `recordingStartTime` 死变量；麦克风按钮现在真实反映「转写中」忙状态（此前 `busy` 恒为 false）。

### Tests

- 143 → **156**：新增 13 项回归——polishText 信号转发与块类型过滤（真实行为，离线 stub dsh-llm）、`buildTrustedHosts` 容错，以及 client/scripts 形状测试（Web Speech 基线重建、浏览器语言回退、录音时长上限、失焦取消、holdStopPending 清理、设置页文本域排除、忙状态轮询、lint 无进程派生）。

## [0.4.6] — 2026-09-01

### Fixed

- **peer 版本范围补上 `0.1.2-alpha` 线（修 0.4.5 的疏漏）**：0.4.5 把范围从 `>=0.1.2-alpha.2` 改成 `>=0.1.0-rc.6`，只是把「排除 rc 线」换成了「排除 alpha 线」。根因是 semver 的预发布规则——**含预发布号的范围只对同一个 `major.minor.patch` 元组放行预发布版本**，所以 `>=0.1.0-rc.6` 匹配 `0.1.0-rc.7` 却不匹配 `0.1.2-alpha.4`。实测确认：

  | 范围 | 0.1.0-rc.7 | 0.1.2-alpha.4 |
  | --- | --- | --- |
  | `>=0.1.2-alpha.2`（0.4.4 及更早） | ❌ | ✅ |
  | `>=0.1.0-rc.6`（0.4.5） | ✅ | ❌ |
  | `>=0.1.0-rc.6 \|\| >=0.1.2-alpha.0`（本版） | ✅ | ✅ |

  两条线的宿主都在实际使用中，所以范围必须**显式列出两者**，否则总有一批用户收到永久的 unmet peer 告警。新增回归测试断言范围同时覆盖两条线。

## [0.4.5] — 2026-09-01

### Changed

- **插件安装不再拖入 DSH 核心包树（重要）**：`@deepseek-ai/dsh-llm` 改为**可选 peer**（新增 `peerDependenciesMeta.optional`）。npm 7 起默认自动安装 peerDependencies，此前 `npm install dsh-voice-scribe` 会连带装入 `@deepseek-ai/dsh-llm`、`cordis`、`cosmokit`、`dsh-brand`、`dsh-invariants`、`dsh-timeout`、`dsh-typert-protocol`、`dsh-util-crypto`、`dsh-util-values`、`schemastery` 等**共 15 个包**——在已运行某一核心版本的宿主里并排装出第二套核心，正是「作用域符号对不上、新建会话报 unscoped context」的成因。改为可选 peer 后，同样的安装从 **15 个包降到 1 个**。
- **peer 版本下界放宽**：`>=0.1.2-alpha.2` → `>=0.1.0-rc.6`。原下界把 `0.1.0-rc.x` 系列的宿主全部排除在外（`0.1.0-rc.7` 并不满足 `>=0.1.2-alpha.2`），这些用户会一直收到 peer 不满足告警。润色路径本就是运行时懒加载、失败自动降级返回原始转写，声明为可选也更贴合真实行为。
- **`sherpa-onnx-node` 移入 `optionalDependencies`**：本地离线识别只是三个引擎之一，而该包含平台原生二进制、并非所有平台都有预编译产物。此前它是硬依赖，装不上就整个插件装不上——即便用户只想用云端 ASR 或浏览器 Web Speech。现在缺失不再中断安装。

### Fixed

- **本地引擎缺少原生绑定时的报错**：`require("sherpa-onnx-node")` 失败此前抛出的是识别器加载深处的 `MODULE_NOT_FOUND` 堆栈；现在转为 `code: "local-engine-unavailable"` 与明确提示（改用云端 ASR 或 Web Speech）。

### Changed

- 测试 141 → **143**：新增「清单不得拖入核心包树」「缺少原生绑定须优雅降级」两条回归。

## [0.4.4] — 2026-09-01

### Fixed

- **热词表对含正则元字符的词完全失效（高危）**：`escapeRegExp` 的替换参数被一次失手的全局替换覆盖成了一行注释文本，转义后的规则仍是**合法正则**，所以既不报错也不匹配——`C++`、`3.14`、`Node.js`、`C#` 这类恰恰最需要纠正的词被静默跳过。已恢复为 `"\\$&"`，并修复被同一次事故污染的 JSDoc。
- **本地模型下载遇到磁盘写错误会拖垮整个宿主进程（高危）**：`.part` 写入流全程没有 `error` 监听，磁盘写满（230MB 模型）、杀软锁文件等情况下 Node 以「Unhandled 'error' event」抛出**未捕获异常**，DSH 宿主直接退出，镜像回退逻辑根本轮不到执行。现在写入流全生命周期挂有监听，错误转为正常拒绝并进入既有的镜像回退。
- **云端引擎设置页崩溃（高危）**：`cloudHasKey` 从未声明，引擎选到 `cloud-asr` 时渲染即抛 `ReferenceError`，恰好让唯一需要填 API Key 的用户打不开配置表单。
- **连点两次 Alt 会泄漏麦克风（高危）**：`recording` 标志在 `await getUserMedia` **之后**才置位，而首次授权弹窗可停留数秒，远超热键去抖；期间再按一次会启动第二个录音流与录音器，第一个流的 tracks 永不释放（麦克风持续开启），两个录音器还会把数据混进同一个缓冲区。新增同步 in-flight 闸。
- **转写失败会吞掉用户手打的文字**：`recDraftBase` 初值为 `""`，故 `!== undefined` 恒真，即使云端引擎从未写过实时预览也会执行草稿回滚——用户在长达 75 秒转写期间输入的内容被静默清空。回滚现在只在确实写过预览时发生。
- **无草稿通道时转写文本重复**：终稿插入此前同时要求「本地引擎 + 存在草稿通道」，缺通道时预览经 DOM 兜底写入 textarea，终稿却走追加路径，导致预览与终稿叠加。判断依据改为「是否真的写过预览」。
- **浏览器断开后仍跑完整条云端 ASR 回退链**：已 abort 的 `AbortSignal` 不会为随后注册的监听器再次触发 `abort`，故转发失效；失败链循环也不检查 `signal.aborted`，最坏情况在客户端早已离开后继续 POST 每一个 provider（4 × 60s）。现在循环遇 abort 即停，并新增 `asr-aborted` 错误码（此前被误报为 `asr-timeout`）。
- **多 provider 全都缺 key 时错误码退化**：守卫多写了 `failures.length === 1`，与其上方注释相矛盾，导致 2 个及以上 provider 均未配 key 时错误码退化为 `asr-failed`，前端「去设置里填 API Key」的引导不再出现。

### Changed

- `sherpa-onnx-node` 升级到 `^1.13.7`。
- `lib/*.js` 增加 `SPDX-License-Identifier: MIT` 头，`files` 显式包含 `LICENSE`（便于基于文件扫描的合规工具直接断言许可证）。
- 测试从 133 增至 **141**：上述每条缺陷都补了回归测试，且已验证它们在 0.4.3 代码上全部失败（其中模型下载那条会直接让测试进程崩溃）。
- 移除仓库中最后的 `node:http` 引用（0.4.3 之后的纯 git 提交，本次随包发布）。

## [0.4.3] — 2026-08-31

### Changed

- **声明 `@deepseek-ai/dsh-llm` 为 peerDependency（`>=0.1.2-alpha.2`）**：润色路径在运行时懒加载 `createUserMessage`，此前依赖宿主 profile 传递提供；显式声明后，新版本 harness（0.1.2-alpha）下 peer 解析明确、不再靠运气。

### Fixed

- 无（仅依赖声明调整）。

## [0.4.2] — 2026-08-30

### Added

- **本地规则预润色（LLM 前，省 token）**：润色时会先做一步确定性本地预处理——去掉「嗯/呃」等无歧义口头禅、折叠多余空格，再把更短更干净的文本交给 LLM；LLM 失败时仍保留原始转写
- **README 与同类插件对比**：新增「与同类插件对比」小节，与 dsh-better-input 逐项对照（本地离线识别 / 云端 ASR 服务链 / 热词表 / 本地预润色等）

### Changed

- **不再随 npm 包发布 `tests/`**：`package.json` 的 `files` 字段移除 `tests`，测试文件（含测试用的本地 HTTP 服务器）不再进入发布的包，降低 dsh.so 静态扫描的风险分
- **`local-asr.js` 改用 sherpa-onnx 主入口**：`require("sherpa-onnx-node/non-streaming-asr.js")` → `require("sherpa-onnx-node")`，不再深入依赖内部子路径

## [0.4.1] — 2026-08-29

### Added

- **热词/正则替换表（hot.txt，CapsWriter 风格）**：在 `$DSH_HOME/voice/hot.txt` 里每行一条规则，转写完成后自动应用——把识别错的人名、术语、项目名替换回来
  - 字面规则：`正确词=错误词1|错误词2`（不区分大小写、全部替换）
  - 正则规则：`/正则/替换/flags`（标准 $1 替换语义；`\/` 表示字面斜杠）
  - `#` 注释与空行忽略；坏行在设置页标出且不影响其他规则；上限 1000 条，文件改动自动重载（mtime+size 缓存）
  - 云端 / 本地离线引擎的转写结果统一应用；设置页显示热词状态（规则条数、文件路径、解析错误）
- **按住说话模式（Push-to-Talk）**：设置 → 语音输入 → 触发方式 可选「按住说话」——按住 Alt（或 Alt+空格）录音，松开自动停止并转写，与「点按切换」模式并存
  - 松开时若 getUserMedia 尚未就绪，录音开始后立即停止（不会出现没人停的录音）
  - Alt+Tab 切走（窗口失焦）自动结束录音；Alt+空格 模式松开任一键即结束
  - 输入框麦克风按钮同步支持按住说话（按住说话、松开转写）
- **润色提示词可自定义**：设置 → 语音输入 → 润色 开启后可编辑自定义润色提示词（多行），保存在服务端（voice-input.json），留空或「恢复默认」用回内置提示词；上限 8000 字符
- **录音电平指示**：录音中在状态条下方显示 5 根实时电平条（Web Audio AnalyserNode 频谱分片），本地 / 云端引擎可用；纯装饰，任何失败都不影响录音

### Changed

- npm 包描述更新（点按或按住 Alt、热词替换表等）

## [0.4.0] — 2026-08-29

### Added

- **输入框麦克风按钮**：composer 工具行右侧新增麦克风图标（`conversation.input.right` slot），点击即可录音/停止，与 Alt 热键等效；录音/转写中图标变色
- **实时中间结果（边说边上屏）**：Web Speech 引擎把 interim 识别结果实时写入草稿（基于录音开始时的草稿基线，不覆盖已有内容），停止后用最终文本替换；本地离线引擎每 3 秒对已录内容增量转写一次实时上屏（云端引擎不做，避免每次 2.5s 一次 API 调用）
- **云端 ASR 服务链（多 provider 故障切换）**：云端引擎可配置多个 OpenAI 兼容端点（URL / 模型 / API key），按顺序尝试，失败自动切换到下一个；全部失败时返回聚合错误（含每个服务的失败原因）。旧版单端点配置（asrUrl/asrModel/asrApiKey）自动折叠为链的第一个，无需迁移
- 服务链上限 4 个 provider；`get-settings` 只返回 provider 的 url/model/hasKey（key 永不进浏览器）

### Changed

- 设置页「云端 ASR 配置」从单组输入改为**服务链列表**：每行一个服务（#序号 + URL + 模型 + Key），支持「+ 添加服务」/「移除」，保存时整体提交
- 转写结果写入改走 **draft channel**（slot 的 setDraft 优先，textarea 兜底），与实时上屏共用同一通道

### Fixed

- 本地引擎录音时草稿基线在 `startRecording` 捕获，停止时定时器清理（`finishRecording` / `stopRecording` 双路径），避免「录音太短」或异常停止后残留定时器
- **SECURITY.md 漏洞报告策略修正**：原「请勿在公开 issue 中提交安全问题」一刀切且未提供实际联系邮箱——现改为高危漏洞走 GitHub Security Advisories（附链接）、一般问题/疑问可直接公开讨论

## [0.3.0] — 2026-08-28

### Added

- **识别语言新增 粤语 / 日本語 / 한국어**：SenseVoice 模型原生支持中/英/日/韩/粤，本地离线识别自动检测语言；所选语言同时作用于浏览器 Web Speech（完整 locale 码）与云端 ASR（归一化为主子标签，如 yue-Hant-HK→yue）

### Fixed

- **设置页「未配置 API key」警告不再误报**：此前引擎为「自动 / 本地离线识别」（都不需要 key）时也显示该警告；现在只在「云端 ASR」引擎下提示
- **本地识别器并发加载去重**：两次重叠的转写曾各自构造一个 OfflineRecognizer，约 230MB 模型被加载进内存两次；现在并发调用共享同一个加载 Promise，失败自动清除缓存可重试
- **模型下载补齐背压**：file.write() 返回 false 时等待 drain 再继续，避免镜像快、磁盘慢时把 230MB 整个堆进内存
- **镜像失败不再留垃圾**：此前回退镜像时把最多 230MB 的半成品改名 .part.fail 永久留在磁盘；现在失败即删 .part，且每次启动下载先清理陈旧的 .part / .part.fail
- **本地转写超时放宽到 180s**：本地 CPU 推理约 0.3× 实时，最长录音（约 4.7 分钟）需 ~90s，此前沿用 75s 通用上限会被客户端提前掐断
- **「✨ 润色中…」状态改为常驻**：润色最长 30s，此前 2.6s 就淡出，看起来像没在工作
- **模型下载轮询去重**：下载进行中再按 Alt 曾会启动第二个重复轮询（localDownloading 标志只写不读）；现在共享同一个进行中的 Promise

## [0.2.0] — 2026-08-27

### Added

- **本地离线识别引擎（SenseVoice via sherpa-onnx）**：真正零配置、零 API key、音频不出本机——不受浏览器 Web Speech 回归（Edge Stable）、Google 被墙、离线环境影响
- **引擎「自动（auto）」模式（默认）**：本地模型就绪时优先本地；未就绪时先用浏览器 Web Speech；Web Speech 报网络错误时**自动切换本地**并自动下载模型，再按一次 Alt 即可
- 模型**首次使用自动后台下载**（约 230MB，带进度提示），从国内可达镜像（hf-mirror.com / huggingface.co）下载，`$DSH_HOME/voice/sensevoice` 落盘，可复用；失败自动回退下一镜像
- 设置页新增「本地离线识别」引擎选项与本地模型状态行（就绪 / 下载中 % / 未下载）
- 浏览器端把录音解码为 16kHz 单声道 PCM 直传 host（AudioContext.decodeAudioData + 线性重采样），host 端 sherpa-onnx 直接推理，无需 ffmpeg/转码
- SenseVoice 输出清洗：剥离 `<|zh|><|NEUTRAL|>` 等元数据标记，保留自动标点

### Changed

- 默认引擎从 `web-speech` 改为 `auto`（行为更稳，配置仍为零）
- 新增依赖 `sherpa-onnx-node`（预编译，win/mac/linux）
- Web Speech 网络错误提示改为指引「本地离线识别 / 云端 ASR」

## [0.1.2] — 2026-08-26


### Fixed

- **超大请求体不再挂起**：`readJsonBody` 超限时以哨兵值返回（不再 destroy 流后永久不 resolve），服务端真正返回 413 并关闭连接（此前 SECURITY.md 声称返回 413，实际请求会挂到客户端超时）
- **润色失败不再卡状态条**：浏览器端 `polish()` 内部吞掉网络异常并回退原始转写；`finishWebSpeech` 的调用链补上防御性 `.catch`，杜绝“✨ 润色中…”永久停留与 unhandledrejection
- **cordis.patch.yml 名称同步为 dsh-voice-scribe**（`id: voice-scribe` / `name: 'dsh-voice-scribe'`，与客户端注册 id、服务端 name 一致；此前文件仍是 dsh-voice-input）
- **trustedHosts 校验移到启动期一次完成**：非法配置条目不再让每次 API 请求抛异常（此前在请求热路径里 assert 且位于 try 之外，一条坏配置即 500/挂起全部请求）
- **语言码不再截断**：`zh-CN`→`zh`、`en-US`→`en`，三字母码（如粤语 `yue`）保持完整（此前 `slice(0,2)` 会截成无效的 `yu`）
- **热键不再误触非 composer 输入框**：焦点在搜索框/设置输入框等可编辑元素时按 Alt 不会触发录音；`Alt+空格` 按住重复触发已过滤
- **Web Speech 网络错误提示改为可操作指引**：说明依赖 Google/Microsoft 语音服务、当前网络不可达，并引导到 设置 → 语音输入 切换「云端 ASR」（大陆网络下该引擎不可用，此提示直接告诉用户怎么换引擎）
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