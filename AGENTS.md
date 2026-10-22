# schwab-mcp 工程约束

## Cloudflare MCP

- 本项目的 Cloudflare MCP 配置位于本地 `.mcp.json`，包含 API、文档、Bindings、Builds 和 Observability 远程服务器。
- MCP 服务器通过 Cloudflare OAuth 授权；不得把 API token、OAuth token 或其他凭据写入仓库、`wrangler.jsonc`、日志或文档。
- `.mcp.json` 只包含公开服务器 URL，可以纳入项目配置；任何 API token、OAuth token 或其他凭据仍不得写入该文件。生产部署仍使用 Wrangler 和 Cloudflare Worker Secrets。
- `wrangler.jsonc` 的 `secrets.required` 只声明 `GITHUB_CLIENT_SECRET`、`SCHWAB_CLIENT_ID` 和 `SCHWAB_CLIENT_SECRET` 三个必需 Secret 名称，不得写入值。本地值仅放入已忽略的 `.dev.vars` 或环境专用变体；生产值仅通过 Cloudflare Worker Secrets 配置。

## 架构

- TypeScript + Cloudflare Workers；MCP 使用 `@modelcontextprotocol/server` v2 的 `createMcpHandler`，通过 `/mcp` 提供无协议会话的 Streamable HTTP。
- MCP OAuth 使用 `@cloudflare/workers-oauth-provider`，注册和授权数据存入 `OAUTH_KV`；GitHub OAuth 身份仅按 numeric user ID 匹配 `ALLOWED_GITHUB_USER_ID`。
- 所有新的 MCP OAuth 授权强制使用 RFC 7636 S256 PKCE；`allowPlainPKCE: false`，元数据只公布 `S256`。授权入口必须拒绝缺失、重复或非法的 challenge/method（challenge 为 43 字符无填充 base64url，method 精确为 `S256`），并在 consent 提交和 GitHub 回调撤销旧 grant 前复查服务端保存的请求。新 grant 的加密 props 由服务端写入 `pkceMethod: "S256"`，仅 authorization-code 换票要求该标记；密码学校验仍使用 OAuth provider。S256 单独升级不修改 `AUTHORIZATION_VERSION`，保留该版本有效 access/refresh token，升级前未兑换的 code 和不符合 S256 要求的待处理流程必须重新授权。
- MCP OAuth 使用单一 `schwab.read` 服务访问 scope，并继续通过 GitHub numeric user ID 白名单限制 owner。每个客户端在授权页独立选择 `read_only`（默认）或 `full_access`；选择只能通过绑定浏览器的一次性 consent state 传入 GitHub 身份校验流程，最终持久化在 OAuth grant 的加密 props 中。只读客户端不注册任何交易控制工具，普通完整访问客户端注册所有工具；增强完整访问客户端不注册 `confirm_trade`、`enable_session_direct_trading` 和 `place_order_direct`，实际交易仍由 `ENABLE_TRADING`、明确用户指令以及原有确认/session 能力共同约束。
- `src/oauth-access.ts` 的 `AUTHORIZATION_VERSION` 标记当前 MCP 授权政策；MCP 请求及 authorization code/refresh token 换票都必须验证版本和权限字段，旧版或缺失字段失败关闭并要求重新授权，不能在刷新时自动升级旧 grant。需要全量重新授权时显式更新此标记；普通版本更新不自动作废有效 grant。MCP 授权更新不清除 Schwab 凭据或已有延迟交易任务。
- MCP 账户授权使用 `AUTHORIZATION_VERSION = "client-accounts-v2"`，旧 access/refresh token 和未兑换 code 必须重新授权，不自动升级。GitHub numeric owner 验证后才展示脱敏账户列表，允许多选或不选（仅行情）；每个客户端的明确账户 hash 白名单存于 owner SQLite DO，grant 加密 props 保存选择快照，新增账户不自动授权。选择绑定浏览器一次性 state、origin 和 owner 会话；Advanced Security 摘要与签名绑定账户选择。不得向未验证 owner 的浏览器展示账户信息。
- DO 对账户读取、订单、交易、提案及任务操作强制校验账户白名单，读取在上游返回后复查，写入在每次提交前复查。跨账户订单只查询已授权账户，用户偏好仅返回已授权账户的脱敏字段，不暴露 streamer 信息。完整账号仅用于 DO 内临时映射，在返回序列化和日志前移除。账户权限撤回使该客户端相关已激活延迟任务进入 `PAUSED` 并保留；旧无显式账户授权的任务亦暂停，重新授权不自动恢复，需重新创建并批准。客户端可查看和取消自己因账户撤权而暂停的任务；其余账户数据仍不可访问。
- 同一客户端重新授权时，必须显式撤销其全部旧 grant 和 token，撤销全部成功后才能签发新授权；查询或撤销失败返回 HTTP 503 `temporarily_unavailable` 并记录脱敏 `requestId`，不得依赖 OAuth provider 忽略撤销错误的自动清理来保证权限降级成功。
- Schwab 凭据、交易确认状态、session 直下能力摘要、直下执行记录、延迟任务和审计摘要仅存于 SQLite-backed `SchwabVault` Durable Object，不得进入 KV 或日志。session 能力明文只允许在开启结果中返回一次，数据库仅保存 SHA-256 摘要。
- `get_trading_diagnostics` 必须始终向已认证客户端注册，并只读报告工具注册状态、`ENABLE_TRADING` 与有效交易状态，不得读取或返回 token、Secret 或账户数据。工具输入约束以 `src/schemas.ts` 为准；工具清单和部署步骤以 README 为准。`get_transactions` 对外接受 `YYYY-MM-DD`，调用 Schwab 前必须转换为覆盖完整起止日的 UTC ISO-8601 时间范围。

## Advanced Security / Passkey

- OAuth 授权页仅完整访问可开启 `Advanced Security`，新客户端默认关闭，重新授权保留最后选择。选择绑定一次性 consent state，经 GitHub numeric owner 验证后生效，MCP 输入不得更改。首次开启注册 Passkey，后续开启、关闭均验证已有 Passkey。`AUTHORIZATION_VERSION` 不变，旧 grant 缺少字段按普通模式处理。
- 新 grant 加密 props 保存 `clientId`、`advancedSecurity`、`securityPolicyVersion`；旧 grant 使用 provider 公开 `unwrapToken` 获得客户端身份。Worker 注入可信交易上下文，DO 强制校验策略版本与模式；全部旧 grant 成功撤销后才提交新策略并签发授权，策略重授权使此客户端待批准提案失效。
- 增强模式每笔即时 PLACE/REPLACE、延迟任务创建及修改必须浏览器 Passkey 批准，不得对话确认或 session 直下。`prepare_trade` 输入不变，增强结果只有批准 URL、提案编号、冻结预览、摘要和五分钟有效期，不返回确认令牌/短语。完整访问工具 `get_trade_proposal` 只查询本客户端提案状态和结果，不返回确认凭据。诊断报告模式和批准方式。
- `/security` 管理 owner 共享 Passkey；添加、重命名、删除需已有凭据验证，禁止删除最后一个。`/security/recover` 必须独立 GitHub owner OAuth，并明确输入“重置全部 Passkey”；替代凭据注册成功后原子替换全部凭据。恢复递增 owner 凭据版本，作废旧会话、challenge 和待批准增强提案，保留已激活任务及已开启策略。恢复不绕过关闭功能所需的新 Passkey 验证。GitHub 是恢复信任入口。
- 批准页读取服务器冻结订单，显示账户 hash、全部腿、方向、数量、价格类型、有效期、完整 JSON 及延迟条件。点击批准后才调用原生 WebAuthn，签名验证并原子认领后服务器直接执行/激活；重放仅返回已有状态，不重复下单。取消、超时或不支持时保持未批准，无降级。
- 浏览器使用独立安全 cookie（十五分钟），不接受 MCP Bearer 作为批准凭据；变更端点检查配置 origin、CSRF、会话及 64 KiB 实际请求大小，页面 no-store、禁止嵌入。challenge 一次性、最长两分钟且不超过提案/会话寿命，绑定会话、用途、提案摘要、客户端策略及 owner 凭据版本，签名后重新校验并在无 await 的认领阶段检查总开关与有效期。
- Passkey 验证使用精确版本 `@simplewebauthn/server@14.0.3`，注册/认证要求 UV，验证 origin、RP ID、签名、计数器（允许同步凭据的合法零值）。origin 固定取 `SCHWAB_REDIRECT_URI` 的 origin，RP ID 为其 hostname，不依据 Host 自由切换。前端只用原生 WebAuthn 与二进制转换，不加框架、构建或 CDN。
- 新状态只放 owner SQLite DO，浏览器 state/session/challenge 复用 `oauth_state`，不进 KV；迁移可重复执行，旧记录标普通模式，不重建表、不删 Schwab 凭据或交易记录、不增 Worker binding。提案和延迟任务持久保存批准方式、发起客户端及策略版本；受保护任务修改不能降级。
- 自动测试使用真实本地签名、模拟全部 Schwab 请求；实际 Safari/手机 Passkey 操作未测时必须标注为发布前人工验收。防御范围不包含 Worker、批准设备或 GitHub 恢复账户失陷。

## 同 Worker 隔离验收

- `/__test/*` 仅在可选 Worker Secret `ACCEPTANCE_KEY` 和测试 bindings 齐全时开放；Secret 不加入三个生产必需 Secret 名称，不写入配置、URL 或文档。
- 测试使用专用 `ACCEPTANCE_KV`、`AcceptanceVault` SQLite DO、独立 cookie 及每次运行独立状态；不得复用生产 owner 会话、grant、凭据或交易数据。该测试设施是原“不增 Worker binding”约束的显式例外，不改变生产 Passkey 存储策略。
- 模拟 GitHub 只进入测试状态；测试 DO 在构造时强制假凭据和交易关闭，并在路由层拒绝账户、凭据和交易访问。不得把软件认证器作为真实设备验收结果。操作步骤与证据见 `docs/oauth-navigation-validation.md`。

## 边界

- 行情和账户查询只允许 `GET`。真实建单仅允许 `POST /accounts/{hash}/orders`，改单仅允许 `PUT /accounts/{hash}/orders/{orderId}`，撤单仅允许对应 `DELETE`；其他交易写路径禁止。
- AI 不得主动建议、发起或诱导交易。`prepare_trade`、session 直下开启和每次直下建单都只能响应用户明确交易指令；工具说明和审计摘要属于客户端策略约束，不能冒充可信客户端签名。
- `ENABLE_TRADING` 是部署配置控制的唯一总开关，默认 `false`。关闭时禁止准备、确认、session 直下开启、直下建单、激活和触发建单/改单，已激活的延迟任务暂停保留；关闭 session、撤单和取消延迟任务仍允许。
- 普通模式默认即时建单和全部改单必须先冻结订单快照，再由用户复述确认短语并提交一次性令牌；增强模式改用上述浏览器 Passkey 批准。令牌五分钟过期且只能消费一次。用户可在 agent session 内显式开启仅限即时 `PLACE` 的直下能力：30 分钟无活动失效、使用时续期、最长 8 小时，并可显式关闭；能力持有证明替代逐单确认，但每笔仍须有明确用户下单指令。即时撤单免二次确认，但必须携带明确用户指令。
- session 直下能力通过只返回一次的不透明值关联，因为无协议会话 MCP 无法观察 agent session 结束；客户端应仅在当前 agent session 保存并在结束时关闭。每笔直下使用唯一 `executionKey` 原子认领，重放不得重复提交；同键不同订单失败关闭。
- 延迟交易只接受冻结的时间/Schwab 行情确定性条件。创建和任何修改必须二次确认，实际触发无需再次确认；取消免确认。每个任务必须有最长一年内的 `validUntil`，执行认领必须原子校验尚未过期；异常行情结构必须失败关闭并记录可关联事件。
- 交易写请求除首次 401 后刷新 token 并重试一次外不得自动重试。网络错误或 5xx 必须标记 `EXECUTION_UNCERTAIN`，先人工查询订单状态，禁止盲目重放。
- 订单使用官方 JSON 透传并按 UTF-8 字节限制大小，同时限制深度、节点数及敏感字段；当前不设置账户级名义金额、数量或日累计硬上限，因此普通确认流程的预览必须原样显示冻结订单和摘要；session 直下模式由用户显式选择放弃逐单预览。
- 账户工具只接受 Schwab `hashValue`。完整账号必须在序列化和日志前移除。
- 查询请求的 401 只允许刷新并重试一次；429 和 5xx 只允许重试一次；其他 4xx 不重试。
- 不添加 Streamer、后台定时刷新、行情缓存或多租户逻辑，除非产品范围明确变更并同步更新本文件和 README。授权到期提醒仅通过 MCP 成功结果的 `meta.authorizationNotice` 返回，不模拟登录，也不绕过 Schwab 的交互式重新授权。

## 修改与验证

- 修复根因，不吞错或伪造空结果；上游响应结构异常须显式失败并记录事件。新增错误须映射到稳定的公开错误码。
- 日志须脱敏，关键路径包含可关联的 `requestId`；禁止记录 token、authorization code、请求头和完整账号。
- `.github/workflows/deploy.yml` 仅在推送 `main` 时运行完整验证并部署 `wrangler.jsonc` 中的 Worker；CI 只使用 `CLOUDFLARE_ACCOUNT_ID` 和最小权限的 `CLOUDFLARE_API_TOKEN`，不得把 Worker Secrets 放入 GitHub Actions。
- TypeScript 或运行配置变更运行 `npm run typecheck`、`npm run lint` 和相关测试；跨模块或鉴权边界变更运行 `npm test`。Worker 绑定配置变更再运行 `npm run types`。纯文档修改检查命令、链接和描述，不要求运行完整代码测试。
- 大规模重构或实验先建分支。每个独立功能使用独立提交。
