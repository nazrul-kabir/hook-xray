import { z } from "zod";

// Handler schemas follow the hooks reference (code.claude.com/docs/en/hooks).
// .passthrough() keeps unknown fields so newer Claude Code options survive into --json.
const common = {
  if: z.string().optional(),
  timeout: z.number().optional(),
  statusMessage: z.string().optional(),
  once: z.boolean().optional(),
};

export const CommandHandler = z
  .object({
    type: z.literal("command"),
    command: z.string(),
    args: z.array(z.string()).optional(),
    async: z.boolean().optional(),
    asyncRewake: z.boolean().optional(),
    shell: z.string().optional(),
    ...common,
  })
  .passthrough();

export const HttpHandler = z
  .object({
    type: z.literal("http"),
    url: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
    allowedEnvVars: z.array(z.string()).optional(),
    ...common,
  })
  .passthrough();

export const McpToolHandler = z
  .object({
    type: z.literal("mcp_tool"),
    server: z.string(),
    tool: z.string(),
    input: z.unknown().optional(),
    ...common,
  })
  .passthrough();

export const PromptHandler = z
  .object({ type: z.literal("prompt"), prompt: z.string(), model: z.string().optional(), ...common })
  .passthrough();

export const AgentHandler = z
  .object({ type: z.literal("agent"), prompt: z.string(), model: z.string().optional(), ...common })
  .passthrough();

export const Handler = z.discriminatedUnion("type", [
  CommandHandler,
  HttpHandler,
  McpToolHandler,
  PromptHandler,
  AgentHandler,
]);
export type Handler = z.infer<typeof Handler>;

export const MatcherGroup = z
  .object({ matcher: z.string().optional(), hooks: z.array(z.unknown()) })
  .passthrough();

/** settings.json `hooks`: event name -> matcher groups -> handlers. */
export const HooksConfig = z.record(z.string(), z.array(MatcherGroup));
