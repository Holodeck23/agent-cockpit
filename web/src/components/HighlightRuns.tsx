import { highlight } from '../syntax.ts'

/** The coloured text behind the Source view's textarea. Loaded on demand with the highlighter. */
export default function HighlightRuns({ text, language }: { text: string; language: string }) {
  return <>{highlight(text, language).map((run, i) => (run.className ? <span key={i} className={run.className}>{run.text}</span> : run.text))}</>
}
