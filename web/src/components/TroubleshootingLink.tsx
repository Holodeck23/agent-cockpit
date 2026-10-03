import { HELP, looksLikeConnectionError } from '../../../server/help-links.ts'

/** After an error that looks like a network problem: a link to the guide's network section. */
export function TroubleshootingLink({ text }: { text: string }) {
  if (!looksLikeConnectionError(text)) return null
  return <> <a className="troubleshooting-link" href={HELP.network} target="_blank" rel="noreferrer">Network troubleshooting</a></>
}
