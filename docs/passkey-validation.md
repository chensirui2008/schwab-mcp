# Advanced Security 验证与发布前验收

本记录对应本地实现，未推送、未部署，也未连接真实 Schwab 交易。生产总开关及 bindings 未更改。

## 已完成的本地验证

- `npm run validate`：生成类型、TypeScript、ESLint、全量 Vitest、部署配置测试和工具自省。
- 全量 Vitest：118 项通过；部署配置：2 项通过；自省：普通完整访问的 25 个工具。协议测试验证增强客户端隐藏三个对话确认/直下工具，只读客户端保持只读。
- `npx wrangler deploy --dry-run --outdir /tmp/schwab-passkey-dry-run`：本地打包成功，未上传；gzip 约 401 KiB。没有新增 Worker binding。
- 软件认证器使用本地生成的 RSA 密钥和真实 WebAuthn 注册结构、真实签名；生产密码学校验从未 mock。所有 Schwab 请求均模拟。
- 覆盖错误 origin、RP ID、缺少 UV、错误签名、跨提案/用途/浏览器重放、并发批准、合法零计数器及非递增计数器、提案和 challenge 到期、总开关关闭、提交结果不确定且禁止重放。
- 覆盖首次开启、刷新保留模式、关闭须验证、只读不能开启、旧普通授权兼容、旧 grant 撤销失败关闭、S256 PKCE 原有回归。
- 覆盖多凭据添加/重命名/删除、不能删除最后一个、恢复明确确认及原子替换、恢复作废旧会话/challenge/待批准增强提案并保留已激活任务。
- 覆盖受保护延迟任务不能降级、批准后激活及 alarm 单次执行、重复增量迁移保留旧提案及 Schwab token。

## 浏览器页面检查

使用 ego-browser 打开只在本机监听的临时 UI fixture，加载实际 `security-ui.ts`；该 fixture 不使用生产认证、凭据或 Schwab API。浏览器软件认证器 shim 返回真实签名，fixture 使用同一固定版本 SimpleWebAuthn 验证。此检查验证页面脚本、二进制转换和交互，不等同于生产 Worker 或真实设备 Passkey 验收。

- 首次注册后转入批准页，随后验证并显示一次模拟提交成功。
- 批准页显示账户 hash、方向、数量、价格类型、有效期和完整 JSON，以及延迟条件与截止时间。
- 390 × 844 手机视口：无横向溢出，表格和按钮可用。
- 原生 WebAuthn 返回 `NotAllowedError` 时显示取消/超时，保持未批准。
- 禁用 WebAuthn 能力后显示外部浏览器提示，并禁用操作按钮。

当前自动化浏览器的原生虚拟认证器持续返回 `NotAllowedError`。成功注册/批准的 UI 检查使用上述软件认证器 shim，不声明已通过真实操作系统或设备 Passkey 验证。

## 发布前人工验收（未完成）

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
