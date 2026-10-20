# Advanced Security 验证与发布前验收

## 2026-10-20 验证失败时保留 Passkey

- 仪表盘和安全页不再因 `verify` / `add-verify` 的异常调用 `signalUnknownCredential`；网络中断或服务端错误不能证明凭据不存在，也不能据此通知认证器删除凭据。
- 保留原有错误提示和操作解锁逻辑。仪表盘仍提示核对服务器状态，避免提交结果不确定时盲目重试。
- 回归命令：`node --test scripts/passkey-acceptance.test.mjs scripts/dashboard-push.test.mjs`。覆盖管理、添加凭据及仪表盘验证失败路径；安全页额外覆盖网络失败、服务端错误及恢复后的重试。
- 此回归执行实际渲染出的客户端脚本，使用模拟认证器和请求；不代表 Safari / 手机真实 Passkey 或生产端到端验收。

PR #4 原始记录对应当时的本地实现；以下原始自动化结果保留为历史证据。2026-10-16 的部署复核和真实 Safari 验收见下一节。本轮未部署、未更改生产总开关及 bindings，未提交任何真实 Schwab 交易。


## 2026-10-16 部署复核与 Safari 实机验收

### 当前部署（北京时间，14:45 左右读取）

- [PR #4](https://github.com/chensirui2008/schwab-mcp/pull/4) 已合并；merge commit `669f83933c41daee43cc36a000fe9fdad330ff92`，本地开始验收时同为此提交。PR 描述中的“本 PR 不合并或部署”是历史状态。
- [main 部署工作流](https://github.com/chensirui2008/schwab-mcp/actions/runs/38851510414) 对应上述 merge commit，结果成功。
- 项目安装的 Wrangler 查询结果：最新 deployment `4be5f222-bed0-4e09-8427-2b667ab36304`，2026-10-16 12:37:44 创建，100% 指向 version 77 / `f87acb60-5dd8-4f23-82a7-52e66428d39a`。
- 线上 `APP_VERSION=0.2.0`，`ENABLE_TRADING=true`；不要从仓库模板中的 `false` 推断生产已关闭。版本元数据没有提交 SHA 标记，CI 时间与部署吻合，但本轮没有下载远端 bundle 做逐字节提交映射。
- 正式 origin：`https://schwab-mcp.siruichen461.workers.dev`；正式 RP ID：`schwab-mcp.siruichen461.workers.dev`。本机设备验收使用独立 RP ID `localhost`，不能代替正式域名、OAuth、DO 存储及 MCP 客户端整链路验收。

| 页面/端点 | 本轮验证与预期 |
| --- | --- |
| `GET /health` | 200，`{"status":"ok","version":"0.2.0"}` |
| `GET /.well-known/oauth-authorization-server` | 200；公布 `/authorize`、`/oauth/token`、`/oauth/register` 和 S256 |
| `GET /security` | 未登录 302 到 GitHub owner OAuth；`no-store`、`DENY` |
| `GET /security/approvals/:proposalId` | 用不存在的测试编号检查，未登录 302 到 GitHub；没有读取真实订单 |
| `POST /security/api/options`、`POST /security/api/verify` | 空输入、无浏览器 cookie/CSRF 时均 403 `BROWSER_AUTH_REQUIRED`，没有触发验证或交易 |
| `GET /mcp` | 无 Bearer 时 401 `invalid_token` |
| `/security/recover`、`/security/api/add-options`、`/security/api/add-verify` | 本轮仅核对本地路由，未在线发起恢复或修改凭据 |

### 无真实交易的最短复测步骤

在项目根目录运行 `node scripts/passkey-acceptance.mjs`，用 **真实 Mac Safari** 打开 `http://localhost:8791/security`。服务仅绑定 `127.0.0.1`；不读取 `.dev.vars`、Worker bindings、OAuth 或 Schwab 凭据，无任何 Schwab 调用代码。直接加载实际 `src/security-ui.ts`，使用 `@simplewebauthn/server@14.0.3` 验证原生签名；模拟批准只改变内存中的冻结提案和计数，不测试生产 DO 执行器。

| 操作 | 预期结果 |
| --- | --- |
| 1. 点击“注册首个 Passkey”，完成系统验证 | 出现系统原生提示；成功后管理页列出凭据，最后一个凭据的删除按钮禁用 |
| 2. 点击顶部“2. 新模拟订单” | 账户 `TEST_ONLY_NOT_A_SCHWAB_ACCOUNT`；`TEST_ONLY / BUY / 1 / LIMIT / 1.00 / DAY`，完整 JSON 和摘要可读；尚未请求系统验证 |
| 3. 点击“批准并提交”，在系统提示中点“取消” | 显示取消/超时提示，提案仍 `PENDING`，模拟提交计数不增加，无对话确认降级 |
| 4. 再次批准并完成系统验证，然后打开 `/status` | 提案 `EXECUTED`，首次成功为 `simulatedSubmissions:1`，始终 `realSchwabRequests:0`；新版 fixture 刷新 `/approve` 保留结果，顶部“新模拟订单”才创建新提案 |
| 5. 打开 `/unsupported` | fixture 在脚本执行前禁用能力检测；出现外部浏览器提示，所有操作按钮禁用。此步骤检验不支持分支，不表示 Safari 本身不支持 |
| 6. 窄屏检查 | 核对长摘要、账户标识、表格、JSON 和批准按钮；没有内容被横向截断。桌面缩放/窄窗口只能记布局检查 |

会话 15 分钟，提案 5 分钟；过期后重启脚本或新建模拟提案。服务重启会清空本机内存记录；系统“密码”中的测试通行密钥不会自动删除。fixture 仅实现首次注册与即时模拟批准，不承诺管理、恢复、OAuth 或延迟任务全流程。停止脚本使用 Ctrl+C。

### 本轮执行结果

设备软件：macOS 27.2（26B5112a），Safari 27.2（22625.2.8.11.6）；版本来自本机应用元数据。

| 验收项 | 结果与证据 |
| --- | --- |
| 首次注册 | 通过：用户在 Mac Safari 操作后返回 `/status`；`credentialRegistered:true`；服务使用真实 SimpleWebAuthn 校验原生注册结构 |
| 冻结订单批准 | 通过：首份提案 `4ad8336f-d6ee-4eb1-8d48-d82bd83ba12c` 为 `EXECUTED`，模拟提交 1，真实 Schwab 请求 0；随后 agent 在真实 Safari 核对了冻结预览及系统“通过触控 ID 使用通行密钥”提示 |
| 取消原生验证 | 通过：agent 新建提案 `b547de60-38a8-4ec3-9988-b353b82c7ce6` 后点击系统“取消”；Safari 显示“操作已取消或超时，订单保持未批准”，服务仍 `PENDING`，模拟提交总计维持 4，真实请求 0。中间三份额外模拟提案在取消操作前已完成系统验证，不计作取消通过证据，也不是同一提案重复提交 |
| 不支持提示 | 通过：真实 Safari 打开 `/unsupported`，显示外部浏览器提示，重命名、删除、添加按钮全部禁用 |
| 窄屏布局 | 初次在 574 CSS px 发现长摘要溢出；本地修复后 Safari `innerWidth=574, scrollWidth=574`。缩放到约 382 CSS px 后长摘要、账户、表格、JSON 和全宽批准按钮可读；`scrollWidth=383` 的 1 px 舍入差保留记录，不声明零像素溢出 |
| iPhone/Android 实机 | Mac 阶段未执行；随后用户指定 iPhone 镜像，iPhone 结果见下一节，Android 仍未执行 |
| 正式 origin / OAuth / MCP / DO 整链路 | 尚未实机验收；本轮正式环境仅端点边界探测。本机成功不代表生产端到端通过 |

### 本地修复与验证

- `src/security-ui.ts`：操作结束仅恢复原本可用的按钮，避免取消后重新启用“删除最后一个凭据”；后端原本就拒绝删除最后一个。
- `src/security-ui.ts`：主体继承 `overflow-wrap:anywhere`，修复长摘要在 Safari 窄屏横向溢出。
- `src/auth.ts`：安全头应用到最终响应，修复 `Response.json()` 提前错误响应丢失安全头的问题。线上复核时无 cookie 的 403 确实缺少这些头；本轮只修本地，生产仍需后续发布。
- 本轮 `npm run typecheck`、`npm run lint`、全量 `npm test`（120 项）和 `node --test scripts/passkey-acceptance.test.mjs`（3 项）通过。新增测试覆盖取消后的按钮状态、不支持分支、本机隔离边界及提前错误响应安全头。`npm run test:passkey-acceptance` 已加入 `npm run validate`，供后续 CI 重跑。
- 这些修复未提交、未推送、未部署。原 PR 的 118 项测试与打包记录是历史结果，不覆盖本轮新增修复。

### Mac 阶段的手机后续计划与发布门槛

不能在手机直接打开 Mac 的 `localhost`，也不能改用普通 HTTP 局域网地址冒充可用的 WebAuthn 安全上下文。手机批准前需要独立且已授权的 **可信 HTTPS 模拟环境**：使用它自己的固定 origin/RP ID、独立状态，Schwab 出站请求全部模拟，不携带生产凭据；不能仅给生产换一个域名或订单标的。Mac 阶段尚未建立该环境；后续 iPhone 镜像阶段通过临时 HTTPS 隧道提供了独立纯模拟 fixture，见下一节。

环境就绪后，在 iPhone Safari / Android Chrome 打开其 `/security` → 注册测试 Passkey → 新建模拟冻结提案 → 核对完整预览 → 取消一次并核对计数不变 → 成功批准一次并核对只加 1 → 竖屏/横屏检查 → 打开能力禁用测试页检查提示。最终记录设备型号、系统/浏览器版本和每项结果；随后在最终正式 origin 单独验证 owner OAuth、客户端安全策略及查询状态的整合，但仍不得向真实 Schwab 提交订单。

Mac 阶段结论：Mac Safari 本机注册、批准、取消及不支持分支已有真实设备证据；窄屏问题已修本地。当时手机未测，后续 iPhone 结果见下节。最终域名整链路、原清单其余项目及本地修复的正式部署仍未完成，不能据此宣布全面发布验收通过。

## 2026-10-16 iPhone 镜像补充验收（15:00–15:10）

用户随后指定使用 iPhone 镜像继续手机实测。已通过 `cloudflared` Quick Tunnel 将独立的本机 fixture 临时提供为可信 HTTPS；没有创建或部署 Worker，没有接入生产状态或 Schwab 凭据。测试 origin 为 `https://savings-acceptance-teddy-please.trycloudflare.com`，RP ID 精确为该 hostname。此地址只用于本轮，停止隧道后失效。

- iPhone 镜像连接设备名 `iPhone 17`；在设备 Safari 中操作，非桌面视口模拟。
- 首次注册由用户亲自完成，服务端真实签名验证通过，页面显示凭据；最后一个凭据的删除按钮禁用。
- 首份手机冻结模拟提案 `4ad19254-f073-4adc-9882-9ea36302a84c` 批准成功；`EXECUTED`、模拟提交 1、真实 Schwab 请求 0。页面刷新仍为同一已执行状态，计数保持 1。
- 竖屏 `innerWidth=402`、`scrollWidth=402`；长摘要、账户 hash、全部订单腿字段、JSON 和全宽按钮可读，无水平溢出。
- `/unsupported` 显示外部浏览器提示，注册按钮禁用。由 fixture 控制能力检测，不代表 iPhone Safari 本身不支持。
- 取消通过：第二份模拟提案 `9aa4af8c-b32e-4b60-bb93-fe311f3a568a` 调起手机原生 Sign In / Use Passkey 弹窗，agent 点击右上关闭按钮；页面显示“操作已取消或超时，订单保持未批准”，服务端仍 `PENDING`，模拟提交计数维持 1、真实请求 0。
- 横屏和最终正式域名整链路尚未验收，Android 未测。镜像在系统验证后偶有输入无响应，重连后恢复，未将该现象归因于网页。
- 本轮五个重点（首次注册、冻结订单批准、取消、竖屏布局、不支持提示）在真实 iPhone Safari 完成；仍不等同完整清单或生产端到端通过。

fixture 新增可选 `PASSKEY_ACCEPTANCE_ORIGIN`，仅接受精确的 HTTPS `*.trycloudflare.com` origin，注册和验证均绑定同一 RP ID；未设置时仍只使用 localhost。新增 origin/RP 绑定回归后，typecheck、lint 和 4 项 fixture 测试通过。本轮仅扩展 fixture 和记录，未进一步修改生产运行代码。临时 fixture 与隧道在验收结束后关闭，测试 public key 与提案内存随服务停止清空；系统保存的测试 Passkey 不会自动删除。

复测：先运行 `cloudflared tunnel --url http://localhost:8791 --http-host-header localhost:8791 --no-autoupdate`，取得临时 HTTPS origin，再运行 `PASSKEY_ACCEPTANCE_ORIGIN=<该 origin> node scripts/passkey-acceptance.mjs`，用手机 Safari 打开 `/security`，按上文最短流程操作；完成后停止两个进程。隧道地址持有者可访问该纯模拟服务，所以不应向 fixture 放入任何真实数据或凭据。参考 [Cloudflare Quick Tunnels 官方说明](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)。

## PR #4 原始本地验证记录

- `npm run validate`：生成类型、TypeScript、ESLint、全量 Vitest、部署配置测试和工具自省。
- 全量 Vitest：118 项通过；部署配置：2 项通过；自省：普通完整访问的 25 个工具。协议测试验证增强客户端隐藏三个对话确认/直下工具，只读客户端保持只读。
- `npx wrangler deploy --dry-run --outdir /tmp/schwab-passkey-dry-run`：本地打包成功，未上传；gzip 约 401 KiB。没有新增 Worker binding。
- 软件认证器使用本地生成的 RSA 密钥和真实 WebAuthn 注册结构、真实签名；生产密码学校验从未 mock。所有 Schwab 请求均模拟。
- 覆盖错误 origin、RP ID、缺少 UV、错误签名、跨提案/用途/浏览器重放、并发批准、合法零计数器及非递增计数器、提案和 challenge 到期、总开关关闭、提交结果不确定且禁止重放。
- 覆盖首次开启、刷新保留模式、关闭须验证、只读不能开启、旧普通授权兼容、旧 grant 撤销失败关闭、S256 PKCE 原有回归。
- 覆盖多凭据添加/重命名/删除、不能删除最后一个、恢复明确确认及原子替换、恢复作废旧会话/challenge/待批准增强提案并保留已激活任务。
- 覆盖受保护延迟任务不能降级、批准后激活及 alarm 单次执行、重复增量迁移保留旧提案及 Schwab token。

## PR #4 原始浏览器页面检查

使用 ego-browser 打开只在本机监听的临时 UI fixture，加载实际 `security-ui.ts`；该 fixture 不使用生产认证、凭据或 Schwab API。浏览器软件认证器 shim 返回真实签名，fixture 使用同一固定版本 SimpleWebAuthn 验证。此检查验证页面脚本、二进制转换和交互，不等同于生产 Worker 或真实设备 Passkey 验收。

- 首次注册后转入批准页，随后验证并显示一次模拟提交成功。
- 批准页显示账户 hash、方向、数量、价格类型、有效期和完整 JSON，以及延迟条件与截止时间。
- 390 × 844 手机视口：无横向溢出，表格和按钮可用。
- 原生 WebAuthn 返回 `NotAllowedError` 时显示取消/超时，保持未批准。
- 禁用 WebAuthn 能力后显示外部浏览器提示，并禁用操作按钮。

当前自动化浏览器的原生虚拟认证器持续返回 `NotAllowedError`。成功注册/批准的 UI 检查使用上述软件认证器 shim，不声明已通过真实操作系统或设备 Passkey 验证。

## 完整发布前人工验收清单（仍未全部完成）

在批准的测试环境使用模拟 Schwab 或测试账户边界，先保持生产交易关闭；不要以本清单推断任何真实下单授权。

- [ ] 桌面 Safari：首次注册、再次开启已有 Passkey、即时 PLACE/REPLACE 批准。
- [ ] iPhone Safari / Android Chrome：外部批准链接、系统 Passkey、跨设备使用、手机布局。
- [ ] 系统验证取消、超时、页面刷新及不支持 WebAuthn：无批准、无对话降级、无重复执行。
- [ ] 添加第二个凭据、重命名、删除一个凭据、阻止删除最后一个。
- [ ] 全部凭据丢失：独立 GitHub owner OAuth、输入“重置全部 Passkey”、替代注册成功后原子替换，旧响应失效；已激活延迟任务保留。
- [ ] 恢复后关闭 Advanced Security：仍需新 Passkey 验证。
- [ ] 同时连接普通、增强、只读客户端，核对各自工具清单、默认选择及诊断。
- [ ] 使用最终配置的回调 origin 和 RP hostname；在真实 MCP 客户端核对批准 URL 和 `get_trade_proposal` 结果。

## Trust boundary / 信任边界

Passkeys protect against a compromised MCP token or client. They do not promise resistance to compromise of the Worker, approval device, or GitHub recovery account. GitHub owner OAuth is the recovery trust entry point.
