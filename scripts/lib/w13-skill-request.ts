import assert from 'node:assert/strict'
import { assessNativeMemoryRequest } from './w13-memory-request.ts'

/** The same native-source context oracle, plus exact skill-argument transport. */
export function assessNativeSkillRequest(body: unknown, selected: string, excluded: string, args: string, resource: string): {
  readonly selectedLoaded: true; readonly excludedAbsent: true; readonly argumentsPreserved: true; readonly resourceInContext: boolean
} {
  assessNativeMemoryRequest(body, selected, excluded, args)
  assert.ok(resource.length >= 32 && !args.includes(resource), 'The prompt contains a resource canary')
  const input = (body as { input: unknown }).input
  const texts: string[] = []
  const visit = (value: unknown): void => {
    if (typeof value === 'string') texts.push(value)
    else if (Array.isArray(value)) value.forEach(visit)
    else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
      if (key === 'text' || key === 'content' || typeof child === 'object') visit(child)
    }
  }
  visit(input)
  assert.ok(args.length > 0 && texts.some((text) => text.includes(args)), 'Native input lost or changed skill arguments')
  return { selectedLoaded: true, excludedAbsent: true, argumentsPreserved: true,
    resourceInContext: JSON.stringify(input).includes(resource) }
}

/** Requires a native tool result, not a marker echoed in assistant content or metadata. */
export function assessNativeSkillResource(body: unknown, callId: string, resource: string, excluded: string): { resourceRead: true; excludedAbsent: true } {
  assert.ok(resource.length >= 32 && excluded.length >= 32 && resource !== excluded && callId.length > 0)
  assert.ok(body && typeof body === 'object')
  const input = (body as { input?: unknown }).input
  assert.ok(Array.isArray(input))
  const results = input.filter((item: any) => item?.type === 'function_call_output' && item.call_id === callId)
  assert.equal(results.length, 1, 'No unique native resource tool result')
  assert.ok(JSON.stringify(results[0].output).includes(resource), 'Native tool result did not contain the selected resource')
  assert.ok(!JSON.stringify(input).includes(excluded), 'Native resource request exposed an excluded source')
  return { resourceRead: true, excludedAbsent: true }
}
