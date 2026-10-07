// Sandboxed rendering of a user's HTML email signature. Signatures are
// pasted from Gmail/Outlook and carry their own inline styles, <style>
// blocks, tables and remote images — an iframe isolates that CSS from the
// app (and the app's Tailwind resets from the signature), and sandbox=""
// disables scripts entirely while still loading remote images so the
// preview matches what recipients see.

import { useState } from 'react'
import { cn } from '@/lib/utils'

interface SignaturePreviewProps {
  html: string
  className?: string
  /** Size the frame to its content (the signature shown under the message in
   *  the email dialog). Needs `allow-same-origin` to measure the document —
   *  scripts stay disabled, so the signature still cannot run anything. */
  autoHeight?: boolean
}

export function SignaturePreview({ html, className, autoHeight }: SignaturePreviewProps) {
  const [height, setHeight] = useState<number | null>(null)
  // Minimal document with the same base styles gmail.ts applies around the
  // email body, so the preview approximates the received email.
  const srcDoc =
    '<!doctype html><html><head><meta charset="utf-8"><style>' +
    'body{margin:8px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222222;background:#ffffff;}' +
    'img{max-width:100%;}' +
    '</style></head><body>' +
    html +
    '</body></html>'

  return (
    <iframe
      sandbox={autoHeight ? 'allow-same-origin' : ''}
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      title="Aperçu de la signature"
      // `load` fires once the images are in, so the measure includes the logo.
      onLoad={autoHeight ? (e) => {
        const doc = e.currentTarget.contentDocument
        if (doc) setHeight(Math.ceil(doc.documentElement.scrollHeight))
      } : undefined}
      style={autoHeight && height ? { height } : undefined}
      className={cn(
        'w-full min-h-[120px] rounded-md border border-input bg-white',
        className,
      )}
    />
  )
}
