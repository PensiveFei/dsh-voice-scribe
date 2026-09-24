# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [0.5.0] — 2026-09-24

### Added

- **自定义热键（PR #4，感谢 alex.huang）**：热键不再只有 `Alt` / `Alt+Space` 两个预设。设置 → 语音输入 → 热键 选「自定义…」后可以录制或手输任意组合键（`Ctrl+Shift+V`、`F9`、`Alt+Space`…），存为 `custom:<combo>`，老设置与非法值回退行为不变。修饰键改为**精确**匹配——多按一个 Ctrl/Meta/Shift 不会误触发录音；按住说话模式下松开组合键中的任意一键都结束。状态条与麦克风按钮提示也会显示真实热键，不再写死 Alt。
- **麦克风设备可选、可见（issue #5）**：`getUserMedia({audio:true})` 的「默认设备」由**浏览器**决定（Chrome 按站点选择，其次按自己 profile 的设备排序），与 Windows 默认设备可以不同，其第一名可能是**纯静音的虚拟设备**（如装过 Steam 后的 `Steam Streaming Microphone`）——症状是状态条显示「🎙 录音中…」、电平条不动、转写为空，看起来像插件坏了。现在：设置 → 语音输入 新增「**麦克风设备**」（按浏览器持久化，保留「系统默认（由浏览器决定）」），指定后以 `{ deviceId: { exact } }` 精确请求；**录音中状态条追加实际生效的设备名**（`track.label`，过长截断），设置页显示「上次录音实际使用的是：…」；设置页只用 `enumerateDevices()`（**不会为了列设备而点亮麦克风**，未授权时显示占位名），并监听 `devicechange` 跟随蓝牙设备上下线刷新。
- **静音与「没听清」不再混为一谈**：电平条在频谱柱之外增加**时域峰值**统计，转写为空时据此追加「输入电平≈0（可能是设备选错、麦克风被静音，或被其他程序占用）」——同一句「未识别到文字」现在能指向真因；峰值在每轮录音开始时重置为"未知"，Web Speech 路径（不走电平条）同样重置，不会拿上一轮的数值误报。

### Fixed

- **选定的麦克风失效后卡死在报错上**：设备被拔掉/禁用/站点数据被清时，`deviceId: { exact }` 抛 `OverconstrainedError`，此前只显示「无法访问麦克风：OverconstrainedError」。现在会清除失效记录、回退到系统默认设备，并在状态条说明「之前选择的麦克风已不可用，已回退到系统默认设备」。

### Changed

- `sherpa-onnx-node` ^1.13.7 → ^1.13.8（Dependabot）。
- **发布流程改走 GitHub Actions + npm Trusted Publishing（OIDC）**：推版本 tag 即发布，发布包带 **provenance 签名**，仓库和本机都不再需要长期 npm token，也不再需要 OTP。

### Tests

- 192 → **201**：自定义热键与麦克风设备各新增一组用例——预设解析与 `alt-space` → `alt+space` 和弦、修饰键精确匹配、录制器接线；pin 后约束为 `exact`、静音判定阈值、长设备名截断、失效设备回退并清除记录、设置页设备选择器不得调用 `getUserMedia`、电平峰值接线含 Web Speech 重置。测试沙箱的 localStorage 桩升级为可读写的 `Map`：此前 bundle 读的是 `window.localStorage`（恒为空），凡是设置类逻辑在沙箱里都覆盖不到——这个坑顺带修掉了。

## [0.4.10] — 2026-09-15

### Fixed

- **实时上屏会覆盖用户边说边打的字（HIGH，静默丢字）**：`writePreviewSpan` 无条件整段替换草稿，而中间结果每几百毫秒就来一次（Web Speech）或每 3 秒一次（本地引擎）。录音开始后只要用户往输入框里打一个字，下一次中间结果就把整段草稿换成「基线 + 假设」，且无法找回——`commitTranscript` 随后看到「输入框里还是我写的预览段」而走「从基线重建」分支，用户打的字永远不会回来。现在只有输入框里仍是**插件自己刚写的内容**时才继续预览，一旦被改动就停止上屏，终稿改为追加到用户当前文本之后。
- **按住说话时松开 Alt 若还按着 Shift/Ctrl，录音不会结束（MED，麦克风常亮）**：结束判定复用了开始时的匹配器，而它要求 `!shiftKey`——Alt+Shift 正是 Windows 的输入法切换，用户按下 Shift 时手正按着 Alt。结果 `holdActive` 卡住、麦克风一直开着到 260/600 秒上限，之后最多 10 分钟的现场环境音被转写进输入框，期间再按 Alt 也没有反应。现在松开判定只看 `key === "Alt"`，忽略其他修饰键。
- **旧版单端点配置字段永不删除（MED）**：0.2.0 及更早把云端配置写成 `asrUrl`/`asrModel`/`asrApiKey`，宿主每次都把它折叠成服务链的第 1 行，而设置页只写 `asrProviders`——于是每点一次「保存配置」就多复制一行相同端点（直到 4 行上限把真正的服务挤掉，每个还会各耗 60 秒超时）；「清除已保存 Key」也只清链里的行，折叠出来的旧 key 仍在认证，宿主继续报 `hasKey: true`。现在保存与清除都会同时把旧字段置 null 删除。
- **本地引擎的静音空转写被当成「已插入」（MED）**：SenseVoice 对静音返回空字符串而不是错误，客户端把 `text: ""` 当成功提交，状态条显示「✅ 已插入」而输入框什么都没多，反而多出一个尾随空格（云端引擎此时报 asr-empty、Web Speech 有自己的分支，同一件事三种表现）。现在统一提示「未识别到文字」。
- **`decodeAudioData` 永不回调时泄漏 AudioContext（MED）**：30 秒硬超时只 reject、不关上下文，而 `finally` 要等解码 settle 才跑——这正是超时当初要兜的 Edge 场景。本地引擎每 3 秒重试一次预览，每次泄漏一个 context，六次之后浏览器的上下文配额用尽，本地引擎与电平条一起失效到刷新页面。现在超时自身关闭上下文。
- **`recorder.start()` 抛异常会泄漏麦克风（MED）**：只保护了构造函数。设备在 getUserMedia 之后被拔掉/被别的程序抢走时 `start()` 抛错，流还开着、`recording` 仍是 false、`onstop` 永远不会来，麦克风常亮且下一次点按会再开一路新流。现在 `start()` 同样有 try/catch 并释放流与电平条。
- **上一轮录音的预览会写进新一轮（MED）**：停止后立刻开始下一轮并不被阻止，而上一轮还在飞的预览请求解析后会把自己的假设写进新会话、并用陈旧的计数推进分片游标。现在预览带上「第几轮」标记，轮次变了就丢弃结果。
- **`onend` 不触发时录音彻底卡死（LOW → 可恢复性）**：`SpeechRecognition.onend` 在 stop() 后并不保证触发（Chromium 系长期存在的问题），一旦不触发，状态条永久停在「处理中…」、`wsRecording` 卡在 true，之后每次按 Alt 都重新进入同一个死掉的 stop()，只能刷新页面。现在 stop() 会武装一个 12 秒看门狗自行收尾（正常路径由 onend 清除，晚到的 onend 也不会重复收尾）。
- **Web Speech 分段落可能粘连英文（LOW）**：`wsFinalText += transcript` 直接拼接，Chrome/Edge 通常自带前导空格但不是所有情况都有，两段英文会粘成 `helloworld`。现在只在「ASCII 字母数字边界」补一个空格，中文永远不会被插入空格。
- **热词正则不写 `g` 只替换第一处（LOW）**：`/错词/对词/i` 是 JS/sed 的习惯写法，README 的示例也没有 flags，而 `String.replace` 语义只替换第一处——静默地、且恰好是热词表存在的意义所在。现在未显式写 `g`/`y` 时默认全局；显式写了就完全按原样使用。
- **本地预润色在「；」后面又补句号（LOW）**：`已完成；` 被补成 `已完成；。`。现在 `；：，、）】》」”’` 等收尾/分隔符都算已收尾。
- **`get-settings` 遇到非字符串 `asrApiKey` 直接 500（LOW）**：这是设置视图里唯一没有类型保护的字段，手工编辑 `voice-input.json` 写成数字就会让整个「语音输入」设置块空白且不报错（转写本身仍然正常）。
- **服务链超过宿主上限后 UI 仍能继续添加（LOW）**：宿主保存时只留前 4 行，界面却可以无限加——第 5 行留在屏幕上、保存显示「已保存」、永远不会被执行、刷新后消失。现在到 4 行就不再显示「+ 添加服务」。
- **模型下载残桩的跳过阈值过低（LOW）**：判据是「文件非空」，0.4.9 已改为尺寸下限，但下限只有 5 MB（真实模型约 228 MB），且截断只有在有 Content-Length 时才能发现——分块代理或连接中断留下的大残桩仍会被永久信任。下限提到 150 MB / 4 KB。
- **本地预览会漏掉正在录音的那 1–3 秒（LOW）**：预览请求在飞的时候 `ondataavailable` 仍在产分片，而请求返回后游标直接跳到「当前分片数」，把从未上传的音频记成已转写。现在先快照本次请求覆盖到哪里再发请求。
- **下载失败不取消响应体 / 并发下载竞态 / 二次写响应（LOW）**：镜像回退时被放弃的响应体仍会继续拉 230 MB；两个调用方（两个标签页、设置页与热键并发）会同时通过 `running` 检查并写同一个 `.part`；客户端断开后 `writeJson` 可能对已结束的响应再写一次。
- **清理只写不读的 `localDownloading`**：看着像有重入保护，实际从未被读过。

### Changed

- **peer 范围补上 `0.1.6-alpha` 线**：semver 的预发布规则要求逐条列出元组，而范围此前只列到 `0.1.5-alpha`，今天的 `alpha` 发行线（`0.1.6-alpha.1`）会一直收到 unmet-peer 告警。这条线此前已被踩过两次，所以这次的回归测试改为**从已发布版本表推导**：新增发行线时测试会直接点名要求补进范围，不再依赖手写清单。
- **设置页左侧导航标签跟随界面语言**：原先写死中英双语字符串，现在用宿主支持的 `() => string` 标签（`resolveSlotLabel` 每次读取时解析，并随语言修订重新读取）。

### Compatibility

- **逐文件核对 DSH 0.1.5-rc.1**：宿主端 `dsh-host-webserver` 与 0.1.2-rc.1 字节一致，`webServer` / `webRuntime` / `llm` 三个服务、`register({ kind: "prefix" })` 路由、`ctx.webRuntime.trustedHosts`、`ctx.llm.prepareCall` 与流式 `text-delta` / `finish.reason` 全部未变；客户端 `dsh-client-modules` / `dsh-client-ui-renderer` / `dsh-client-locale` / `dsh-client-ui-settings` 四份字节一致，`conversation.input.right` / `settings.section` 插槽契约、`inputActions.setDraft`、`useInput(s => s.draft)`、`[data-composer-card]` + Lexical contenteditable 的 DOM 形态均不变。结论：0.1.2 → 0.1.5 无需改动，插件在新宿主上行为一致。

### Tests

- 177 → **192**：新增 2 项**真实行为**测试（预览不得覆盖用户中途输入 —— 已在修复前的代码上验证必红；语音分段拼接不粘连中英文）、3 项宿主端行为测试（正则热词未写 `g` 仍全量替换、本地预润色不再给「；」补句号、非字符串 `asrApiKey` 不再 500）与 10 项客户端回归（并发下载只起一次、残桩重下、响应体取消、按住说话松开判定、`start()` 失败释放麦克风、空转写不当成功、旧字段随链删除、服务链上限、onend 看门狗、预览分片记账）。

## [0.4.9] — 2026-09-09

### Fixed

- **「润色」开关形同虚设（HIGH）**：`readPolishModel()` 只读 localStorage，而**全仓库没有任何地方写入** `POLISH_MODEL_KEY`，设置页也没有模型选择器——两处润色入口因此永远不成立：打开润色后拿到的始终是原始转写，自定义润色提示词也成了死配置。设置页新增「润色模型」下拉（选项来自宿主的 `list-models`），开启润色时自动选中第一个可用模型；没有任何可用模型时给出明确提示。
- **本地引擎「实时上屏」从未生效（MED）**：`recorder.start()` 没有传 timeslice，`ondataavailable` 只在停止时触发，于是每 3 秒的预览都拿到空 blob 并静默返回——`previewWritten` 恒为 false，所有预览回滚路径都成了死代码。现在 `start(1000)`，且每次预览只上传「容器头 + 尚未转写的分片」，避免每 3 秒重传整段录音（4.3 分钟上限时单次可达约 16MB）。
- **权限弹窗期间切窗会留下热麦克风（MED）**：`getUserMedia` 等待期间 `recording` 仍是 false，失焦逻辑看不见它；用户 Alt+Tab 后录音在后台开始、麦克风常亮，直到回来再按一次或撞上时长上限。现在失焦会标记待取消，拿到流后立即释放并取消。
- **宿主端本地转写不响应取消（MED）**：`local-transcribe` 丢弃了请求的 abort 信号，客户端超时或页面刷新后 sherpa 仍占着 CPU 解码数十秒，后续转写排在它后面一起超时、文本丢失。现在信号穿透到解码队列，已取消的请求不再入队。
- **被截断的模型下载会被当成「已就绪」（MED）**：读取循环遇到连接中断只是 `done`，截断的 `.part` 被直接改名发布，而 `startModelDownload` 会跳过任何非空文件——坏模型从此永久无法修复，报错还是识别器深处的原生堆栈。现在按 `content-length` 校验完整性（不匹配即删除重下），并给 `modelReady` 加了尺寸下限。
- **转写会覆盖用户在录音期间改动的草稿（MED）**：终稿此前一律「基线 + 转写」重建，用户中途打的字被丢弃；若中途按了回车发送，已发送的文本还会被重新塞回输入框（重复发送）。现在提交与回滚都先比对输入框是否仍是插件写入的那段预览，被改动过就改为追加。
- **Web Speech 出错时中间结果残留在输入框（LOW）**：`onerror` 之后 `onend` 直接 return，不再回滚，半句话像终稿一样留在输入框。
- **音频解码失败会泄漏 AudioContext（LOW）**：`ctx.close()` 只在成功路径执行，反复失败会耗尽浏览器的 context 配额，之后本地引擎与电平条一起失效，直到刷新页面。
- **云端客户端超时短于宿主的服务链上限（LOW）**：客户端固定 75 秒，而宿主按序尝试最多 4 个 provider、每个 60 秒——第 2 个 provider 刚要返回时客户端已中止（并连带取消在飞的请求）。现在按 provider 数量放大（1 个 75 秒，4 个 255 秒）。

### Tests

- 164 → **177**：新增 3 项草稿提交/回滚的**真实行为**测试（预览未被动 → 从基线重建；被用户改动 → 追加而非覆盖；回滚只对未改动的输入框生效）、6 项客户端形状回归（润色模型选择器、MediaRecorder timeslice、失焦取消、AudioContext 释放、Web Speech 错误回滚、超时随服务链放大），以及 4 项宿主端回归（截断下载拒收、`modelReady` 尺寸下限、已取消请求不入队、abort 信号穿透）。

## [0.4.8] — 2026-09-09

### Fixed（DSH 0.1.2 兼容性）

- **输入框里按 Alt 完全没反应（高危）**：DSH 0.1.2 把输入框从 `<textarea>` 换成了 Lexical 的 `contenteditable`，而「焦点在非输入框的可编辑元素里就跳过热键」这条保护靠的是「是否等于输入框 textarea」。于是焦点在输入框里——也就是最常见的场景——按 Alt 一律被当成「在别的输入框里打字」而忽略。现在按 `[data-composer-card]` 容器判定，输入框内按 Alt 恢复正常。
- **转写文本覆盖用户已输入的草稿（高危）**：0.1.2 的会话级插槽组件拿到的是 `useInput`（快照选择器 hook），**不再提供**已解析的 `input` 对象；插件读 `input.draft` 永远得到 `""`，「基线 + 转写」因此退化成「转写」——实时预览与终稿都会把用户已经打好的草稿整段替换掉。现在通过 `useInput((s) => s.draft)` 订阅实时草稿并存进 ref，旧壳子的 `input` 属性仍然兼容。
- **输入框 DOM 兜底彻底失效、转写文本被静默丢弃**：草稿通道尚未就绪时的 textarea 兜底在 0.1.2 里找不到任何 textarea（输入框已是 contenteditable），`setDraftText` 直接返回 false、文本丢失，状态条显示「未找到输入框」。现在 `findComposerEditor` 同时识别 textarea 与 `[contenteditable="true"]`：读取用 `innerText`，写入走 `execCommand("insertText")`，让 Lexical 的输入管线保持同步。
- **`dsh.client.inject` 仍写着已改名的包**：`@deepseek-ai/dsh-client-runtime` 自 DSH 0.1.2-alpha.2 起改名为 `@deepseek-ai/dsh-client-modules`，旧名在新宿主里解析为空（静默 no-op），启动图的模块顺序不再被声明。已同步为现名，并保留 `@deepseek-ai/dsh-client-locale`。
- **peer 范围补齐 0.1.1-rc / 0.1.3-alpha / 0.1.5-alpha 三条线**：semver 的预发布规则要求逐条列出元组，否则这些宿主会一直收到 unmet-peer 告警。

### Tests

- 156 → **164**：新增 5 项**真实行为**测试——在 `node:vm` 沙箱里加载 client bundle 并配最小 DOM 桩，验证 contenteditable 查找 / 读取 / 写入、草稿通道优先级、旧 textarea 兼容、输入框焦点判定；另有 3 项形状与清单回归（`useInput` 草稿来源、contenteditable 编辑器、`dsh.client` 包名）。

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