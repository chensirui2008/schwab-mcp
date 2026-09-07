# schwab-mcp 工程约束

## 架构

- TypeScript + Cloudflare Workers；MCP 使用 `@modelcontextprotocol/server` v2 的 `createMcpHandler`，通过 `/mcp` 提供无协议会话的 Streamable HTTP。
- MCP OAuth 使用 `@cloudflare/workers-oauth-provider`，注册和授权数据存入 `OAUTH_KV`；GitHub OAuth 身份仅按 numeric user ID 匹配 `ALLOWED_GITHUB_USER_ID`。
- Schwab 凭据仅存于 SQLite-backed `SchwabVault` Durable Object，不得进入 KV、日志或 MCP 输出。
- 工具输入约束以 `src/schemas.ts` 为准；工具清单和部署步骤以 README 为准。

## 边界

- Schwab 数据 API 仅允许 `GET`，禁止下单、改单和撤单。OAuth token exchange 和 Durable Object 内部 RPC 可使用非 GET 方法，但不得承载交易指令。
- 账户工具只接受 Schwab `hashValue`。完整账号必须在序列化和日志前移除。
- 401 只允许刷新并重试一次；429 和 5xx 只允许重试一次；其他 4xx 不重试。
- 不添加 Streamer、后台定时刷新、行情缓存或多租户逻辑，除非产品范围明确变更并同步更新本文件和 README。

## 修改与验证

- 修复根因，不吞错或伪造空结果；上游响应结构异常须显式失败并记录事件。新增错误须映射到稳定的公开错误码。
- 日志须脱敏，关键路径包含可关联的 `requestId`；禁止记录 token、authorization code、请求头和完整账号。
- TypeScript 或运行配置变更运行 `npm run typecheck`、`npm run lint` 和相关测试；跨模块或鉴权边界变更运行 `npm test`。Worker 绑定配置变更再运行 `npm run types`。纯文档修改检查命令、链接和描述，不要求运行完整代码测试。
- 大规模重构或实验先建分支。每个独立功能使用独立提交。
