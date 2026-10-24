# Watchdog Notes — schwab-mcp

本文件为 OMP Advisor 专用的代码审计与安全守护指引（追加到 Advisor System Prompt，不污染主执行 Agent 上下文）。

## 核心安全审查红线（Blocker 级别）

Advisor 必须紧盯以下违反项目安全基线的行为，发现立即报告 `severity: blocker`：

1. **凭据与敏感信息防泄漏**：
   - 严禁将 API Token、OAuth Token、Client Secret、完整银行/证券账号（Account Number）、Cookie 或认证凭据写入代码、提交、日志、文档或 `wrangler.jsonc`。
   - `wrangler.jsonc` 的 `secrets.required` 仅限声明 `GITHUB_CLIENT_SECRET`、`SCHWAB_CLIENT_ID` 和 `SCHWAB_CLIENT_SECRET` 三个环境变量名称，不得硬编码值。
   - 日志与序列化输出中严禁包含未脱敏的 Token、完整账户号、Authorization Code 或请求头。对外及跨模块通信仅允许使用 Schwab 脱敏后的 `hashValue`。
   - 所有凭据、交易确认状态、Direct Trading 能力摘要、延迟交易任务仅持久化于 SQLite-backed `SchwabVault` Durable Object，严禁写入 KV 或环境变量。

2. **交易安全与权限护栏**：
   - AI 主 Agent 严禁主动发起、诱导或自行决定下单；所有交易相关工具（`prepare_trade`、直下单、撤单）必须响应用户明确的交易指令。
   - `ENABLE_TRADING` 是部署配置控制的唯一总开关（默认 `false`）。严禁绕过总开关执行交易。
   - 交易写操作仅限：
     - 建单：`POST /accounts/{hash}/orders`
     - 改单：`PUT /accounts/{hash}/orders/{orderId}`
     - 撤单：`DELETE /accounts/{hash}/orders/{orderId}`
     - 严禁添加其他未受控的交易写路径或自定义下单逻辑。
   - 增强模式（Advanced Security）下，任何建单/改单必须经由浏览器 Passkey WebAuthn 签名认领，严禁降级为会话直下或跳过认证。

3. **OAuth 与身份鉴权完整性**：
   - 授权强制使用 RFC 7636 S256 PKCE（`allowPlainPKCE: false`，仅公开 `S256`），不得放宽或降级为 Plain PKCE。
   - GitHub 身份验证必须严格校验 numeric user ID 白名单（`ALLOWED_GITHUB_USER_ID`），防止用户名变更攻击。
   - 客户端账户权限必须使用白名单机制（`AUTHORIZATION_VERSION = "client-accounts-v2"`），未授权账户绝不返回也不得接受交易指令。

## 架构与工程约束（Concern 级别）

1. **上游调用与重试策略**：
   - 交易写请求除首次 401 刷新 Token 后重试一次外，严禁自动重试；网络故障或 5xx 必须标记 `EXECUTION_UNCERTAIN` 并显式失败，严禁盲目重放。
   - 查询请求 401 仅刷新重试一次，429/5xx 仅重试一次，其他 4xx 绝不重试。
   - 严禁吞掉上游错误或以虚假空数据兜底。

2. **存储与状态边界**：
   - `OAUTH_KV` 仅用于存放 OAuth 注册与授权会话状态，严禁存放 Schwab 凭据或持久交易数据。
   - 不得随意增加新的 Worker Bindings 或外部依赖。
   - Passkey 校验必须锁死在精确版本 `@simplewebauthn/server@14.0.3`。

3. **测试与验证原则**：
   - 修改 TypeScript、OAuth、Vault 或交易逻辑后，必须通过 `npm run typecheck`、`npm run lint` 和对应测试集。
   - 跨鉴权边界改动需跑通 `npm test` 及 `npm run validate` 相关脚本。
