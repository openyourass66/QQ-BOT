import { z } from 'zod';

export const LearningSettingsSchema = z.object({
  memory: z.boolean().default(false),
  lexicon: z.boolean().default(false),
  useLexicon:z.boolean().default(true),
  chats: z.array(z.string().regex(/^(group|private):\d+$/)).max(5000).default([]),
  minMessages: z.number().int().min(3).max(200).default(40),
  intervalMinutes: z.number().int().min(5).max(1440).default(60),
  idleMinutes: z.number().int().min(1).max(60).default(5),
  dailyCalls: z.number().int().min(0).max(100).default(6),
  memoryCount: z.number().int().min(0).max(30).default(12),
  memoryChars: z.number().int().min(0).max(6000).default(1800),
  lexiconCount: z.number().int().min(0).max(10).default(4),
  lexiconChars: z.number().int().min(0).max(2000).default(400),
}).prefault({});

export const ContextSettingsSchema = z.object({
  activeSessions:z.number().int().min(4).max(512).default(128),
  idleMinutes:z.number().int().min(1).max(1440).default(30),
  backgroundChars: z.number().int().min(500).max(12000).default(3000),
  warningPercent: z.number().int().min(30).max(95).default(70),
  rolloverPercent: z.number().int().min(50).max(99).default(85),
  rollover: z.boolean().default(false),
  toolsPerTurn: z.number().int().min(1).max(200).default(80),
  filterTools: z.boolean().default(false),
}).prefault({});
