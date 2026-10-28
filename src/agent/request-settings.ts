import {z} from 'zod';
export const RequestSettingsSchema=z.object({
  perDay:z.number().int().min(0).max(10000).default(500),
  perUserPerDay:z.number().int().min(0).max(10000).default(100),
  perChatPerDay:z.number().int().min(0).max(10000).default(200),
  backgroundPerDay:z.number().int().min(0).max(1000).default(30),
  perMinute:z.number().int().min(1).max(1000).default(30),
  perTurn:z.number().int().min(1).max(100).default(12),
  concurrent:z.number().int().min(1).max(16).default(4),
  maxOutputTokens:z.number().int().min(128).max(32768).default(8192),
  maxRequestKiB:z.number().int().min(64).max(32768).default(8192),
  maxResponseChars:z.number().int().min(1000).max(128000).default(32000),
  mediaPerDay:z.number().int().min(0).max(1000).default(60),
  nativeWebPerDay:z.number().int().min(0).max(1000).default(100),
}).prefault({});
