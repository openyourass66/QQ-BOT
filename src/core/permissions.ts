type PermissionOption = { kind: string; optionId: string };

type AccountActor = { user: number; origin?: 'message' | 'notice' | 'background'; proactive?: boolean; reminder?: boolean; autonomous?: unknown };
const accountTools = new Set(['qq_set_profile', 'qq_set_avatar', 'qq_set_group_card', 'qq_handle_request']);

/** 身份来自桥接保存的真实消息事件，工具参数与后台任务不能授予主人权限。 */
export function isAccountOwner(ctx: AccountActor, adminQq: number): boolean {
  return Number.isSafeInteger(adminQq) && adminQq > 0 && ctx.user === adminQq && ctx.origin === 'message' && !ctx.proactive && !ctx.reminder && !ctx.autonomous;
}

export function assertAccountTool(ctx: AccountActor, adminQq: number, tool: string): void {
  if (accountTools.has(tool) && !isAccountOwner(ctx, adminQq)) throw new Error('仅机器人主人可执行账号管理操作；请由配置的管理员发起真实消息。');
}

/** 没有匹配选项时取消审批，禁止回退到可能放行的选项。 */
export function permissionOutcome(options: PermissionOption[], allowed: boolean) {
  const option = options.find((item) => item.kind === (allowed ? 'allow_once' : 'reject_once'));
  return option
    ? { outcome: { outcome: 'selected' as const, optionId: option.optionId } }
    : { outcome: { outcome: 'cancelled' as const } };
}

export function parseApprovalReply(text: string): { approved: boolean; id?: string } | undefined {
  const match = /^(y|n|允许|拒绝|好|不)(?:\s+#?([a-z0-9]{6}))?$/i.exec(text.trim());
  if (!match) return undefined;
  return { approved: /^(y|允许|好)$/i.test(match[1]), id: match[2]?.toLowerCase() };
}
