import { z } from "zod";
import type { AppEnv } from "./env";

export type EmailAlertReason = "REAUTH_DUE_SOON" | "REAUTH_REQUIRED" | "EXECUTION_UNCERTAIN" | "TEST";

const addressSchema = z.email();
const messages: Record<EmailAlertReason, { subject: string; text: string }> = {
  REAUTH_DUE_SOON: { subject: "[Schwab MCP] 授权即将到期", text: "Schwab 授权即将在 24 小时内到期，请登录控制台查看。" },
  REAUTH_REQUIRED: { subject: "[Schwab MCP] 需要重新授权", text: "Schwab 授权已失效，请登录控制台重新授权。" },
  EXECUTION_UNCERTAIN: { subject: "[Schwab MCP] 执行结果不确定", text: "交易执行结果不确定。请人工查询订单状态，勿盲目重新提交。" },
  TEST: { subject: "[Schwab MCP] 邮件通知测试", text: "这是一封 owner 邮件通知测试。服务接受不代表最终送达，请本人确认收件。" },
};

export function emailAlertConfig(env: AppEnv): { sender: string; recipient: string; enabled: boolean } | null {
  const sender = env.ALERT_EMAIL_FROM;
  const recipient = env.ALERT_EMAIL_TO;
  if (!env.OWNER_ALERT_EMAIL || typeof sender !== "string" || typeof recipient !== "string" ||
      /[\r\n]/.test(sender) || /[\r\n]/.test(recipient) ||
      !addressSchema.safeParse(sender).success || !addressSchema.safeParse(recipient).success) return null;
  return { sender, recipient, enabled: env.EMAIL_ALERTS_ENABLED === "true" };
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export async function sendOwnerAlert(env: AppEnv, alert: { reason: EmailAlertReason; eventId: string; createdAt: number }): Promise<void> {
  const config = emailAlertConfig(env);
  if (!config || !env.OWNER_ALERT_EMAIL) throw new Error("EMAIL_ALERT_CONFIGURATION_INVALID");
  const message = messages[alert.reason];
  const link = `${new URL(env.SCHWAB_REDIRECT_URI).origin}/dashboard/notifications/${encodeURIComponent(alert.eventId)}`;
  const occurredAt = new Date(alert.createdAt).toISOString();
  await env.OWNER_ALERT_EMAIL.send({
    from: config.sender,
    to: config.recipient,
    subject: message.subject,
    text: `${message.text}\n事件：${alert.eventId}\n发生时间（UTC）：${occurredAt}\n查看控制台：${link}`,
    html: `<p>${escapeHtml(message.text)}</p><p>事件：${escapeHtml(alert.eventId)}</p><p>发生时间（UTC）：${occurredAt}</p><p><a href="${escapeHtml(link)}">查看控制台</a></p>`,
  });
}
