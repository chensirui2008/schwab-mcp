# schwab-mcp 工程约束

## 架构

- 运行时：TypeScript + Cloudflare Workers。
- MCP：`@modelcontextprotocol/server` v2 的 `createMcpHandler`，无协议会话 Streamable HTTP，入口为 `/mcp`。
- MCP OAuth：`@cloudflare/workers-oauth-provider`，注册和授权数据放在 `OAUTH_KV`。
- 上游身份：GitHub OAuth，只用 numeric user ID 对照 `ALLOWED_GITHUB_USER_ID`。
- Schwab 凭据：只放在 SQLite-backed `SchwabVault` Durable Object。不得放入 KV、日志或 MCP 输出。
- `src/schemas.ts` 是工具输入约束的单一来源；工具清单和部署步骤以 README 为单一来源。

## 不可破坏的边界

- Schwab 数据 API 只能发出 `GET`。不得添加下单、改单、撤单或任何 Schwab 数据端点的 `POST`、`PUT`、`DELETE`。
- OAuth token exchange 和 Durable Object 内部 RPC 可以使用非 GET 方法；它们不得承载交易指令。
- 账户工具只接受 Schwab `hashValue`。完整账号必须在序列化和日志前移除。
- 401 只允许刷新并重试一次；429 和 5xx 只允许重试一次；其他 4xx 不重试。
- 不吞掉错误，不返回伪造的空结果。新增错误必须映射到稳定的公开错误码并留下脱敏日志。
- 不添加 Streamer、后台定时刷新、行情缓存或多租户逻辑，除非产品范围明确变更并同步更新本文件和 README。

## 修改与验证

- 关键路径日志至少包含可关联的 `requestId`；不得记录 token、authorization code、请求头和完整账号。
- 修复根因；上游响应结构异常时显式失败并记录事件。
- 每次修改后运行 `npm run typecheck`、`npm run lint` 和 `npm test`。配置变更再运行 `npm run types`。
- 大规模重构或实验先建分支。每个独立功能使用独立提交。
