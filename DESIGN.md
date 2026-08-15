# dsh-pilot — DESIGN

让 DSH agent 亲自上网的浏览器操控插件。纯文本模型也能用：读 DOM/无障碍树，不烧截图 token。人在 Web GUI 实时围观、随时接管。

## 定位与命名

- 仓库：github.com/guo6x/dsh-pilot · 包名：`dsh-pilot` · topic: dsh-plugin
- 卖点：一条命令安装、零运行时依赖、无需 API key、用机器上已有的 Edge/Chrome
- 标签行（中文 README 头条）："给你的 agent 一双会开车的手"

## 已验证的核心链路（2026-08-15 原型通过）

headless Edge → CDP(原生 WebSocket, Node≥22) → 导航/文本/截图 → modlens 视觉桥可读。
prototype/cdp-probe.mjs 已验证：启动、导航 example.com、取 title/body 文本、截图 32KB。

关键事实：
- 动态插件受限环境没有 WebSocket/child_process 全局 → 产品必须是 npm bundle（profile 插件有完整 Node 权限）
- Node 22 自带全局 WebSocket 和 fetch → 宿主端零运行时依赖
- Edge 路径（已探测）：C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe（Edg/122）
- 用户环境约定：找工具先 D 后 C；下载只进 D:\environment

## 架构

### 宿主（bundle 插件，普通 npm 包）

- BrowserController：spawn headless Edge（--remote-debugging-port 动态选 9222+，独立 user-data-dir），
  CDP 客户端（原生 WebSocket，id→promise），操作：navigate / snapshot(a11y+文本) / click / type /
  screenshot / eval / close。崩溃检测 + 自动重启。
- webServer 路由（契约已确认：`{kind,path,handler(req,res)}`，handler 拥有完整响应生命周期）：
  - GET /dsh-pilot/state —— JSON：url/title/状态/日志
  - GET /dsh-pilot/shot.png —— 当前截图（浏览器 <img> 直引，cache-bust 用 ?t=）
- harness RPC：open / close / navigate / 状态查询（客户端面板按钮用）
- agent 工具（ctx.tools 注册，pilot_ 前缀）：pilot_open, pilot_snapshot, pilot_click,
  pilot_type, pilot_screenshot, pilot_eval, pilot_close
- 截图落盘：会话工作区目录（sandboxPolicy.workspaceRoot 语义）下的临时目录
- 安全：路由只读不写盘；仅 loopback（webServer host=127.0.0.1）；无任意文件读

### 客户端

- 入口：`sidebar.footer.action`（list，侧边栏脚部，与任务看板一致）
- 面板：`shell.overlay`（list，root scope，可拖拽浮窗"驾驶舱"）：
  地址栏(URL) + 实时截图(2s 轮询 shot.png) + 操作日志 + 按钮[打开/关闭/重载/截图]
- 宿主↔客户端：截图走路由，状态/操作走 harness.handle/host.call

### 产物结构（参照 omdsh-dev/dsh-at-file）

package.json(dsh.bundle.patch + dsh.client platform:web) · cordis.patch.yml(insert 一行 id: pilot) ·
src/host + src/client(TS) → build.mjs(esbuild) → 提交 lib/ · README.md/zh · LICENSE MIT · tests/

## 关键契约速查（已从源码确认）

- WebRoute: `{ kind: 'exact'|'prefix', path: '/dsh-pilot/...', handler(req,res) }`（node:http 原生对象）
- SubprocessSpawnSpec: `{ argv, cwd, stdio:{stdin,stdout,stderr}, graceMs, signal?, env? }`（stdio 全显式）
- 工具注册：ctx.tools.register(ToolDefinition) / harness.defineTool+registerTool
- Slot 注册：slots.inject('sidebar.footer.action', () => slots.register({name, id, order, label}, props => React.createElement...))
- 客户端依赖 @deepseek-ai/dsh-client-* 走 dsh.client.inject，由 web-app 提供（同 omdsh 插件模式）

## 发布清单

- gh 已登录 guo6x（HTTPS）；git 身份在仓库本地配 user.name=guo6x + noreply 邮箱
- 发布到 npm 可选（github tarball 直装已够）；README 给一键安装 + 常见问题
- 验证：安装进 web profile → 重启 → 面板出现 → 让 agent 真实开一次网页

## 下一步

1. 骨架：package.json / cordis.patch.yml / tsconfig / build.mjs
2. 宿主实现 + 单测（CDP mock / 真 Edge 冒烟）
3. 客户端面板
4. 真机验证 + 发布
