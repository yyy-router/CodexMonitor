# CodexMonitor

监控本地 Codex 的运行状态，通过微信 / 飞书推送通知。

在 VSCode 里用 Codex 跑任务时，你不用一直盯着屏幕。CodexMonitor 常驻后台，把这些情况推到你的微信或飞书：

| | 场景 |
|---|---|
| ✅ | **任务完成** —— 哪个项目、耗时多久、结论是什么 |
| 📶 | **网络异常** —— 代理挂了 / 整体断网 |
| 📊 | **额度信息** —— 5 小时 / 7 天窗口的用量、耗尽、重置 |

## 当前状态

**可行性验证完成，主体功能尚未实现。**

已验证的关键问题：

- [x] **微信 iLink 的实际推送配额** —— 每次用户激活 10 条主动推送，自动回执也计入；耗尽返回 HTTP 200 + `errcode: -2`。详见 [AGENTS.md](AGENTS.md)
- [x] **主动推送的可靠性** —— 实测无静默丢弃（接口成功数 = 手机实收数）
- [x] **飞书自建应用推送** —— 2026-10-19 探针实测 5 项全过，结论见下
- [x] Codex 状态可观测性 —— `~/.codex/sessions/**/*.jsonl` 已确认可用
- [x] 网络探针设计 —— 已实测踩清代理端口漂移、DNS 污染、403 假故障等坑

飞书探针结论（2026-10-19）：

- **私聊无需先互动** —— 同租户自建应用可直接调 `im/v1/messages` 发私聊
- **token 时间门控** —— `tenant_access_token` 有效期 2 小时，剩余 ≥30 分钟复用，与用户是否回消息无关
- **open_id 可直接解析** —— 用手机号 / 邮箱调 `contact/v3/users/batch_get_id`，无需事件订阅
- **单聊限流约 5 QPS** —— 超限返回 `230020`，需退避重试
- **无「10 条额度」模型** —— 不需要 iLink 式的配额守卫，投递靠上游聚合节流

## 技术选型

| 部分 | 选型 | 说明 |
|---|---|---|
| 语言 | TypeScript + Node.js ≥ 22 | |
| 观测 | 只读 `~/.codex/sessions/**/rollout-*.jsonl` | 不侵入 Codex 进程，不改任何配置 |
| 推送 | 微信 iLink / 飞书企业自建应用 | 微信经 [`@wechatbot/wechatbot`](https://www.npmjs.com/package/@wechatbot/wechatbot) 接入；飞书走官方 Open API，无额外 SDK |

## 工作原理

```
Watcher (只读 JSONL) ─┐
                      ├─▶ PolicyEngine (纯函数) ─▶ Notifier ─▶ 微信 / 飞书
NetProbe (独立定时)   ─┘
```

- **Watcher** 增量 tail Codex 的会话日志，解析出完成 / 中断 / 额度事件
- **NetProbe** 独立探测代理与 OpenAI 连通性，与 Codex 解耦
- **PolicyEngine** 负责分级、聚合、节流、配额守卫，全部是纯函数，可完整单测
- **Notifier** 走通道中性的接口，飞书实现已完成，iLink 待实现，由 `notify.channel` 切换

## 推送通道

单一配置文件 `codexmonitor.config.json`，通道专属字段以段名为前缀，用 `notify.channel` 切换：

| 通道 | 配置段 | 说明 |
|---|---|---|
| `ilink`（默认） | `ilink.*` | 微信 iLink；登录凭证存 `~/.wechatbot`，不入库 |
| `feishu` | `feishu.*` | 飞书企业自建应用；需 `feishu.appId` / `feishu.appSecret`，以及用于解析 open_id 的 `feishu.email` 或 `feishu.mobile`（邮箱优先） |

```json
{
  "notify": { "channel": "feishu" },
  "feishu": {
    "appId": "cli_xxx",
    "appSecret": "...",
    "email": "you@corp.com",
    "mobile": ""
  }
}
```

> 配置加载（`loadConfig`）与组装（`main()`）尚为 stub：配置结构与飞书通道实现已就绪，接线留待后续 issue。

## 开发

```bash
# 需要 Node.js >= 22
node -v

# 安装依赖
npm install

# 类型检查
npm run typecheck

# 单元测试
npm test
```

## 许可

ISC
