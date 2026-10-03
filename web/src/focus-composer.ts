// After a composer popover (agent picker, + context) closes by choice or Escape, typing should
// continue in the message box it belongs to.
export function focusComposer(from: Element | null | undefined): void {
  const box = from?.closest('.composer')?.querySelector<HTMLTextAreaElement>('textarea')
  // After React commits the close, so the popover's own input doesn't take focus back.
  if (box) requestAnimationFrame(() => box.focus())
}
