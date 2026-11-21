import {z} from 'zod';
export const AnecdoteTopicSchema=z.enum(['误会与文字游戏','自己的翻车','奇思妙想','游戏与创作','轻松日常']);
export const AnecdoteSchema=z.object({
  id:z.string(),hash:z.string(),chat:z.string().regex(/^(group|private):\d+$/),
  text:z.string().trim().min(8).max(240),topic:AnecdoteTopicSchema,
  sources:z.array(z.object({id:z.number().int().safe(),user:z.number().int().safe(),hash:z.string()})).min(1).max(12),
  at:z.number(),expires:z.number(),state:z.enum(['ready','used','revoked']),usedAt:z.number().default(0),
});
export const AnecdotePoolSchema=z.object({
  items:z.array(AnecdoteSchema).max(100).default([]),
  suppressed:z.array(z.object({hash:z.string(),at:z.number()})).max(300).default([]),
  optedOutUsers:z.array(z.string().regex(/^\d+$/)).max(5000).default([]),
}).prefault({});
export const AnecdoteReviewSchema=z.object({
  safe:z.boolean(),grounded:z.boolean(),identifiable:z.boolean(),sensitive:z.boolean(),verbatim:z.boolean(),
  text:z.string().trim().max(240),topic:AnecdoteTopicSchema,
}).strict();
export type Anecdote=z.infer<typeof AnecdoteSchema>;
export type AnecdoteReview=z.infer<typeof AnecdoteReviewSchema>;
export type AnecdoteReviewInput={candidate:string;topic:z.infer<typeof AnecdoteTopicSchema>;messages:Array<{self:boolean;text:string}>};
export type ReviewAnecdote=(input:AnecdoteReviewInput,signal:AbortSignal)=>Promise<AnecdoteReview>;
