import { useRef } from 'react'
import type { ImageRef } from '../transcript.ts'

/** Where the server serves an image stored with a conversation. */
export const imageUrl = (threadId: string, file: string): string => `/api/threads/${encodeURIComponent(threadId)}/images/${encodeURIComponent(file)}`

/** A thumbnail in the conversation; clicking it shows the whole image until you click or press Escape. */
export function ConversationImage({ threadId, image }: { threadId: string; image: ImageRef }) {
  const viewer = useRef<HTMLDialogElement>(null)
  const src = imageUrl(threadId, image.file)
  const label = image.name ?? 'Image'
  return (
    <>
      <button type="button" className="conversation-image" title={label} aria-label={`Show ${label}`} onClick={() => viewer.current?.showModal()}>
        <img src={src} alt={label} loading="lazy" />
      </button>
      <dialog ref={viewer} className="image-viewer" aria-label={label} onClick={() => viewer.current?.close()}>
        <img src={src} alt={label} />
        {image.name ? <p>{image.name}</p> : null}
      </dialog>
    </>
  )
}

export function ConversationImages({ threadId, images }: { threadId: string; images: readonly ImageRef[] }) {
  return (
    <div className="message-images" role="list" aria-label="Images">
      {images.map((image) => <div role="listitem" key={image.file}><ConversationImage threadId={threadId} image={image} /></div>)}
    </div>
  )
}
