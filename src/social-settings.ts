import { z } from 'zod';

const ids = z.array(z.string().regex(/^\d+$/)).max(5000).default([]);
export const SocialSettingsSchema = z.object({
  autonomy: z.enum(['autonomous', 'sensitive', 'confirm']).default('autonomous'),
  allowAll: z.boolean().default(true),
  allowedGroups: ids, allowedUsers: ids, blockedGroups: ids, blockedUsers: ids,
  responseMode: z.enum(['legacy', 'mention', 'keywords', 'probability', 'all']).default('legacy'),
  keywords: z.array(z.string().min(1).max(64)).max(100).default([]),
  responseProbability: z.number().int().min(0).max(100).default(10),
  batchWindowMs: z.number().int().min(0).max(5000).default(0),
  activeMinutes: z.number().int().min(0).max(60).default(3),
  messagesPerMinute: z.number().int().min(1).max(100).default(20),
  actionsPerDay: z.number().int().min(0).max(10000).default(200),
  memoryEnabled: z.boolean().default(true),
  stickersEnabled: z.boolean().default(true),
  mediaEnabled: z.boolean().default(true),
  requestsEnabled: z.boolean().default(true),
  filesEnabled: z.boolean().default(true),
  remindersEnabled: z.boolean().default(true),
  proactiveEnabled: z.boolean().default(false),
  proactiveIntervalMinutes: z.number().int().min(5).max(1440).default(120),
  quietStartHour: z.number().int().min(0).max(23).default(23),
  quietEndHour: z.number().int().min(0).max(23).default(8),
  retentionDays: z.number().int().min(1).max(365).default(30),
  messagesPerChat: z.number().int().min(80).max(20000).default(2000),
  visionModel: z.string().max(128).default(''),
  transcriptionModel: z.string().max(128).default(''),
  speechModel: z.string().max(128).default(''),
  speechVoice: z.string().max(64).default('alloy'),
  videoFrames: z.number().int().min(1).max(12).default(4),
}).default({});
export type SocialSettings = z.infer<typeof SocialSettingsSchema>;

export function allowedChat(s: SocialSettings, chat: string, user?: number | string): boolean {
  const [kind, id] = chat.split(':');
  if (!/^(group|private):\d+$/.test(chat)) return false;
  if (s.blockedUsers.includes(String(user ?? (kind === 'private' ? id : '')))) return false;
  if ((kind === 'group' ? s.blockedGroups : s.blockedUsers).includes(id)) return false;
  return s.allowAll || (kind === 'group' ? s.allowedGroups : s.allowedUsers).includes(id);
}
