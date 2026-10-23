type PermissionOption = { kind: string; optionId: string };

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
