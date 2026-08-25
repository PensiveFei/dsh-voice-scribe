# 贡献指南（Contributing Guide）

## 环境

- Node.js >= 18
- 本地可运行的 DSH web（`dsh web`）

## 开发

```bash
npm test           # 离线单元测试
npm run lint       # 语法检查
npm run security   # 密钥/路径泄露扫描
npm run validate   # 发布前全量验证
```

## 提 PR

1. 分支命名：`fix/xxx`、`feat/xxx`（英文）
2. Commit 用英文 Conventional Commits
3. 一个 PR 只做一件事；PR 描述含问题 + 改动 + 验证
4. 发布前检查：无本地绝对路径泄露、无密钥、README 与版本同步

## 新增 ASR 端点

在设置中配置任意 OpenAI 兼容 `/v1/audio/transcriptions` 端点即可，无需改代码。
若需要新的协议（如豆包原生 WebSocket），在 `lib/index.js` 的 `transcribeAudio` 旁新增适配函数。
