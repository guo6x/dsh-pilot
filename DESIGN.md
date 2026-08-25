# dsh-pilot — DESIGN

让 DSH agent 亲自上网的浏览器操控插件。纯文本模型也能用：读 DOM/结构化文本快照，不烧截图 token。人在 Web GUI 实时围观、随时接管。当前版本 v0.6.0。

## 定位

- 仓库：github.com/guo6x/dsh-pilot · 包名：`dsh-pilot` · topic: dsh-plugin
- 卖点：一条命令安装、零运行时依赖、无需 API key、用机器上已有的 Edge/Chrome
- 目标用户：DSH Web 用户，特别是纯文本模型的 agent（文本优先快照）

## 架构（当前实现）

```
DSH 对话 ──pilot_* 工具──▶ 宿主插件 ──CDP(原生 WebSocket, Node≥22)──▶ headless Edge/Chrome ×N
    ▲                             │  PilotPool：每 agent 会话一个 Pilot
    └── 结构化文本快照 ◀───────────┘  端口 9222 起动态选、LRU 上限 8
GUI 驾驶舱 ◀──/dsh-pilot/state + /dsh-pilot/shot.png（仅回环 403 外）──┘
```

### 宿主（bundle 插件，零运行时依赖）

- `Cdp`：原生 WebSocket 的 CDP 客户端（id→promise + once 事件等待）
- `Pilot`：一个浏览器实例的生命周期与操作集
  - launch：headless Edge/Chrome + 独立 `--user-data-dir`（OS 临时目录）+ 动态调试端口
  - 操作：navigate / snapshot / click / type / fill / upload / press / back / reload / wait / waitFor / assert / screenshot / evalJs / download / stop
  - 截图缓存：`lastShot` 内存 Buffer，面板路由直出
- `PilotPool`：sessionId → Pilot 映射；每次工具调用设 primary（面板跟随最近活跃）；超 8 个按 LRU 淘汰非 primary
- 路由（webServer，prefix `/dsh-pilot`，非回环 403）：GET state / shot.png；POST start / stop / navigate
  - `/state` 附带 `session`（当前 primary key）与 `sessions`（池大小）
- 工具 17 个（`inject: ['webServer', 'tools']` 保证服务就绪后才注册）：
  open / snapshot / diff / click / type / fill / upload / press / back / reload / wait / wait_for / assert / screenshot / eval / download / close
- 清理：ctx.effect 包裹路由注册、工具注册与 `pool.disposeAll()`

### 元素引用（ref）模型

- `snapshot` 在页面内遍历可交互元素（a/button/input/textarea/select/summary/ARIA roles），
  可见元素（有尺寸）编 1..200 号，`window.__pilotEls` 缓存元素引用，返回 JSON 只含描述符
- click/type 优先按 ref 解析：`window.__pilotEls[ref-1].el`
- 页面导航后 window 重建 → 旧 ref 失效，报错明确提示重取快照
- 渲染层（模型可见文本）列出编号元素，上限 60 行

### 导航落定（settling）

- click/back/reload 在触发动作**之前**注册 load 事件等待，再 race 超时（2500/3000/8000ms）
- 教训：先注册后动作——load 事件可能比监听注册更快到达（0.2.x 竞态 bug）
- `once()` 超时永不 reject（`.catch(() => {})`），waitForLoad 永不抛
- `wait_for` 轮询文本、可见 selector 和 URL；每个已提供条件都必须满足，失败会带回最后观测状态。
- `fill` 按用户可见字段名批量匹配并填写；`upload` 用 CDP 赋给真正的 file input，限制为已存在的绝对路径普通文件、最多 10 个/100 MB。

### 客户端（驾驶舱面板）

- 入口：`sidebar.footer.action`；面板：`shell.overlay`（可拖拽浮窗，模块级 store 共享开关状态）
- 轮询 `/dsh-pilot/state`（2s）+ `<img src="/dsh-pilot/shot.png?t=">` 直出截图
- 按钮/输入框带 title 属性（无障碍 + 自动化测试选择器）
- 多会话时标题栏显示 ×N 会话指示

## 已定决策（不要推翻）

- **每会话单标签**：ref 绑定当前页，多标签会摧毁 ref 模型；多上下文用 subagent（每会话独立浏览器）。
- **仅 headless**：有头模式 = 另一个产品。
- **面板跟随最近活跃会话**：池实例独立，面板只显示 primary。
- **零运行时依赖**：CDP 走原生 WebSocket（Node ≥ 22 全局自带），禁止引入 playwright/puppeteer。
- **JSON 文件禁止经 pwsh 写**（BOM 事故教训）；版本号用 node 写。
- **dsh web 进程禁止未经用户同意重启**（环境规则，见 ~/.dsh/AGENTS.md）。

## 测试

- `tests/smoke.mjs`：真 headless Edge 端到端——导航/快照/编号元素/ref 点击/落定/条件等待与断言/标签填表/select/文件上传/change 事件/过期 ref/截图建目录/下载/池隔离/primary/部分停止
- `demo/record-demo.mjs`：驾驶舱全真实链路录制（断言每次点击/输入）
- 运行：`node build.mjs && node tests/smoke.mjs`

## 发布

- GitHub 直装为主（`github:guo6x/dsh-pilot`）；npm 待 OTP 后补发
- 收录 PR：awesome-dsh-plugin #533、dsh-web-ui #213（等合并）
- docs/demo.gif：驾驶舱演示（ffmpeg 拼帧）

## 已知限制（对用户透明）

见 README「Known limitations」：单标签、headless、面板跟随策略。

## 可能的下一步（未排期）

- 弹窗与新标签页处理
- checkbox/radio 与可访问性树定位
- 可选域名白名单和敏感操作策略
- 面板多会话切换器
