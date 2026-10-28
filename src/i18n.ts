export type SupportedLang = "zh-CN" | "en-US";

export const DEFAULT_LANG: SupportedLang = "zh-CN";
export const SUPPORTED_LANGS: readonly SupportedLang[] = ["zh-CN", "en-US"] as const;

export function resolveLang(langCandidate?: string | null): SupportedLang {
  if (!langCandidate) return DEFAULT_LANG;
  const normalized = langCandidate.toLowerCase().trim();
  if (normalized.startsWith("en")) return "en-US";
  if (normalized.startsWith("zh")) return "zh-CN";
  return DEFAULT_LANG;
}

export type LangRequestSource =
  | Request
  | { req: { header: (name: string) => string | undefined; query: (name: string) => string | undefined } }
  | { header: (name: string) => string | undefined; query: (name: string) => string | undefined };

export function getRequestLang(source: LangRequestSource): SupportedLang {
  try {
    const target = "req" in source ? source.req : source;
    const queryLang = "query" in target ? target.query("lang") : new URL(target.url).searchParams.get("lang");
    if (queryLang) return resolveLang(queryLang);

    const cookieHeader = "header" in target ? target.header("Cookie") : target.headers.get("Cookie");
    if (cookieHeader) {
      const match = cookieHeader.match(/(?:^|;\s*)(?:__Host-)?schwab_lang=([^;]+)/);
      if (match?.[1]) return resolveLang(match[1]);
    }

    const acceptLang = "header" in target ? target.header("Accept-Language") : target.headers.get("Accept-Language");
    if (acceptLang) {
      let selected: SupportedLang = DEFAULT_LANG;
      let bestQuality = 0;
      for (const entry of acceptLang.split(",")) {
        const [range = "", ...parameters] = entry.trim().split(";");
        if (!/^(en|zh)(?:-|$)/i.test(range)) continue;
        const qualityParameter = parameters.find(parameter => parameter.trim().toLowerCase().startsWith("q="));
        const quality = qualityParameter === undefined ? 1 : Number(qualityParameter.trim().slice(2));
        if (quality > bestQuality && quality <= 1) {
          selected = resolveLang(range);
          bestQuality = quality;
        }
      }
      return selected;
    }
  } catch {
    // Fallback to default on any parsing issue
  }

  return DEFAULT_LANG;
}

export interface I18nDictionary {
  common: {
    brandTitle: string;
    langName: string;
    switchLangName: string;
    switchLangCode: SupportedLang;
    switchLangTitle: string;
    ok: string;
    cancel: string;
    close: string;
    refresh: string;
    refreshAll: string;
    status: string;
    action: string;
    actions: string;
    loading: string;
    time: string;
    backToDashboard: string;
    unknown: string;
    none: string;
    verified: string;
    confirm: string;
    delete: string;
    rename: string;
    save: string;
    error: string;
    empty: string;
    active: string;
    expired: string;
    prevPage: string;
    nextPage: string;
  };
  auth: {
    gitHubContinueTitle: string;
    gitHubContinueNotice: string;
    gitHubContinueLink: string;
    authorizeTitle: string;
    gatewayTag: string;
    incomingChallengeTag: string;
    consentHeading: string;
    consentSubtitle: string;
    clientLabel: string;
    redirectUriLabel: string;
    readAccountTitle: string;
    readAccountDesc: string;
    tradingPolicyTitle: string;
    tradingPolicyDesc: string;
    permissionLegend: string;
    readOnlyTitle: string;
    readOnlyDesc: string;
    fullAccessTitle: string;
    fullAccessDesc: string;
    advancedSecurityTitle: string;
    advancedSecurityDesc: string;
    githubOwnerNotice: string;
    continueButton: string;
    footerHint: string;
    footerBrand: string;
    passkeyAuthorizedTitle: string;
    passkeyAuthorizedHeading: string;
    passkeyAuthorizedSubtitle: string;
    passkeyStatusValue: string;
    passkeySecurityValue: string;
    schwabConnectedTitle: string;
    schwabConnectedHeading: string;
    schwabConnectedSubtitle: string;
    schwabStatusValue: string;
    schwabSecurityValue: string;
    statusLabel: string;
    securityLabel: string;
    completionNotice: string;
    doneCloseButton: string;
    closeTabHint: string;
    completionFooter: string;
  };
  security: {
    orderApprovalTitle: string;
    orderApprovalSubtitle: string;
    zeroKnowledgeNotice: string;
    proposalStatus: string;
    approvalDeadline: string;
    intentDigest: string;
    accountLabel: string;
    actionLabel: string;
    symbolSide: string;
    quantity: string;
    priceType: string;
    duration: string;
    seeJson: string;
    keyProtectionTitle: string;
    keyProtectionDesc: string;
    tamperProofTitle: string;
    tamperProofDesc: string;
    approveSubmitBtn: string;
    rejectOrderBtn: string;
    invokeHardwareBtn: string;
    approveHint: string;
    executionOutcome: string;
    batchCount: string;
    batchOrder: string;
    batchReplacementId: string;
    batchWarning: string;
    batchApprove: string;
    batchReject: string;
    batchResults: string;
    frozenTitle: string;
    frozenDesc: string;
    authenticatorReady: string;
    authenticatorMeta: string;
    recoverTitle: string;
    recoverSubtitle: string;
    recoverNotice: string;
    resetConfirmLabel: string;
    resetConfirmHint: string;
    resetConfirmPlaceholder: string;
    replacementKeyLabel: string;
    replacementKeyDefault: string;
    resetSubmitBtn: string;
    securityManagerTitle: string;
    securityManagerSubtitle: string;
    registeredPasskeys: string;
    activeCount: string;
    rename: string;
    delete: string;
    cannotDeleteLast: string;
    keyNameLabel: string;
    keyNameDefault: string;
    addKeyBtn: string;
    registerFirstKeyBtn: string;
    noKeysNotice: string;
    sessionExpiryHint: string;
    keyManagement: string;
    lostKeyRecovery: string;
    disclaimer: string;
    clientAuthTitle: string;
    clientAuthAwaitingHeading: string;
    clientAuthHeading: string;
    clientAuthAwaitingSubtitle: string;
    clientAuthSubtitle: string;
    requestingClient: string;
    permissionLevel: string;
    fullAccessTag: string;
    readOnlyTag: string;
    advancedSecurityOn: string;
    advancedSecurityOff: string;
    redirectUri: string;
    expiresAt: string;
    digest: string;
    statusAwaiting: string;
    newPasskeyName: string;
    approveRequestBtn: string;
    registerAndApproveBtn: string;
    cancelRequestBtn: string;
    approvedNotice: string;
    scriptVerifyingPrompt: string;
    scriptCancelledOrTimeout: string;
    scriptUnsupported: string;
    scriptVerifySuccess: string;
    scriptAuthResume: string;
  };
  dashboard: {
    pageTitle: string;
    skipLink: string;
    sysTitle: string;
    sysSubtitle: string;
    notRefreshed: string;
    refreshAllBtn: string;
    schwabLink: string;
    runtimeEngine: string;
    browserEnclave: string;
    schwabConnected: string;
    schwabReauth: string;
    schwabExpiringSoon: string;
    schwabReading: string;
    schwabReadFailed: string;
    linkedAccounts: string;
    noLinkedAccounts: string;
    accountsReadFailed: string;
    accessExpiry: string;
    refreshExpiry: string;
    securityProtocol: string;
    reconnectSchwab: string;
    tradingReading: string;
    tradingEnabled: string;
    tradingDisabled: string;
    tradingUnknown: string;
    tradingSwitchDesc: string;
    overviewReading: string;
    overviewCounts: string;
    legacyGrantNotice: string;
    sessionState: string;
    sessionActive: string;
    sessionExpired: string;
    sessionDesc: string;
    securityCenter: string;
    reloginRenew: string;
    sessionReloginBtn: string;
    webauthnUnsupported: string;
    tabInbox: string;
    tabClients: string;
    tabAudit: string;
    tabPasskeys: string;
    tabSettings: string;
    inboxTitle: string;
    inboxSubtitle: string;
    refreshInbox: string;
    pendingApprovals: string;
    pendingCountTag: string;
    checkingPending: string;
    noPending: string;
    notificationHistory: string;
    unreadCountTag: string;
    loadingNotifications: string;
    noNotifications: string;
    read: string;
    unread: string;
    markAsRead: string;
    viewDetails: string;
    proceedToApproval: string;
    colTime: string;
    colType: string;
    colSummary: string;
    colStatus: string;
    colAction: string;
    paginationInfo: string;
    clientsTitle: string;
    clientsSubtitle: string;
    refreshClients: string;
    colClient: string;
    colPermission: string;
    colAdvancedSecurity: string;
    colTimestamps: string;
    colActions: string;
    noClients: string;
    revoked: string;
    authorized: string;
    permReadOnly: string;
    permFullAccess: string;
    permPolicyNote: string;
    modeEnhanced: string;
    modeStandard: string;
    policyVersion: string;
    fullAccessOnlyNote: string;
    createdAt: string;
    lastInvocationAt: string;
    neverInvoked: string;
    revokeBtn: string;
    revokeConfirm: string;
    revokedSuccess: string;
    permissionUpdated: string;
    auditTitle: string;
    auditSubtitle: string;
    refreshAudit: string;
    statMatchedCalls: string;
    statSuccessRate: string;
    statSuccess: string;
    statError: string;
    statActive24h: string;
    filterClientLabel: string;
    filterClientPlaceholder: string;
    filterToolLabel: string;
    filterToolPlaceholder: string;
    filterStatusLabel: string;
    filterAllStatus: string;
    filterSuccess: string;
    filterError: string;
    applyFilter: string;
    clearFilter: string;
    colTool: string;
    colDuration: string;
    colSummaryParams: string;
    colRequestId: string;
    noAuditItems: string;
    noSummary: string;
    passkeysTitle: string;
    passkeysSubtitle: string;
    refreshPasskeys: string;
    statClientsCount: string;
    statTotalCalls: string;
    statPasskeysCount: string;
    noPasskeysRegistered: string;
    promptNewKeyName: string;
    deleteConfirm: string;
    cannotDeleteLast: string;
    ownerSharedCount: string;
    noPasskeyProtection: string;
    addKeyWithVerify: string;
    registerFirstKey: string;
    addKeyLabel: string;
    addKeyDefaultValue: string;
    addKeyStepHint: string;
    recoveryNotice: string;
    disasterRecoveryBtn: string;
    settingsTitle: string;
    settingsSubtitle: string;
    refreshSettings: string;
    pushTitle: string;
    pushBadgeChecking: string;
    pushBadgeUnsupported: string;
    pushBadgeEnabled: string;
    pushBadgeDisabled: string;
    pushBadgePermDenied: string;
    pushBadgePermGrantedUnsubscribed: string;
    pushBadgePermGrantedNotActive: string;
    pushBadgeServiceUnavailable: string;
    pushBadgePendingLookup: string;
    pushBadgePendingSubscription: string;
    pushBadgePendingRegistration: string;
    pushBadgePendingUnsubscribe: string;
    permChecking: string;
    permGranted: string;
    permDenied: string;
    permDefault: string;
    permUnsupported: string;
    pushHint1: string;
    pushHint2: string;
    deviceLabel: string;
    devicePlaceholder: string;
    enablePushBtn: string;
    disablePushBtn: string;
    sendTestBtn: string;
    registeredDevices: string;
    unsubscribeDeviceConfirm: string;
    colDeviceId: string;
    colDeviceName: string;
    colDeviceTime: string;
    pwaTitle: string;
    pwaChecking: string;
    pwaStandalone: string;
    pwaBrowser: string;
    pwaInstallBtn: string;
    pwaIosGuideTitle: string;
    pwaIosStep1: string;
    pwaIosStep2: string;
    pwaIosStep3: string;
    pwaIosStep4: string;
    dialogTitle: string;
    dialogCancel: string;
    dialogConfirm: string;
    footerStatus: string;
    footerSecurity: string;
    sessionExpiredError: string;
    networkError: string;
    invalidJsonError: string;
    sessionExpiredMessage: string;
    passkeyCancelledOrTimeout: string;
    passkeyOperationSuccess: string;
    connectingPushService: string;
    connectingPushTimeout: string;
    readingPushTimeout: string;
    pushServiceRequest: string;
    pushServiceTimeout: string;
    disablePushFailed: string;
    enablePushSuccess: string;
    disablePushSuccess: string;
    testPushSent: string;
    testPushFailed: string;
    tradeProposalTag: string;
    clientAuthTag: string;
  };
}

const DICTIONARY_ZH_CN: I18nDictionary = {
  common: {
    brandTitle: "SCHWAB MCP",
    langName: "简体中文",
    switchLangName: "English",
    switchLangCode: "en-US",
    switchLangTitle: "切换语言",
    ok: "确定",
    cancel: "取消",
    close: "关闭",
    refresh: "刷新",
    refreshAll: "刷新全部",
    status: "状态",
    action: "操作",
    actions: "操作",
    loading: "加载中…",
    time: "时间",
    backToDashboard: "返回控制面板",
    unknown: "未知",
    none: "无",
    verified: "已验证",
    confirm: "确认",
    delete: "删除",
    rename: "重命名",
    save: "保存",
    error: "错误",
    empty: "暂无数据",
    active: "活跃",
    expired: "已过期",
    prevPage: "← 上一页",
    nextPage: "下一页 →",
  },
  auth: {
    gitHubContinueTitle: "正在跳转 GitHub 验证 · Schwab MCP",
    gitHubContinueNotice: ">_ 正在跳转至 GitHub 身份验证…",
    gitHubContinueLink: "若未自动跳转，点击继续验证",
    authorizeTitle: "客户端授权 · Schwab MCP",
    gatewayTag: ">_ SCHWAB_MCP // OAUTH_CONSENT_GATEWAY",
    incomingChallengeTag: ">_ OAUTH 2.1 INCOMING CLIENT CHALLENGE",
    consentHeading: "允许连接 Schwab MCP？",
    consentSubtitle: "客户端正在申请连接您的个人 Charles Schwab MCP 实例",
    clientLabel: "客户端标识",
    redirectUriLabel: "重定向回调地址",
    readAccountTitle: "账户与行情读取",
    readAccountDesc: "允许查询实时报价、历史 K 线、期权链、账户资产与交易流水。",
    tradingPolicyTitle: "受控交易与安全防护",
    tradingPolicyDesc: "仅完整访问可使用交易工具；受部署总开关、明确用户指令及二次确认保护。",
    permissionLegend: "选择此客户端的权限等级",
    readOnlyTitle: "只读 · Read only",
    readOnlyDesc: "允许读取账户与行情；不向模型暴露交易工具。",
    fullAccessTitle: "完整访问 · Full access",
    fullAccessDesc: "向模型暴露所有工具；保留现有二次确认、session 直下模式和撤单规则。",
    advancedSecurityTitle: "Advanced Security · Passkey 订单批准",
    advancedSecurityDesc: "仅完整访问可开启。每笔建单、改单及延迟任务创建和修改均需浏览器 Passkey 批准；禁止 session 直下。设置按客户端生效。",
    githubOwnerNotice: "点击继续将跳转至 <strong>GitHub</strong> 验证拥有者身份（数字 ID 白名单）。",
    continueButton: "继续 GitHub 身份验证并授权",
    footerHint: "如非本人操作请直接关闭页面",
    footerBrand: "Charles Schwab MCP",
    passkeyAuthorizedTitle: "授权完成 · Schwab MCP",
    passkeyAuthorizedHeading: "授权完成",
    passkeyAuthorizedSubtitle: "Passkey 批准已完成，可返回控制面板，或返回 MCP 客户端查看执行状态与结果。",
    passkeyStatusValue: "已通过 Passkey 批准",
    passkeySecurityValue: "Passkey 身份验证已通过",
    schwabConnectedTitle: "Schwab 已连接 · Schwab MCP",
    schwabConnectedHeading: "Schwab 账户已成功连接",
    schwabConnectedSubtitle: "OAuth 凭据已安全持久化至 SQLite 隔离存储 · 守护进程运行中",
    schwabStatusValue: "已授权绑定",
    schwabSecurityValue: "SchwabVault 加密隔离",
    statusLabel: "连接状态",
    securityLabel: "安全防护",
    completionNotice: "您现在可以安全关闭此浏览器窗口，并返回您的 MCP 客户端继续使用。",
    doneCloseButton: "完成并关闭页面",
    closeTabHint: "若浏览器限制脚本自动关闭，请直接关闭当前标签页",
    completionFooter: "Charles Schwab MCP · 个人专用高安全实例",
  },
  security: {
    orderApprovalTitle: "订单 Passkey 硬件批准",
    orderApprovalSubtitle: "核对订单明细并使用 Passkey 授权执行 · 严格防篡改保障",
    zeroKnowledgeNotice: "• 零降级执行保障：受保护订单必须通过原生生物识别或硬件密钥批准，禁止对话降级。",
    proposalStatus: "提案状态",
    approvalDeadline: "批准截止",
    intentDigest: "意图摘要",
    accountLabel: "账户标识",
    actionLabel: "操作类型",
    symbolSide: "标的 / 方向",
    quantity: "数量",
    priceType: "价格类型 / 价格",
    duration: "有效期",
    seeJson: "见 JSON",
    keyProtectionTitle: "硬件级密钥保护",
    keyProtectionDesc: "私钥安全保存在本机 Secure Enclave 或硬件安全密钥中，永不离境。",
    tamperProofTitle: "零对话降级与防篡改",
    tamperProofDesc: "建单、改单及策略变更需经浏览器生物识别核验，防御客户端凭据失陷。",
    approveSubmitBtn: "⚡ 批准并提交 (Approve via Passkey)",
    rejectOrderBtn: "拒绝订单",
    invokeHardwareBtn: "调起系统硬件验证",
    approveHint: "验证成功后服务器立即提交即时订单或激活延迟任务。无对话确认降级。",
    executionOutcome: "执行结果",
    batchCount: "订单数量",
    batchOrder: "订单",
    batchReplacementId: "被替换订单 ID",
    batchWarning: "批量提交不是原子操作，不会回滚已提交订单。明确拒绝后继续提交下一单；结果不确定时停止，剩余订单不提交。",
    batchApprove: "使用 Passkey 批准并提交全部订单",
    batchReject: "拒绝全部订单",
    batchResults: "各订单执行结果",
    frozenTitle: "schwab_place_order.json [FROZEN]",
    frozenDesc: "请核对账户标识、每条订单腿的买卖方向及数量、价格类型、有效期；延迟订单同时核对条件和截止时间。下列完整 JSON 是本次批准并执行的内容。",
    authenticatorReady: "硬件认证器就绪：Apple Secure Enclave / YubiKey / FIDO2",
    authenticatorMeta: "FIDO2 Level 3 硬件凭据 · 强制 WebAuthn 用户验证 (User Verification)",
    recoverTitle: "恢复 Passkey",
    recoverSubtitle: "本流程已独立完成 GitHub owner OAuth 验证",
    recoverNotice: "GitHub 账户是凭据恢复的信任入口。新凭据注册成功前不删除旧凭据。完成后旧凭据、浏览器会话、challenge 和待批准增强提案全部失效；已激活延迟任务保留，Advanced Security 保持开启。",
    resetConfirmLabel: "输入重置确认",
    resetConfirmHint: "必须精确匹配",
    resetConfirmPlaceholder: "输入“重置全部 Passkey”",
    replacementKeyLabel: "替代凭据名称",
    replacementKeyDefault: "替代 Passkey",
    resetSubmitBtn: "重置全部 Passkey 并注册替代凭据",
    securityManagerTitle: "Advanced Security",
    securityManagerSubtitle: "设置按客户端生效。其他未开启客户端仍沿用对话确认与 session 直下策略。",
    registeredPasskeys: "已绑定 Passkey",
    activeCount: "{n} 个活跃凭据",
    rename: "重命名",
    delete: "删除",
    cannotDeleteLast: "最后一个凭据不可删除",
    keyNameLabel: "Passkey 名称",
    keyNameDefault: "我的 Passkey",
    addKeyBtn: "添加新 Passkey",
    registerFirstKeyBtn: "注册首个 Passkey",
    noKeysNotice: "尚未绑定任何 Passkey。绑定硬件安全密钥或生物识别以保护您的账户。",
    sessionExpiryHint: "浏览器会话 15 分钟有效 · 验证 challenge 最长 2 分钟",
    keyManagement: "凭据管理",
    lostKeyRecovery: "全部 Passkey 丢失：通过独立 GitHub OAuth 恢复",
    disclaimer: "本功能防御 MCP 令牌或客户端失陷，不承诺抵抗 Worker、批准设备或 GitHub 恢复账户被控制。",
    clientAuthTitle: "客户端授权核准 · Schwab MCP",
    clientAuthAwaitingHeading: "等待 Passkey 硬件核准",
    clientAuthHeading: "客户端访问权限申请",
    clientAuthAwaitingSubtitle: "请在已绑定的 iPhone PWA 或其他已登录设备上使用 Passkey 批准此请求，或在下方使用本机 Passkey。",
    clientAuthSubtitle: "请仔细核对客户端信息与权限设置，使用绑定的 Passkey 核准本次授权。",
    requestingClient: "申请客户端",
    permissionLevel: "权限等级",
    fullAccessTag: "完整访问 FULL ACCESS",
    readOnlyTag: "只读权限 READ ONLY",
    advancedSecurityOn: "开启（每笔交易强制 Passkey 批准）",
    advancedSecurityOff: "关闭",
    redirectUri: "回调地址",
    expiresAt: "截止时间",
    digest: "请求摘要 (Digest)",
    statusAwaiting: "正在等待 Passkey 硬件核准中…（每 2 秒同步状态）",
    newPasskeyName: "新 Passkey 名称",
    approveRequestBtn: "使用 Passkey 批准此请求",
    registerAndApproveBtn: "注册首个 Passkey 并批准",
    cancelRequestBtn: "取消本次申请",
    approvedNotice: "已通过 Passkey 批准核验。发起端设备将自动完成授权流程并签发凭据。",
    scriptVerifyingPrompt: "请在系统提示中完成 Passkey 验证…",
    scriptCancelledOrTimeout: "Passkey 操作已取消或超时，未提交变更。",
    scriptUnsupported: "当前环境不支持 WebAuthn，无法使用 Passkey。",
    scriptVerifySuccess: "已有 Passkey 验证成功。点击“注册新 Passkey”继续。",
    scriptAuthResume: "Passkey 核准成功，正在完成授权并交付结果…",
  },
  dashboard: {
    pageTitle: "Schwab MCP · 控制面板",
    skipLink: "跳至控制面板",
    sysTitle: "客户端与安全控制面板",
    sysSubtitle: "授权策略、调用审计与 owner Passkey",
    notRefreshed: "尚未刷新",
    refreshAllBtn: "刷新全部",
    schwabLink: "01 / SCHWAB LINK",
    runtimeEngine: "02 / RUNTIME ENGINE",
    browserEnclave: "03 / BROWSER ENCLAVE",
    schwabConnected: "Schwab 已连接",
    schwabReauth: "Schwab 需重新授权",
    schwabExpiringSoon: "Schwab 授权即将到期",
    schwabReading: "正在读取连接状态",
    schwabReadFailed: "连接状态读取失败",
    linkedAccounts: "已连接账户：",
    noLinkedAccounts: "无已连接账户",
    accountsReadFailed: "账户读取失败",
    accessExpiry: "Access 到期：",
    refreshExpiry: "Refresh 到期：",
    securityProtocol: "安全协议：TLS 1.3 // REST+JSON",
    reconnectSchwab: "重新授权 Schwab →",
    tradingReading: "正在读取交易总开关",
    tradingEnabled: "交易总开关已开启",
    tradingDisabled: "交易总开关已关闭",
    tradingUnknown: "交易开关状态未知",
    tradingSwitchDesc: "由部署配置 ENABLE_TRADING 控制；仪表板不能开启交易。",
    overviewReading: "正在读取概览",
    overviewCounts: "{clients} 个客户端 / {calls} 次调用 / {passkeys} 个 Passkey",
    legacyGrantNotice: "；{count} 条旧版 MCP 授权需在客户端重新授权",
    sessionState: "正在检查会话",
    sessionActive: "会话正常",
    sessionExpired: "会话已过期",
    sessionDesc: "GitHub owner 验证 · 15 分钟有效期",
    securityCenter: "独立安全中心",
    reloginRenew: "重新登录 / 续期",
    sessionReloginBtn: "通过 GitHub owner 重新登录",
    webauthnUnsupported: "当前浏览器或连接不支持 WebAuthn。Passkey 与 Advanced Security 操作已禁用。请在支持 Passkey 的安全外部浏览器中打开仪表板；不会使用普通验证代替。",
    tabInbox: "待办与通知",
    tabClients: "授权客户端",
    tabAudit: "调用审计",
    tabPasskeys: "Passkey 管理",
    tabSettings: "应用与设置",
    inboxTitle: "待办核准与通知中心",
    inboxSubtitle: "待 Passkey 批准的即时订单、受保护任务修改及客户端授权；系统重要变动与状态提醒。",
    refreshInbox: "刷新待办与通知",
    pendingApprovals: "⚡ 待 Passkey 核准项目",
    pendingCountTag: "{n} 待办",
    checkingPending: "正在检查待办事项…",
    noPending: "当前没有待 Passkey 核准的交易或授权请求。",
    notificationHistory: "历史通知记录",
    unreadCountTag: "{n} 未读",
    loadingNotifications: "正在加载通知…",
    noNotifications: "暂无通知记录。",
    read: "已读",
    unread: "未读",
    markAsRead: "标为已读",
    viewDetails: "查看详情 →",
    proceedToApproval: "前往核准 →",
    colTime: "时间",
    colType: "类型",
    colSummary: "提醒摘要",
    colStatus: "状态",
    colAction: "操作",
    paginationInfo: "显示 {start}–{end} / 共 {total} 条",
    clientsTitle: "已授权 MCP 客户端矩阵",
    clientsSubtitle: "每个客户端独立授权。权限调整与撤销在后续 MCP 请求即时生效；Advanced Security 变更须由 Passkey 验证。",
    refreshClients: "刷新客户端",
    colClient: "客户端 / 重定向 URI",
    colPermission: "权限等级",
    colAdvancedSecurity: "Advanced Security",
    colTimestamps: "授权 / 最后调用",
    colActions: "操作",
    noClients: "暂无已授权客户端。请在 MCP 客户端中发起 OAuth 授权。",
    revoked: "已撤销",
    authorized: "已授权",
    permReadOnly: "只读",
    permFullAccess: "完整交易",
    permPolicyNote: "权限不会改变部署级交易总开关。",
    modeEnhanced: "Passkey 增强",
    modeStandard: "普通模式",
    policyVersion: "策略版本 v{version}",
    fullAccessOnlyNote: "仅完整访问可开启。",
    createdAt: "授权：",
    lastInvocationAt: "最后调用：",
    neverInvoked: "暂无记录",
    revokeBtn: "撤销授权",
    revokeConfirm: "撤销 {name} 的全部授权及 Token？此客户端需要重新授权才能连接。",
    revokedSuccess: "客户端已撤销，全部旧 Token 已失效。",
    permissionUpdated: "客户端权限已更新。后续 MCP 请求使用新权限。",
    auditTitle: "协议工具调用审计",
    auditSubtitle: "只读与交易工具的脱敏调用记录。保留最近 30 天，最多 5,000 条；统计依据当前已应用的筛选条件。",
    refreshAudit: "刷新日志",
    statMatchedCalls: "匹配调用量",
    statSuccessRate: "成功率",
    statSuccess: "成功",
    statError: "错误",
    statActive24h: "近 24 小时调用",
    filterClientLabel: "Client ID（精确匹配）",
    filterClientPlaceholder: "全部客户端",
    filterToolLabel: "工具名称（精确匹配）",
    filterToolPlaceholder: "例如 get_quotes",
    filterStatusLabel: "执行状态",
    filterAllStatus: "全部状态",
    filterSuccess: "成功 SUCCESS",
    filterError: "错误 ERROR",
    applyFilter: "应用筛选",
    clearFilter: "清除",
    colTool: "工具",
    colDuration: "耗时",
    colSummaryParams: "脱敏参数 / 错误",
    colRequestId: "完整 Request ID",
    noAuditItems: "没有符合当前筛选条件的调用记录。",
    noSummary: "无参数摘要",
    passkeysTitle: "Owner 硬件 Passkey 管理",
    passkeysSubtitle: "凭据由 owner 共享。添加、重命名、删除均需验证已有 Passkey；最后一个凭据不可删除，取消或失败不会降级。",
    refreshPasskeys: "刷新凭据",
    statClientsCount: "已授权客户端",
    statTotalCalls: "保留调用记录",
    statPasskeysCount: "已登记 Passkey",
    noPasskeysRegistered: "尚未登记 Passkey。可在下方注册首个凭据，或在客户端开启 Advanced Security 时注册。",
    promptNewKeyName: "新的 Passkey 名称（1–80 字符）",
    deleteConfirm: "删除 Passkey “{name}”？此操作须先验证已有 Passkey。",
    cannotDeleteLast: "最后一个凭据不可删除",
    ownerSharedCount: "{n} 个 owner 共享凭据",
    noPasskeyProtection: "尚未启用 Passkey 防护",
    addKeyWithVerify: "添加 Passkey · 先验证已有凭据",
    registerFirstKey: "注册首个 Passkey",
    addKeyLabel: "新 Passkey 名称",
    addKeyDefaultValue: "我的 Passkey",
    addKeyStepHint: "添加已有凭据后的新设备分两步：先验证现有凭据，再单独点击注册。系统提示中请选择所需设备。",
    recoveryNotice: "所有凭据均丢失？通过独立 GitHub owner OAuth 恢复。恢复将使旧会话与待批准提案失效。",
    disasterRecoveryBtn: "Passkey 灾难恢复",
    settingsTitle: "应用运行环境与通知设备设置",
    settingsSubtitle: "管理 Web Push 推送设备订阅、通知权限检测及 PWA 主屏幕安装指引。",
    refreshSettings: "刷新设备状态",
    pushTitle: "Web Push 消息推送",
    pushBadgeChecking: "检查推送能力中…",
    pushBadgeUnsupported: "环境不支持",
    pushBadgeEnabled: "本机已开启推送",
    pushBadgeDisabled: "未开启推送",
    pushBadgePermDenied: "通知权限已禁止",
    pushBadgePermGrantedUnsubscribed: "权限已允许，尚未开启推送",
    pushBadgePermGrantedNotActive: "尚未开启推送",
    pushBadgeServiceUnavailable: "推送暂不可用",
    pushBadgePendingLookup: "检查推送状态中…",
    pushBadgePendingSubscription: "正在向推送服务申请凭据…",
    pushBadgePendingRegistration: "正在向服务器登记推送设备…",
    pushBadgePendingUnsubscribe: "正在停用推送通知…",
    permChecking: "检查通知权限中…",
    permGranted: "通知权限：已允许",
    permDenied: "通知权限：已禁止",
    permDefault: "通知权限：未授权",
    permUnsupported: "通知权限：不支持",
    pushHint1: "浏览器允许通知后，还需点击“开启本机通知推送”完成本机订阅与设备登记。",
    pushHint2: "在 iPhone PWA（iOS 16.4+ 添加至主屏幕）或桌面 Chrome 上启用推送，即可在后台或锁屏接收待核准、交易结果与授权失效提醒。",
    deviceLabel: "设备名称（可选）",
    devicePlaceholder: "例如：我的 iPhone、办公 Chrome",
    enablePushBtn: "开启本机通知推送",
    disablePushBtn: "停用本机推送",
    sendTestBtn: "发送测试提醒",
    registeredDevices: "已登记推送设备",
    unsubscribeDeviceConfirm: "确定解绑设备 “{name}”？该设备将不再接收新提醒。",
    colDeviceId: "设备标识",
    colDeviceName: "名称",
    colDeviceTime: "登记时间",
    pwaTitle: "PWA 渐进式应用安装",
    pwaChecking: "检测模式中…",
    pwaStandalone: "已作为独立应用运行",
    pwaBrowser: "浏览器标签页模式",
    pwaInstallBtn: "+ 安装为桌面应用",
    pwaIosGuideTitle: "iPhone / iPad 添加至主屏幕指引：",
    pwaIosStep1: "轻点 Safari 底部工具栏的“分享”图标（带有向上箭头的方框）；",
    pwaIosStep2: "向下滚动并选择“添加到主屏幕” (Add to Home Screen)；",
    pwaIosStep3: "轻点右上角“添加”完成安装；",
    pwaIosStep4: "从主屏幕打开 Schwab MCP 图标，即可享受独立运行与 Web Push 锁屏通知。",
    dialogTitle: "验证 Passkey",
    dialogCancel: "取消",
    dialogConfirm: "验证 Passkey 并确认",
    footerStatus: "SYSTEM READY // SCHWAB MCP",
    footerSecurity: "ENCLAVE: SECURE · 零明文账户/Secret读取",
    sessionExpiredError: "会话已过期，请重新登录。",
    networkError: "网络请求失败或登录状态已变更。请检查连接并刷新；若已提交操作，请核对服务器状态，勿盲目重复。",
    invalidJsonError: "服务器未返回有效 JSON（HTTP {status}）。请重新登录或稍后刷新。",
    sessionExpiredMessage: "浏览器安全会话已失效。请重新通过 GitHub owner 登录；未完成的 Passkey 操作不会自动继续。",
    passkeyCancelledOrTimeout: "Passkey 操作已取消或超时，未提交变更。请重新开始；不会降级为普通验证。",
    passkeyOperationSuccess: "Passkey 流程已验证并成功执行。",
    connectingPushService: "正在连接浏览器推送服务…",
    connectingPushTimeout: "连接浏览器推送服务超时。请检查网络后重试；Chrome 还需能连接 Google 推送服务。",
    readingPushTimeout: "读取本机推送订阅超时。请检查网络后重试；Chrome 还需能连接 Google 推送服务。",
    pushServiceRequest: "推送设备服务请求",
    pushServiceTimeout: "推送设备服务请求超时。请检查网络后重试；Chrome 还需能连接 Google 推送服务。",
    disablePushFailed: "停用通知失败：",
    enablePushSuccess: "已成功开启本机推送！",
    disablePushSuccess: "已停用本机通知推送。",
    testPushSent: "测试通知已发送！",
    testPushFailed: "发送测试通知失败：",
    tradeProposalTag: "[交易提案]",
    clientAuthTag: "[客户端授权]",
  },
};

const DICTIONARY_EN_US: I18nDictionary = {
  common: {
    brandTitle: "SCHWAB MCP",
    langName: "English",
    switchLangName: "简体中文",
    switchLangCode: "zh-CN",
    switchLangTitle: "Switch Language",
    ok: "OK",
    cancel: "Cancel",
    close: "Close",
    refresh: "Refresh",
    refreshAll: "Refresh All",
    status: "Status",
    action: "Action",
    actions: "Actions",
    loading: "Loading...",
    time: "Time",
    backToDashboard: "Back to Dashboard",
    unknown: "Unknown",
    none: "None",
    verified: "VERIFIED",
    confirm: "Confirm",
    delete: "Delete",
    rename: "Rename",
    save: "Save",
    error: "Error",
    empty: "No data available",
    active: "Active",
    expired: "Expired",
    prevPage: "← Previous",
    nextPage: "Next →",
  },
  auth: {
    gitHubContinueTitle: "Redirecting to GitHub · Schwab MCP",
    gitHubContinueNotice: ">_ Redirecting to GitHub authentication...",
    gitHubContinueLink: "Click here if not redirected automatically",
    authorizeTitle: "Client Authorization · Schwab MCP",
    gatewayTag: ">_ SCHWAB_MCP // OAUTH_CONSENT_GATEWAY",
    incomingChallengeTag: ">_ OAUTH 2.1 INCOMING CLIENT CHALLENGE",
    consentHeading: "Allow connection to Schwab MCP?",
    consentSubtitle: "A client is requesting access to your personal Charles Schwab MCP instance",
    clientLabel: "Client Identity",
    redirectUriLabel: "Redirect URI",
    readAccountTitle: "Account & Market Data Access",
    readAccountDesc: "Enables read-only access to quotes, price history, option chains, balances, and orders.",
    tradingPolicyTitle: "Guarded Trading Workflows",
    tradingPolicyDesc: "Trading tools require full access and remain strictly guarded by safety switches, confirmations, and user instructions.",
    permissionLegend: "Select Client Permission Level",
    readOnlyTitle: "Read only",
    readOnlyDesc: "Query quotes and balances; trading tools remain hidden from LLMs.",
    fullAccessTitle: "Full access",
    fullAccessDesc: "Expose all tools with mandatory order confirmation and safety switches.",
    advancedSecurityTitle: "Advanced Security · Passkey Approval",
    advancedSecurityDesc: "Available for full access. Orders and task modifications require biometric or hardware Passkey approval.",
    githubOwnerNotice: "Clicking continue will redirect to <strong>GitHub</strong> to verify owner identity (numeric ID whitelist).",
    continueButton: "Continue with GitHub",
    footerHint: "If unexpected, please close this window",
    footerBrand: "Charles Schwab MCP",
    passkeyAuthorizedTitle: "Authorization Approved · Schwab MCP",
    passkeyAuthorizedHeading: "Authorization Approved",
    passkeyAuthorizedSubtitle: "Passkey approval completed. Return to the Dashboard, or to your MCP client to view results.",
    passkeyStatusValue: "Approved via Passkey",
    passkeySecurityValue: "Hardware Authenticator Verified",
    schwabConnectedTitle: "Schwab Connected · Schwab MCP",
    schwabConnectedHeading: "Schwab Account Connected",
    schwabConnectedSubtitle: "OAuth tokens securely stored in encrypted vault · Daemon running",
    schwabStatusValue: "Connected",
    schwabSecurityValue: "Encrypted in SchwabVault",
    statusLabel: "Connection Status",
    securityLabel: "Security Protection",
    completionNotice: "You may safely close this browser window and return to your MCP client.",
    doneCloseButton: "Done & Close",
    closeTabHint: "If the tab does not close automatically, please close it manually",
    completionFooter: "Charles Schwab MCP · Dedicated High-Security Instance",
  },
  security: {
    orderApprovalTitle: "Order Passkey Hardware Approval",
    orderApprovalSubtitle: "Review order details and authorize with your registered Passkey",
    zeroKnowledgeNotice: "• Zero-Downgrade Security: Protected orders require native biometric or hardware Passkey approval.",
    proposalStatus: "Proposal Status",
    approvalDeadline: "Expires At",
    intentDigest: "Intent Digest",
    accountLabel: "Account",
    actionLabel: "Action Type",
    symbolSide: "Symbol / Side",
    quantity: "Quantity",
    priceType: "Price Type / Price",
    duration: "Duration",
    seeJson: "See JSON",
    keyProtectionTitle: "Hardware-Bound Security",
    keyProtectionDesc: "Private keys remain securely in your local Secure Enclave or hardware key.",
    tamperProofTitle: "Tamper-Proof Verification",
    tamperProofDesc: "Orders and policy changes require browser WebAuthn verification to prevent credential theft.",
    approveSubmitBtn: "⚡ Approve via Passkey",
    rejectOrderBtn: "Reject order",
    invokeHardwareBtn: "Verify with Authenticator",
    approveHint: "The order is submitted immediately upon verification. No conversational downgrade permitted.",
    executionOutcome: "Execution Outcome",
    batchCount: "Number of orders",
    batchOrder: "Order",
    batchReplacementId: "Replacement order ID",
    batchWarning: "Batch submission is not atomic and submitted orders are not rolled back. A definite rejection does not stop the next order; an uncertain result stops submission of the remaining orders.",
    batchApprove: "Approve and submit all via Passkey",
    batchReject: "Reject all orders",
    batchResults: "Individual order results",
    frozenTitle: "schwab_place_order.json [FROZEN]",
    frozenDesc: "Please verify account identifier, order legs, direction, quantity, price, and duration. The JSON below will be executed upon approval.",
    authenticatorReady: "Authenticator Ready: Apple Secure Enclave / YubiKey / FIDO2",
    authenticatorMeta: "FIDO2 Level 3 Authenticator · WebAuthn User Verification Required",
    recoverTitle: "Recover Passkeys",
    recoverSubtitle: "Verified via independent GitHub Owner OAuth",
    recoverNotice: "GitHub authentication is the trusted recovery entry. Registering a replacement key will revoke existing credentials, sessions, and pending proposals.",
    resetConfirmLabel: "Confirmation Phrase",
    resetConfirmHint: "Exact match required",
    resetConfirmPlaceholder: "Enter '重置全部 Passkey'",
    replacementKeyLabel: "Replacement Key Name",
    replacementKeyDefault: "Replacement Passkey",
    resetSubmitBtn: "Reset All Passkeys & Register Replacement",
    securityManagerTitle: "Advanced Security",
    securityManagerSubtitle: "Per-client security policy. Unprotected clients follow standard confirmation.",
    registeredPasskeys: "Registered Passkeys",
    activeCount: "{n} active credentials",
    rename: "Rename",
    delete: "Delete",
    cannotDeleteLast: "Cannot delete the last remaining key",
    keyNameLabel: "Passkey Name",
    keyNameDefault: "My Passkey",
    addKeyBtn: "Add New Passkey",
    registerFirstKeyBtn: "Register First Passkey",
    noKeysNotice: "No Passkeys registered yet. Register a hardware security key or biometric authenticator.",
    sessionExpiryHint: "Session valid for 15 min · Verification challenge expires in 2 min",
    keyManagement: "Credential Management",
    lostKeyRecovery: "Lost all Passkeys? Recover via GitHub OAuth",
    disclaimer: "Protects against MCP token or client compromise. Does not cover compromised host or GitHub account.",
    clientAuthTitle: "Client Authorization Approval · Schwab MCP",
    clientAuthAwaitingHeading: "Awaiting Passkey Approval",
    clientAuthHeading: "Client Access Request",
    clientAuthAwaitingSubtitle: "Approve this request using your registered Passkey on iPhone PWA, another device, or this browser.",
    clientAuthSubtitle: "Review client details and permissions below, then approve with your Passkey.",
    requestingClient: "Requesting Client",
    permissionLevel: "Permission Level",
    fullAccessTag: "FULL ACCESS",
    readOnlyTag: "READ ONLY",
    advancedSecurityOn: "Enabled (Passkey required for trades)",
    advancedSecurityOff: "Disabled",
    redirectUri: "Redirect URI",
    expiresAt: "Expires At",
    digest: "Request Digest",
    statusAwaiting: "Waiting for Passkey approval... (syncing every 2s)",
    newPasskeyName: "New Passkey Name",
    approveRequestBtn: "Approve with Passkey",
    registerAndApproveBtn: "Register Passkey & Approve",
    cancelRequestBtn: "Cancel Request",
    approvedNotice: "Approved via Passkey. The requesting device will automatically receive tokens.",
    scriptVerifyingPrompt: "Please complete Passkey verification in system prompt...",
    scriptCancelledOrTimeout: "Passkey operation was cancelled or timed out. No changes were made.",
    scriptUnsupported: "WebAuthn is not supported in this environment.",
    scriptVerifySuccess: "Existing Passkey verified. Click 'Register New Passkey' to proceed.",
    scriptAuthResume: "Passkey approved. Completing authorization and issuing tokens...",
  },
  dashboard: {
    pageTitle: "Schwab MCP · Control Center",
    skipLink: "Skip to dashboard",
    sysTitle: "Client & Security Console",
    sysSubtitle: "Authorizations, audit telemetry, and hardware Passkey controls",
    notRefreshed: "Not refreshed",
    refreshAllBtn: "Refresh All",
    schwabLink: "01 / SCHWAB LINK",
    runtimeEngine: "02 / RUNTIME ENGINE",
    browserEnclave: "03 / BROWSER ENCLAVE",
    schwabConnected: "Schwab Connected",
    schwabReauth: "Reauthorization Required",
    schwabExpiringSoon: "Expiring Soon",
    schwabReading: "Checking status...",
    schwabReadFailed: "Status check failed",
    linkedAccounts: "Linked accounts: ",
    noLinkedAccounts: "No linked accounts",
    accountsReadFailed: "Unable to load accounts",
    accessExpiry: "Access Expiry: ",
    refreshExpiry: "Refresh Expiry: ",
    securityProtocol: "Security: TLS 1.3 // REST+JSON",
    reconnectSchwab: "Reconnect Schwab →",
    tradingReading: "Checking trading switch...",
    tradingEnabled: "Trading Enabled",
    tradingDisabled: "Trading Disabled",
    tradingUnknown: "Trading switch unknown",
    tradingSwitchDesc: "Controlled by ENABLE_TRADING deployment setting; cannot be toggled from UI.",
    overviewReading: "Loading overview...",
    overviewCounts: "{clients} clients / {calls} tool calls / {passkeys} Passkeys",
    legacyGrantNotice: "; {count} legacy grant(s) require reauthorization",
    sessionState: "Checking session...",
    sessionActive: "Session Active",
    sessionExpired: "Session Expired",
    sessionDesc: "GitHub Owner Verified · 15-minute Session",
    securityCenter: "Security Center",
    reloginRenew: "Log in / Renew",
    sessionReloginBtn: "Log in with GitHub Owner",
    webauthnUnsupported: "WebAuthn is not supported by this browser. Passkey operations are disabled. Please use a compatible browser.",
    tabInbox: "Inbox & Alerts",
    tabClients: "Authorized Clients",
    tabAudit: "Tool Audit",
    tabPasskeys: "Passkeys",
    tabSettings: "Apps & Settings",
    inboxTitle: "Pending Approvals & Notifications",
    inboxSubtitle: "Orders, task modifications, and client authorizations awaiting Passkey approval.",
    refreshInbox: "Refresh Inbox",
    pendingApprovals: "⚡ Pending Passkey Approvals",
    pendingCountTag: "{n} pending",
    checkingPending: "Checking pending approvals...",
    noPending: "No pending approvals at this time.",
    notificationHistory: "Notification History",
    unreadCountTag: "{n} unread",
    loadingNotifications: "Loading notifications...",
    noNotifications: "No notifications found.",
    read: "Read",
    unread: "Unread",
    markAsRead: "Mark as Read",
    viewDetails: "View Details →",
    proceedToApproval: "Approve →",
    colTime: "Time",
    colType: "Type",
    colSummary: "Summary",
    colStatus: "Status",
    colAction: "Action",
    paginationInfo: "Showing {start}–{end} of {total}",
    clientsTitle: "Authorized MCP Clients",
    clientsSubtitle: "Each client is independently authorized. Permissions and policies update in real-time.",
    refreshClients: "Refresh Clients",
    colClient: "Client / Redirect URI",
    colPermission: "Permission",
    colAdvancedSecurity: "Advanced Security",
    colTimestamps: "Authorized / Last Used",
    colActions: "Actions",
    noClients: "No authorized clients. Initiate OAuth from an MCP client.",
    revoked: "Revoked",
    authorized: "Authorized",
    permReadOnly: "Read Only",
    permFullAccess: "Full Access",
    permPolicyNote: "Permission does not override deployment trading switch.",
    modeEnhanced: "Passkey Enhanced",
    modeStandard: "Standard Mode",
    policyVersion: "Policy v{version}",
    fullAccessOnlyNote: "Full access required.",
    createdAt: "Created: ",
    lastInvocationAt: "Last Used: ",
    neverInvoked: "Never",
    revokeBtn: "Revoke",
    revokeConfirm: "Revoke all authorizations and tokens for {name}? Re-authorization will be required.",
    revokedSuccess: "Client revoked. All previous tokens have been invalidated.",
    permissionUpdated: "Permissions updated. Effective immediately on subsequent requests.",
    auditTitle: "Protocol Tool Invocation Audit",
    auditSubtitle: "Sanitized invocation log of tools. Retains up to 30 days or 5,000 records.",
    refreshAudit: "Refresh Audit",
    statMatchedCalls: "Matching Calls",
    statSuccessRate: "Success Rate",
    statSuccess: "Success",
    statError: "Errors",
    statActive24h: "Last 24 Hours",
    filterClientLabel: "Client ID (Exact)",
    filterClientPlaceholder: "All clients",
    filterToolLabel: "Tool Name (Exact)",
    filterToolPlaceholder: "e.g. get_quotes",
    filterStatusLabel: "Status",
    filterAllStatus: "All statuses",
    filterSuccess: "SUCCESS",
    filterError: "ERROR",
    applyFilter: "Apply Filter",
    clearFilter: "Clear",
    colTool: "Tool",
    colDuration: "Duration",
    colSummaryParams: "Parameters / Error",
    colRequestId: "Request ID",
    noAuditItems: "No invocation records match the current filter.",
    noSummary: "No parameters",
    passkeysTitle: "Owner Hardware Passkeys",
    passkeysSubtitle: "Shared credentials for owner. Adding, renaming, or deleting requires existing Passkey authentication.",
    refreshPasskeys: "Refresh Passkeys",
    statClientsCount: "Clients",
    statTotalCalls: "Total Calls",
    statPasskeysCount: "Passkeys",
    noPasskeysRegistered: "No Passkeys registered yet. Register your first key below.",
    promptNewKeyName: "New Passkey Name (1-80 characters)",
    deleteConfirm: "Delete Passkey '{name}'? Verification of an existing Passkey is required.",
    cannotDeleteLast: "Cannot delete the last remaining key",
    ownerSharedCount: "{n} shared owner credentials",
    noPasskeyProtection: "Passkey protection not enabled",
    addKeyWithVerify: "Add Passkey · Verify Existing Key First",
    registerFirstKey: "Register First Passkey",
    addKeyLabel: "New Passkey Name",
    addKeyDefaultValue: "My Passkey",
    addKeyStepHint: "Adding a key requires two steps: verify an existing key, then register the new authenticator.",
    recoveryNotice: "Lost all keys? Recover via independent GitHub Owner OAuth. Will invalidate old sessions.",
    disasterRecoveryBtn: "Passkey Disaster Recovery",
    settingsTitle: "Environment & Device Settings",
    settingsSubtitle: "Manage Web Push subscriptions, browser notification permissions, and PWA setup.",
    refreshSettings: "Refresh Settings",
    pushTitle: "Web Push Notifications",
    pushBadgeChecking: "Checking push support...",
    pushBadgeUnsupported: "Not Supported",
    pushBadgeEnabled: "Push Enabled on This Device",
    pushBadgeDisabled: "Push Disabled",
    pushBadgePermDenied: "Permission Denied",
    pushBadgePermGrantedUnsubscribed: "Permission granted, push not enabled",
    pushBadgePermGrantedNotActive: "Push not enabled",
    pushBadgeServiceUnavailable: "Push service unavailable",
    pushBadgePendingLookup: "Checking push status...",
    pushBadgePendingSubscription: "Requesting push subscription...",
    pushBadgePendingRegistration: "Registering device with server...",
    pushBadgePendingUnsubscribe: "Disabling push notifications...",
    permChecking: "Checking notification permission...",
    permGranted: "Notification Permission: Granted",
    permDenied: "Notification Permission: Denied",
    permDefault: "Notification Permission: Not Prompted",
    permUnsupported: "Notification Permission: Unsupported",
    pushHint1: "After granting permission, click 'Enable Push Notifications' to subscribe this device.",
    pushHint2: "Enable push on iOS PWA or desktop browser to receive instant alerts for approvals and events.",
    deviceLabel: "Device Name (Optional)",
    devicePlaceholder: "e.g. My iPhone, Work Laptop",
    enablePushBtn: "Enable Push Notifications",
    disablePushBtn: "Disable Push Notifications",
    sendTestBtn: "Send Test Notification",
    registeredDevices: "Registered Push Devices",
    unsubscribeDeviceConfirm: "Unlink push device '{name}'? This device will no longer receive new notifications.",
    colDeviceId: "Device ID",
    colDeviceName: "Name",
    colDeviceTime: "Registered At",
    pwaTitle: "Progressive Web App (PWA)",
    pwaChecking: "Checking mode...",
    pwaStandalone: "Running in Standalone Mode",
    pwaBrowser: "Browser Tab Mode",
    pwaInstallBtn: "+ Install Desktop App",
    pwaIosGuideTitle: "iPhone / iPad Home Screen Guide:",
    pwaIosStep1: "Tap the Share button in Safari bottom bar;",
    pwaIosStep2: "Scroll down and tap 'Add to Home Screen';",
    pwaIosStep3: "Tap 'Add' in the top-right corner;",
    pwaIosStep4: "Open Schwab MCP from home screen for standalone window and lock screen push.",
    dialogTitle: "Verify Passkey",
    dialogCancel: "Cancel",
    dialogConfirm: "Verify Passkey & Confirm",
    footerStatus: "SYSTEM READY // SCHWAB MCP",
    footerSecurity: "ENCLAVE: SECURE · Zero plaintext secrets",
    sessionExpiredError: "Session expired. Please log in again.",
    networkError: "Network request failed or session changed. Please check your connection and refresh.",
    invalidJsonError: "Server did not return valid JSON (HTTP {status}).",
    sessionExpiredMessage: "Session expired. Please log in via GitHub owner again.",
    passkeyCancelledOrTimeout: "Passkey operation was cancelled or timed out. No changes submitted.",
    passkeyOperationSuccess: "Passkey operation verified and completed successfully.",
    connectingPushService: "Connecting to browser push service...",
    connectingPushTimeout: "Connection to push service timed out.",
    readingPushTimeout: "Reading push subscription timed out.",
    pushServiceRequest: "Push service request",
    pushServiceTimeout: "Push service request timed out.",
    disablePushFailed: "Failed to disable notifications: ",
    enablePushSuccess: "Push notifications successfully enabled on this device!",
    disablePushSuccess: "Push notifications disabled on this device.",
    testPushSent: "Test notification sent!",
    testPushFailed: "Failed to send test notification: ",
    tradeProposalTag: "[Trade Proposal]",
    clientAuthTag: "[Client Auth]",
  },
};

export const DICTIONARIES: Record<SupportedLang, I18nDictionary> = {
  "zh-CN": DICTIONARY_ZH_CN,
  "en-US": DICTIONARY_EN_US,
};

export function getDictionary(langCandidate?: string | null): I18nDictionary {
  const lang = resolveLang(langCandidate);
  return DICTIONARIES[lang];
}

export function formatString(template: string, vars: Record<string, string | number>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{${key}}`, String(value));
  }
  return result;
}

/**
 * Returns a subset of client-side translation strings for the dashboard JavaScript runtime.
 */
export function getDashboardClientI18n(lang: SupportedLang = DEFAULT_LANG): Record<string, string> {
  const dict = getDictionary(lang);
  return {
    ...dict.dashboard,
    ...dict.common,
  };
}

/**
 * Returns a subset of client-side translation strings for the security JavaScript runtime.
 */
export function getSecurityClientI18n(lang: SupportedLang = DEFAULT_LANG): Record<string, string> {
  const dict = getDictionary(lang);
  return {
    ...dict.security,
    ...dict.common,
  };
}

/**
 * Renders an accessible, native dropdown menu for switching languages in the top-right corner.
 */
export function renderLangDropdown(currentLang: SupportedLang = DEFAULT_LANG, query = ""): string {
  const isZh = currentLang === "zh-CN";
  const currentLabel = isZh ? "简体中文" : "English";
  const languageHref = (lang: SupportedLang) => {
    const params = new URLSearchParams(query);
    params.set("lang", lang);
    // URLSearchParams encodes attribute delimiters; escape its query separators for HTML.
    return "?" + params.toString().replaceAll("&", "&amp;");
  };
  return `<details class="lang-dropdown">
  <summary aria-haspopup="listbox" aria-label="切换语言 / Switch Language">
    <span class="lang-icon" aria-hidden="true">🌐</span>
    <span class="lang-label">${currentLabel}</span>
    <span class="lang-caret" aria-hidden="true">▾</span>
  </summary>
  <div class="lang-dropdown-menu" role="listbox">
    <a href="${languageHref("zh-CN")}" class="lang-dropdown-item${isZh ? " active" : ""}" role="option" aria-selected="${isZh ? "true" : "false"}">
      <span>简体中文</span>
      <span class="lang-check" aria-hidden="true"${isZh ? "" : ' style="visibility:hidden"'}>✓</span>
    </a>
    <a href="${languageHref("en-US")}" class="lang-dropdown-item${!isZh ? " active" : ""}" role="option" aria-selected="${!isZh ? "true" : "false"}">
      <span>English</span>
      <span class="lang-check" aria-hidden="true"${!isZh ? "" : ' style="visibility:hidden"'}>✓</span>
    </a>
  </div>
</details>`;
}

/**
 * Alias for renderLangDropdown for backward compatibility.
 */
export function renderLangSwitcher(currentLang: SupportedLang): string {
  return renderLangDropdown(currentLang);
}

/**
 * Shared client script for closing language dropdowns on outside click or Escape key.
 */
export const LANG_DROPDOWN_SCRIPT = `<script>document.addEventListener('click',e=>{if(!e.target.closest('.lang-dropdown'))document.querySelectorAll('.lang-dropdown[open]').forEach(d=>d.removeAttribute('open'));});document.addEventListener('keydown',e=>{if(e.key==='Escape'){const d=document.querySelector('.lang-dropdown[open]');if(d){d.removeAttribute('open');d.querySelector('summary')?.focus();}}});</script>`;

