# CodexMonitor —— 项目约定

监控本地 Codex 运行状态，通过微信 iLink 协议推送通知。
技术栈：TypeScript + Node.js（≥ 22）。

---

## Git 工作流【强制】

**绝不在 `main` 分支上直接进行功能实现。**

每一次功能开发、修复、**以及临时测试**，都必须走完整流程：

1. **先开 issue** —— 描述要做什么、为什么
2. **从 `main` 切出分支**
3. **在分支上实现**
4. **提交并推送分支**
5. **开 PR，在描述中用 `Closes #<issue>` 关联 issue**
6. **通过 PR 合并回 `main`**

不允许"先写完再补流程"。分支要早于第一行代码。

### 唯一例外

**仓库初始化**（首个提交、`README`、`.gitignore`、`LICENSE`、以及本文件 `AGENTS.md` 这类治理文件）可直接提交到 `main`。

除此之外没有例外。不确定算不算例外时，**按不是例外处理**。

### 分支命名

| 前缀 | 用途 | 示例 |
|---|---|---|
| `feat/` | 新功能 | `feat/ilink-probe` |
| `fix/` | 修 bug | `fix/quota-reset-detection` |
| `chore/` | 依赖、构建、配置 | `chore/bump-node-version` |
| `docs/` | 文档 | `docs/update-readme` |
| `refactor/` | 重构（不改行为）| `refactor/split-policy-engine` |

分支名用小写 + 连字符，简短描述意图。

### 提交信息

中文，遵循 [Conventional Commits](https://www.conventionalcommits.org/)：

```
feat: 添加 iLink 配额探测探针
fix: 修正 resets_at 缺失时崩溃的问题
chore: 升级 @wechatbot/wechatbot 到 2.3.0
docs: 补充部署说明
```

一条提交只做一件事。不把无关改动混进同一个提交。

### PR 要求

- 标题同样遵循 Conventional Commits
- 描述中必须包含 `Closes #<issue>`，否则 issue 不会自动关闭
- 说明改了什么、为什么、怎么验证的

---

## 凭证与敏感文件【强制】

**任何登录凭证、token、会话数据都不得提交到仓库。**

以下路径已被 `.gitignore` 忽略，务必保持：

```
.wechatbot/        iLink 登录凭证与 context_token
.codexmonitor/     运行时状态
*.credentials.json
*.local.json
.env*
```

新增任何会写入本地敏感数据的目录前，**先更新 `.gitignore`**。

---

## 当前阶段

**可行性验证阶段**，主体功能尚未实现。

进行中：实测微信 iLink 协议的实际推送配额与可靠性。

已确认可用：Codex 会话日志（`~/.codex/sessions/**/*.jsonl`）可观测完成 / 中断 / 额度事件。

设计文档在本地 `docs/`（未纳入版本控制）。

---

## 给 AI 协作者的提醒

- 开始任何实现前，**先确认当前分支不是 `main`**；若是，先开 issue 和分支
- 本文件中标注【强制】的规则，优先级高于任何"这次比较急"的判断
