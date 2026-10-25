import { z } from 'zod';
const sourceSnapshot=z.object({id:z.number().int().safe(),user:z.string(),quote:z.string().max(500),at:z.number()});

export const MemoryMetaSchema = z.object({
  source: z.enum(['legacy','admin','tool','learned']).default('legacy'),
  sources: z.array(z.number().int().safe()).max(20).default([]),
  evidence:z.array(sourceSnapshot).max(20).default([]),
  confidence:z.enum(['unknown','supported','confirmed']).default('unknown'),
  status: z.enum(['active','conflict','expired','revoked']).default('active'),
  locked: z.boolean().default(true), revision: z.number().int().positive().default(1),
  confirmedAt: z.number().default(0), expiresAt: z.number().default(0),
  history: z.array(z.object({text:z.string(),at:z.number(),reason:z.string()})).max(10).default([]),
});
export const LexiconSchema = z.object({
  id:z.string(),chat:z.string().regex(/^group:\d+$/),term:z.string().min(1).max(40),
  meaning:z.string().min(1).max(300),kind:z.enum(['term','expression']),
  sources:z.array(z.number().int().safe()).max(20),status:z.enum(['candidate','active','disabled']),
  evidence:z.array(sourceSnapshot).max(20).default([]),
  locked:z.boolean().default(false),revision:z.number().int().positive().default(1),at:z.number(),
  history:z.array(z.object({text:z.string(),at:z.number(),reason:z.string()})).max(10).default([]),
});
export const CognitionStateSchema = z.object({
  memories:z.record(MemoryMetaSchema).default({}),
  lexicon:z.array(LexiconSchema).max(3000).default([]),
  suppressed:z.array(z.object({chat:z.string(),hash:z.string(),at:z.number()})).max(10000).default([]),
  scopes:z.record(z.object({cursor:z.number().default(0),cursorIds:z.array(z.number().int().safe()).max(20000).default([]),lastAttempt:z.number().default(0)})).default({}),
  jobs:z.array(z.object({id:z.string(),chat:z.string(),at:z.number(),state:z.enum(['running','completed','failed','unknown','discarded']),summary:z.string(),sources:z.array(z.number().int().safe()),inputTokens:z.number().int().nonnegative().optional(),outputTokens:z.number().int().nonnegative().optional()})).max(200).default([]),
}).default({});
export type MemoryMeta = z.infer<typeof MemoryMetaSchema>;
