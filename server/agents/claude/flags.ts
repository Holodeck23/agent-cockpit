import { z } from 'zod'

// The UI never passes raw CLI arguments. Everything that reaches argv goes
// through this schema first (same idea as Enjoy's per-flag allowlist).

export const PERMISSION_MODES = ['manual', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'] as const
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

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
    // Guidance + project instructions + a switch handoff (up to 24k) must fit; same bound as Codex.
    appendSystemPrompt: z.string().max(100_000).optional(),
    mcpConfig: mcpConfigSchema.default({ mcpServers: {} }),
    /** Tools that run without an approval prompt, e.g. the cockpit MCP's read-only tools. */
    allowedTools: z
      .array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/))
      .max(50)
      .default([]),
  })
  .refine((o) => !(o.sessionId && o.resume), { message: 'sessionId and resume are mutually exclusive' })

export type ClaudeLaunchInput = z.input<typeof claudeLaunchSchema>
export type ClaudeLaunchOptions = z.output<typeof claudeLaunchSchema>

export function buildClaudeArgs(input: ClaudeLaunchInput): string[] {
  const o = claudeLaunchSchema.parse(input)
  const settings = o.useHooks ? {} : { disableAllHooks: true }
  return [
    '--print',
    '--verbose',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--permission-mode', o.permissionMode,
    '--permission-prompts', 'host',
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
  ]
}
