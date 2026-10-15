# CodexMonitor

监控本地 Codex 的运行状态，通过微信推送通知。

在 VSCode 里用 Codex 跑任务时，你不用一直盯着屏幕。CodexMonitor 常驻后台，把这些情况推到你的微信：

| | 场景 |
|---|---|
| ✅ | **任务完成** —— 哪个项目、耗时多久、结论是什么 |
| 📶 | **网络异常** —— 代理挂了 / 整体断网 |
| 📊 | **额度信息** —— 5 小时 / 7 天窗口的用量、耗尽、重置 |

## 当前状态

**可行性验证基本完成，主体功能尚未实现。**

已验证：

- [x] **微信 iLink 推送配额** —— 实测确认为 **10 条 / 次用户激活**（用户给 Bot 发一条消息即重置为 10）。
      失败时返回 `errcode: -2` / `"prepare failed"`，**但 HTTP 状态码是 200** —— 只看 HTTP 状态会把失败当成功。
- [x] **主动推送可靠性** —— 两次实测接口成功数 = 手机实收数（9=9、10=10），**未发现静默丢弃**
- [x] **登录 / 收信 / 推送全链路** —— 已跑通，凭证与 `context_token` 可跨进程复用
- [x] Codex 状态可观测性 —— `~/.codex/sessions/**/*.jsonl` 已确认可用
- [x] 网络探针设计 —— 已实测踩清代理端口漂移、DNS 污染、403 假故障等坑

待验证：

- [ ] **配额是否会 24 小时自动补满** —— 若不会，工具只能靠用户手动发消息唤醒

> ⚠️ **10 条预算是本项目的核心约束。** 它不可再生（除非用户发消息），所以推送必须分级并给告警预留额度，见设计文档。

## 技术选型

| 部分 | 选型 | 说明 |
|---|---|---|
| 语言 | TypeScript + Node.js ≥ 22 | |
| 观测 | 只读 `~/.codex/sessions/**/rollout-*.jsonl` | 不侵入 Codex 进程，不改任何配置 |
| 推送 | 微信 iLink 协议 | 经 [`@wechatbot/wechatbot`](https://www.npmjs.com/package/@wechatbot/wechatbot) 接入 |

## 工作原理

```
Watcher (只读 JSONL) ─┐
                      ├─▶ PolicyEngine (纯函数) ─▶ Notifier ─▶ 微信
NetProbe (独立定时)   ─┘
```

- **Watcher** 增量 tail Codex 的会话日志，解析出完成 / 中断 / 额度事件
- **NetProbe** 独立探测代理与 OpenAI 连通性，与 Codex 解耦
- **PolicyEngine** 负责分级、聚合、节流、配额守卫，全部是纯函数，可完整单测
- **Notifier** 走接口，iLink 只是第一个实现

## 开发

```bash
# 需要 Node.js >= 22
node -v

# 安装依赖
npm install
```

## 许可

ISC
