# schwab-mcp 工程约束

## Cloudflare MCP

- 本项目的 Cloudflare MCP 配置位于本地 `.mcp.json`，包含 API、文档、Bindings、Builds 和 Observability 远程服务器。
- MCP 服务器通过 Cloudflare OAuth 授权；不得把 API token、OAuth token 或其他凭据写入仓库、`wrangler.jsonc`、日志或文档。
- `.mcp.json` 只包含公开服务器 URL，可以纳入项目配置；任何 API token、OAuth token 或其他凭据仍不得写入该文件。生产部署仍使用 Wrangler 和 Cloudflare Worker Secrets。
- `wrangler.jsonc` 的 `secrets.required` 只声明 `GITHUB_CLIENT_SECRET`、`SCHWAB_CLIENT_ID` 和 `SCHWAB_CLIENT_SECRET` 三个必需 Secret 名称，不得写入值。本地值仅放入已忽略的 `.dev.vars` 或环境专用变体；生产值仅通过 Cloudflare Worker Secrets 配置。

## 架构

- TypeScript + Cloudflare Workers；MCP 使用 `@modelcontextprotocol/server` v2 的 `createMcpHandler`，通过 `/mcp` 提供无协议会话的 Streamable HTTP。
- MCP OAuth 使用 `@cloudflare/workers-oauth-provider`，注册和授权数据存入 `OAUTH_KV`；GitHub OAuth 身份仅按 numeric user ID 匹配 `ALLOWED_GITHUB_USER_ID`。
- MCP OAuth 使用单一 `schwab.read` 服务访问 scope，并继续通过 GitHub numeric user ID 白名单限制 owner。每个客户端在授权页独立选择 `read_only`（默认）或 `full_access`；选择只能通过绑定浏览器的一次性 consent state 传入 GitHub 身份校验流程，最终持久化在 OAuth grant 的加密 props 中。只读客户端不注册任何交易控制工具，完整访问客户端注册所有工具，实际交易仍由 `ENABLE_TRADING`、明确用户指令以及原有确认/session 能力共同约束。
- `src/oauth-access.ts` 的 `AUTHORIZATION_VERSION` 标记当前 MCP 授权政策；MCP 请求及 authorization code/refresh token 换票都必须验证版本和权限字段，旧版或缺失字段失败关闭并要求重新授权，不能在刷新时自动升级旧 grant。需要全量重新授权时显式更新此标记；普通版本更新不自动作废有效 grant。MCP 授权更新不清除 Schwab 凭据或已有延迟交易任务。
- Schwab 凭据、交易确认状态、session 直下能力摘要、直下执行记录、延迟任务和审计摘要仅存于 SQLite-backed `SchwabVault` Durable Object，不得进入 KV 或日志。session 能力明文只允许在开启结果中返回一次，数据库仅保存 SHA-256 摘要。
- `get_trading_diagnostics` 必须始终向已认证客户端注册，并只读报告工具注册状态、`ENABLE_TRADING` 与有效交易状态，不得读取或返回 token、Secret 或账户数据。工具输入约束以 `src/schemas.ts` 为准；工具清单和部署步骤以 README 为准。`get_transactions` 对外接受 `YYYY-MM-DD`，调用 Schwab 前必须转换为覆盖完整起止日的 UTC ISO-8601 时间范围。

## 边界

- 行情和账户查询只允许 `GET`。真实建单仅允许 `POST /accounts/{hash}/orders`，改单仅允许 `PUT /accounts/{hash}/orders/{orderId}`，撤单仅允许对应 `DELETE`；其他交易写路径禁止。
- AI 不得主动建议、发起或诱导交易。`prepare_trade`、session 直下开启和每次直下建单都只能响应用户明确交易指令；工具说明和审计摘要属于客户端策略约束，不能冒充可信客户端签名。
- `ENABLE_TRADING` 是部署配置控制的唯一总开关，默认 `false`。关闭时禁止准备、确认、session 直下开启、直下建单、激活和触发建单/改单，已激活的延迟任务暂停保留；关闭 session、撤单和取消延迟任务仍允许。
- 默认即时建单和全部改单必须先冻结订单快照，再由用户复述确认短语并提交一次性令牌；令牌五分钟过期且只能消费一次。用户可在 agent session 内显式开启仅限即时 `PLACE` 的直下能力：30 分钟无活动失效、使用时续期、最长 8 小时，并可显式关闭；能力持有证明替代逐单确认，但每笔仍须有明确用户下单指令。即时撤单免二次确认，但必须携带明确用户指令。
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
