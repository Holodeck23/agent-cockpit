import { z } from 'zod'
import { codexEfforts } from '../codex/efforts.ts'

// The UI never passes raw CLI arguments. Everything that reaches argv goes
// through this schema first (same idea as Enjoy's per-flag allowlist).

export const PERMISSION_MODES = ['manual', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'] as const
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
/**
 * Every level any agent takes. Ultra is Codex's alone (C9), and only some Codex models have it
 * (R7, codex/efforts.ts); Claude 2.1.289 stops at max.
 */
export const ALL_EFFORTS = [...EFFORTS, 'ultra'] as const
export type Effort = (typeof ALL_EFFORTS)[number]

/** The levels to offer; for Codex they depend on the model. */
export function effortsFor(agent: string, model?: string): readonly Effort[] {
  return agent === 'codex' ? codexEfforts(model) : EFFORTS
}

/** An agent that has no such level gets its highest one. */
export const effortForClaude = (effort: Effort | undefined): (typeof EFFORTS)[number] | undefined => (effort === 'ultra' ? 'max' : effort)

const mcpConfigSchema = z.object({ mcpServers: z.record(z.string(), z.unknown()) })

export const claudeLaunchSchema = z
  .object({
    cwd: z.string().min(1),
    model: z
      .string()
      .max(100)
      .regex(/^[A-Za-z0-9._\-[\]]+$/)
      .optional(),
    effort: z.enum(EFFORTS).optional(),
    permissionMode: z.enum(PERMISSION_MODES).default('manual'),
    sessionId: z.uuid().optional(),
    resume: z.uuid().optional(),
    useHooks: z.boolean().default(false),
    // Guidance + project instructions + a whole switch handoff (J5, 400k) must fit; same bound as Codex.
    appendSystemPrompt: z.string().max(500_000).optional(),
    /** The same prompt, written to a private file by the launcher: kept out of argv, which any local user can read. */
    appendSystemPromptFile: z.string().min(1).max(4096).optional(),
    mcpConfig: mcpConfigSchema.default({ mcpServers: {} }),
    /** Tools that run without an approval prompt, e.g. the cockpit MCP's read-only tools. */
    allowedTools: z
      .array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/))
      .max(50)
      .default([]),
  })
  .refine((o) => !(o.sessionId && o.resume), { message: 'sessionId and resume are mutually exclusive' })
  .refine((o) => !(o.appendSystemPrompt && o.appendSystemPromptFile), { message: 'pass the appended prompt as text or as a file, not both' })

export type ClaudeLaunchInput = z.input<typeof claudeLaunchSchema>
export type ClaudeLaunchOptions = z.output<typeof claudeLaunchSchema>

export function buildClaudeArgs(
  input: ClaudeLaunchInput,
  capabilities: { readonly permissionPrompts: boolean; readonly replayUserMessages?: boolean; readonly promptSuggestions?: boolean } = { permissionPrompts: true },
): string[] {
  const o = claudeLaunchSchema.parse(input)
  const settings = o.useHooks ? {} : { disableAllHooks: true }
  return [
    '--print',
    '--verbose',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    ...(capabilities.replayUserMessages ? ['--replay-user-messages'] : []),
    ...(capabilities.promptSuggestions ? ['--prompt-suggestions', 'true'] : []),
    '--permission-mode', o.permissionMode,
    ...(capabilities.permissionPrompts ? ['--permission-prompts', 'host'] : []),
    '--permission-prompt-tool', 'stdio',
    '--strict-mcp-config',
    '--mcp-config', JSON.stringify(o.mcpConfig),
    '--settings', JSON.stringify(settings),
    // Cockpit owns scheduling and notifications; the agent must not self-schedule.
    '--disallowed-tools', 'ScheduleWakeup,CronCreate,PushNotification,RemoteTrigger',
    ...(o.model ? ['--model', o.model] : []),
    ...(o.effort ? ['--effort', o.effort] : []),
    ...(o.sessionId ? ['--session-id', o.sessionId] : []),
    ...(o.resume ? ['--resume', o.resume] : []),
    ...(o.allowedTools.length ? ['--allowedTools', o.allowedTools.join(',')] : []),
    ...(o.appendSystemPrompt ? ['--append-system-prompt', o.appendSystemPrompt] : []),
    ...(o.appendSystemPromptFile ? ['--append-system-prompt-file', o.appendSystemPromptFile] : []),
  ]
}
