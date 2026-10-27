import { z } from 'zod';

const scope = z.string().regex(/^(?:(?:group|private):\d+)?$/);
export const ThoughtKindSchema = z.enum(['chat','collect','qzone','qzone-comment']);
export const InterestSchema = z.object({
  id:z.string(),chat:scope,topic:z.string().min(1).max(80),reason:z.string().max(300),
  strength:z.number().int().min(1).max(5),at:z.number(),updatedAt:z.number(),
  source:z.enum(['conversation','admin','public']),messageId:z.number().int().safe().optional(),
});
export const ThoughtSchema = z.object({
  id:z.string(),key:z.string(),chat:scope,kind:ThoughtKindSchema,
  summary:z.string().min(1).max(200),reason:z.string().min(1).max(500),
  messageId:z.number().int().safe().optional(),at:z.number(),due:z.number(),expires:z.number(),
  targetUser:z.number().int().positive().safe().optional(),
  priority:z.number().int().min(1).max(100),
  state:z.enum(['pending','running','done','dismissed','expired','unknown']),result:z.string().default(''),
});
export const AutonomousStateSchema = z.object({
  interests:z.array(InterestSchema).max(1000).default([]),
  thoughts:z.array(ThoughtSchema).max(1000).default([]),
  decisions:z.array(z.object({id:z.string(),thoughtId:z.string(),chat:scope,kind:ThoughtKindSchema,at:z.number(),outcome:z.string(),reason:z.string().max(500)})).max(500).default([]),
  contacts:z.array(z.object({chat:scope,incomingAt:z.number(),proactiveAt:z.number(),unanswered:z.number().int().nonnegative(),attemptAt:z.number()})).max(5000).default([]),
  stickerUses:z.array(z.object({chat:scope,stickerId:z.string(),at:z.number()})).max(1000).default([]),
  posts:z.array(z.object({hash:z.string(),at:z.number(),state:z.enum(['running','success','unknown']),tid:z.string().default(''),summary:z.string().max(200).default('')})).max(100).default([]),
  spaceComments:z.array(z.object({hash:z.string(),at:z.number(),state:z.enum(['running','success','unknown'])})).max(500).default([]),
  lastDecisionAt:z.number().default(0),lastCommentAttempt:z.number().default(0),commentCursor:z.number().int().nonnegative().default(0),
  lastScanAt:z.number().default(0),lastQzoneAttempt:z.number().default(0),
}).prefault({});
export type Thought = z.infer<typeof ThoughtSchema>;
export type AutonomousTurn = {kind:Thought['kind'];thoughtId:string;effects:Set<Thought['kind']>;messages:number;reason:string;failure?:string;targetUser?:number;spacePost?:import('../services/qzone.js').SpacePost};
