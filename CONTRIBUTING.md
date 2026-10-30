# 贡献指南（Contributing Guide）

欢迎代码、缺陷报告、复现、测试、文档和翻译贡献。参与前请阅读 [行为准则](CODE_OF_CONDUCT.md)。可以用中文或英文提交 Issue / PR。

## 环境准备

- Git、Node.js **>=18** 和 npm；推荐 Node.js **24**，与发布工作流一致。
- 自动化测试无需启动 DSH、真实麦克风、ASR key 或下载 SenseVoice 模型。
- 完整集成验证需要 DSH web 或桌面端、浏览器及麦克风权限；请记录实际 DSH、浏览器、系统和插件版本，不把单元测试通过等同于完整宿主验证。

Fork 仓库后，在独立的源码目录准备环境：

```bash
git clone https://github.com/YOUR_USERNAME/dsh-voice-scribe.git
cd dsh-voice-scribe
git remote add upstream https://github.com/PensiveFei/dsh-voice-scribe.git
git switch -c fix/short-description
npm ci --ignore-scripts --omit=optional
```

上述安装方式与发布门禁一致，省略可选的 `sherpa-onnx-node` 原生依赖；测试用注入加载器覆盖本地识别行为。验证真实 SenseVoice 时，在测试源码目录运行 `npm ci`，准备支持的平台、原生依赖和模型，并在 PR 中单独记录真实推理结果。CI 的常规安装也是 `npm ci`。

不要在日常使用的 DSH profile 中执行 `npm install` 来搭建开发环境。集成测试请用单独的测试 profile，按 [README](README.md) 安装本地 `npm pack` 产物，重启宿主并刷新页面。`.gitattributes` 要求文本使用 LF；请保留它，避免 Windows 换行改变源码距离断言。

## 测试命令

在仓库根目录运行：

| 命令 | 内容 |
| --- | --- |
| `npm test` | 离线检查，以及 host、local ASR、client 行为回归 |
| `npm run lint` | CommonJS / client 语法检查；ESM 由测试导入覆盖 |
| `npm run security` | 密钥、隐私路径等静态扫描 |
| `npm run validate` | 依次运行 test、lint、security，提交前的完整门禁 |
| `npm pack --dry-run` | 检查将发布的文件清单，不上传 npm |

当前 CI 覆盖 Linux Node.js 18/20/22/24 和 Windows Node.js 24。依赖有变更时同步更新 `package-lock.json`，再用 `npm ci` 验证声明与锁文件一致。纯文档 PR 可说明未运行的检查及原因；CI 仍按仓库配置执行。

修复缺陷时增加能在旧实现上失败的回归，覆盖实际行为和边界，避免只检查实现字符串。涉及录音、权限、设备切换、取消、热键或草稿的改动，请补充真实浏览器验证；未测试的系统、原生推理或云端服务应明确列出。音频用自制的无隐私样本。

## Issue、日志与脱敏

提交前搜索已有 Issue，使用[缺陷报告](https://github.com/PensiveFei/dsh-voice-scribe/issues/new?template=bug_report.yml)或[功能建议](https://github.com/PensiveFei/dsh-voice-scribe/issues/new?template=feature_request.yml)表单。请提供插件版本或 commit、DSH / Node.js / 浏览器版本、系统和架构、安装方式、识别引擎、最短复现步骤、预期与实际结果，以及必要日志。

无日志或某项不适用时，写明原因，不要留空或编造。提交日志前手工检查并替换 API key、token、Cookie、Authorization 头、带凭据的 URL、用户名、绝对路径、设备标识、原始音频及私人转写内容。保留错误代码、调用顺序和最小上下文，避免直接附完整 profile、HAR 或设置文件；静态扫描通过不能代替人工脱敏。说明替换了哪些类别即可，不提供替换前的值。

涉及可利用漏洞、密钥或隐私数据外泄时，按 [SECURITY.md](SECURITY.md) 使用[私有漏洞报告](https://github.com/PensiveFei/dsh-voice-scribe/security/advisories/new)，不要把利用细节或真实凭据放到公开 Issue / PR。

## 提交规范与 PR

1. 从最新 `main` 建立英文分支：`fix/…`、`feat/…`、`docs/…` 或 `chore/…`；一个 PR 聚焦一个问题。
2. Commit 使用英文 Conventional Commits：`fix(client): preserve typed draft`、`feat: add an ASR adapter`、`docs: explain microphone setup`、`test: cover cancellation`、`chore(deps): update dependency`。破坏性变更用 `!` 或 `BREAKING CHANGE:` 说明迁移影响。
3. 在 PR 模板中填写问题、改动、关联 Issue、版本/系统、复现与验证命令、脱敏日志、测试边界和贡献归属。只有发布后才解决的 Issue，合并时先关联，发布后再说明可用版本并关闭。
4. 用户可见变化同步 README / `CHANGELOG.md`，功能和修复写入新的 `Unreleased` 节；包版本由维护者在发版 PR 统一调整。依赖变化必须带锁文件，避免无关格式化。
5. 合并通常采用 squash，保持线性历史。维护者保留原作者归属和已经确认的 `Co-authored-by`，不编造姓名或邮箱；若有共同实现者，在 PR 中说明其贡献和期望署名。

新增 OpenAI 兼容 `/v1/audio/transcriptions` 端点通常只需设置配置。新增协议适配请在 `lib/index.js` 的 `transcribeAudio` 附近实现，并验证取消、超时、响应预算、凭据不回显和失败回退。

## 及时致谢与明确归属（维护者）

- **首次响应目标：3 个工作日内**确认已收到，感谢具体的复现、诊断、代码或文档贡献，并说明下一步；这是一项目标，不是修复时限保证。需要较长时间时在原线程更新状态。
- 合并或作出处理决定时回复结果、验证和对应提交；拒绝或延期也说明原因。代码实现、问题报告、测试验证、审阅和文档贡献分别记录，避免将报告者写成实现者。
- 维护 [CONTRIBUTORS.md](CONTRIBUTORS.md)，记录已核实的公开贡献链接；用户可要求改名或匿名，私有漏洞披露署名前先征得同意，不发布私人邮箱。
- 每次 Release 逐项写明“变化 — 实现者 / 报告者 / 验证者 — PR / Issue 链接”，并保留“贡献者与致谢”段。GitHub 自动生成的 PR 作者清单不能覆盖报告者和其他非代码贡献，须人工补全。
- 复制 [.github/RELEASE_TEMPLATE.md](.github/RELEASE_TEMPLATE.md) 起草说明；`.github/release.yml` 仅为 GitHub 生成 release notes 配置分类，不会自动发布或发送感谢。发布前对照上个 tag 至本次 tag 的所有 PR / Issue，确认贡献归属没有遗漏；后续编辑 Release 也保留原署名。

## 发布流程（维护者）

本仓库通过 [.github/workflows/publish.yml](.github/workflows/publish.yml) 使用 npm Trusted Publishing / OIDC 发布；普通贡献者无需 npm 凭据。npm 端 Trusted Publisher 应绑定本仓库和 `publish.yml`，发布环境使用 Node.js 24、npm **>=11.5.1**。不要把长期 token 写入仓库。

1. 从 `main` 发起发版 PR：确定 SemVer 版本，将 `Unreleased` 整理为带日期的版本节，核对贡献者和对应 PR / Issue。用 `npm version patch --no-git-tag-version`（或按变化选择 `minor` / `major`）同步 `package.json` 与锁文件；检查 README、兼容性和升级说明。
2. 在干净检出中执行 `npm ci --ignore-scripts --omit=optional`、`npm run validate`、`npm pack --dry-run`。合并发版 PR，等待 `main` CI 通过；确认版本、锁文件和目标提交一致。
3. 在刚合并且 CI 已通过的提交上建立 **annotated tag**（以下 `X.Y.Z` 均替换为真实版本）：

   ```bash
   git fetch origin
   git switch main
   git pull --ff-only origin main
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

   推 tag 是首选发布入口。工作流只接受真实的 `refs/tags/vX.Y.Z`，并校验 tag、版本和提交；不要移动已发布 tag 或重用 npm 版本。
4. 查看该 tag 的 `Publish to npm` 运行。它执行门禁、只构建一次 tarball，保存 **`npm-tarball`** Actions artifact，再发布同一文件。确认日志含 `+ dsh-voice-scribe@X.Y.Z` 和 provenance；`dry_run=true` 仅为演练，不算发布完成。
5. 下载该运行保存的 `npm-tarball` artifact，用同一 tarball 作为 GitHub Release 附件。按 Release 模板填写变化、限制、升级步骤及归属，并核对 npm registry 的版本、provenance 与 tarball 完整性；registry 可有传播延迟，不因即时 404 重发。
6. 核对 GitHub 附件与 npm tarball **字节一致**，计算 SHA-256（PowerShell：`Get-FileHash <tarball> -Algorithm SHA256`；Linux：`sha256sum <tarball>`），同步 README 完整性表。发布 Release 后，回到相关 Issue / PR 致谢并给出可安装版本；随后再关闭已交付的 Issue。

补发已有 tag 或演练时可从 Actions 手动运行 `publish.yml`，明确填写 `publish_ref=refs/tags/vX.Y.Z`，演练另设 `dry_run=true`。`release: published` 也是备用入口。重复事件对已有版本会跳过；若发生发布冲突，工作流必须核实 registry 完整性与本次文件一致。若失败，先判断是否已经写入 registry，再修复；已发布版本不能覆盖，必要时用新补丁版本。不要为更新致谢修改旧版本 tarball 或历史 CHANGELOG 内容；可保留原 Release 文字并追加归属说明。
