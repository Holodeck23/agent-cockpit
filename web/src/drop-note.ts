// What the Files explorer says after files are dropped on it (F8). Pure, unit-tested.

/** "Copied 2 files." plus what was skipped and why, or the error. */
export function dropNote(result: { copied: readonly string[]; skipped: ReadonlyArray<{ name: string; reason: string }> }): string {
  const copied = result.copied.length
  const renamed = result.copied.filter((p) => / \(copy( \d+)?\)(\.[^/.]+)?$/.test(p)).length
  const parts = [
    copied ? `Copied ${copied === 1 ? result.copied[0]!.split('/').pop() : `${copied} files`}.` : 'Nothing was copied.',
    renamed ? `${renamed === 1 ? 'A file with that name was already there, so the copy has its own name' : `${renamed} names were taken, so those copies have their own names`}; nothing was replaced.` : '',
    ...result.skipped.map((s) => `${s.name}: ${s.reason}.`),
  ]
  return parts.filter(Boolean).join(' ')
}
