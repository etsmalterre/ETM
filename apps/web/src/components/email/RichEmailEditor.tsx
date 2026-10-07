// Rich-text message editor of SendEmailDialog (TipTap).
//
// The toolbar is deliberately short — bold, italic, underline, a « titre »
// size, lists and four colours — so every Malterre mail looks alike in the
// client's Outlook or Gmail. The API sanitizes the HTML against the same list
// (apps/api/src/lib/email-riche.ts): keep RICH_COLORS in sync with
// COULEURS_EMAIL there.

import { useEffect } from 'react'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Color, TextStyle } from '@tiptap/extension-text-style'
import { Bold, Heading, Italic, List, ListOrdered, Underline } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Palette offered by the toolbar — the API drops any other colour. */
export const RICH_COLORS: Array<{ label: string; value: string | null; swatch: string }> = [
  { label: 'Texte normal', value: null, swatch: '#222222' },
  { label: 'Bleu Malterre', value: '#143d6b', swatch: '#143d6b' },
  { label: 'Rouge (alerte)', value: '#c62828', swatch: '#c62828' },
  { label: 'Orange (attention)', value: '#b26a00', swatch: '#b26a00' },
]

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const inline = (s: string) => escapeHtml(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')

/** Plain pre-filled text (what every email-defaults endpoint returns) → the
 *  editor's HTML: blank lines split paragraphs, « - » lines become a list,
 *  `**gras**` becomes bold. */
export function texteVersHtml(text: string): string {
  const blocs = text.replace(/\r\n/g, '\n').split(/\n{2,}/)
  const out: string[] = []
  for (const bloc of blocs) {
    const lignes = bloc.split('\n')
    let para: string[] = []
    let liste: string[] = []
    const viderPara = () => { if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = [] }
    const viderListe = () => { if (liste.length) out.push(`<ul>${liste.map((l) => `<li><p>${inline(l)}</p></li>`).join('')}</ul>`); liste = [] }
    for (const l of lignes) {
      const m = /^\s*[-•]\s+(.*)$/.exec(l)
      if (m) { viderPara(); liste.push(m[1]) } else { viderListe(); para.push(l) }
    }
    viderPara()
    viderListe()
  }
  return out.join('') || '<p></p>'
}

function ToolButton({ active, title, onClick, children }: {
  active?: boolean
  title: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={active}
      // Keep the editor's selection: a mousedown on the button would blur it.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        'h-7 w-7 inline-flex items-center justify-center rounded-md transition-colors',
        active ? 'bg-accent text-accent-foreground shadow-sm' : 'text-muted-foreground hover:bg-accent/10 hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

function Toolbar({ editor }: { editor: Editor }) {
  const couleur = (editor.getAttributes('textStyle').color as string | undefined)?.toLowerCase() ?? null
  return (
    <div className="flex-shrink-0 flex flex-wrap items-center gap-0.5 border-b border-border/60 bg-zinc-50 px-1.5 py-1 rounded-t-md">
      <ToolButton title="Gras (Ctrl+B)" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}>
        <Bold className="h-3.5 w-3.5" />
      </ToolButton>
      <ToolButton title="Italique (Ctrl+I)" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}>
        <Italic className="h-3.5 w-3.5" />
      </ToolButton>
      <ToolButton title="Souligné (Ctrl+U)" active={editor.isActive('underline')} onClick={() => editor.chain().focus().toggleUnderline().run()}>
        <Underline className="h-3.5 w-3.5" />
      </ToolButton>
      <span className="mx-1 h-4 w-px bg-border" />
      <ToolButton title="Titre" active={editor.isActive('heading', { level: 3 })} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>
        <Heading className="h-3.5 w-3.5" />
      </ToolButton>
      <ToolButton title="Liste à puces" active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()}>
        <List className="h-3.5 w-3.5" />
      </ToolButton>
      <ToolButton title="Liste numérotée" active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
        <ListOrdered className="h-3.5 w-3.5" />
      </ToolButton>
      <span className="mx-1 h-4 w-px bg-border" />
      {RICH_COLORS.map((c) => {
        const active = c.value === null ? couleur === null : couleur === c.value
        return (
          <button
            key={c.label}
            type="button"
            title={c.label}
            aria-pressed={active}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => (c.value === null
              ? editor.chain().focus().unsetColor().run()
              : editor.chain().focus().setColor(c.value).run())}
            className={cn(
              'h-7 w-7 inline-flex items-center justify-center rounded-md transition-colors',
              active ? 'bg-accent/15 ring-1 ring-accent' : 'hover:bg-accent/10',
            )}
          >
            <span className="h-3.5 w-3.5 rounded-full border border-black/10" style={{ backgroundColor: c.swatch }} />
          </button>
        )
      })}
    </div>
  )
}

export function RichEmailEditor({ value, onChange, className }: {
  /** The message as HTML. */
  value: string
  onChange: (html: string) => void
  className?: string
}) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [3] },
        // Only what the API keeps (email-riche.ts) — the rest would vanish at send.
        blockquote: false,
        code: false,
        codeBlock: false,
        horizontalRule: false,
        strike: false,
        link: false,
      }),
      TextStyle,
      Color,
    ],
    content: value,
    shouldRerenderOnTransaction: true,
    editorProps: {
      attributes: {
        class: cn(
          'min-h-full px-3 py-2 text-sm leading-relaxed outline-none',
          '[&_p]:my-0 [&_p+p]:mt-3 [&_h3]:text-base [&_h3]:font-bold [&_h3]:mt-3 [&_h3]:mb-1',
          '[&_ul]:list-disc [&_ul]:pl-5 [&_ul]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:my-2',
        ),
      },
    },
    onUpdate: ({ editor: e }) => onChange(e.getHTML()),
  })

  // Content set from outside (dialog hydration / reset): push it in, without
  // fighting the user's typing (the editor's own updates already match).
  useEffect(() => {
    if (!editor || editor.getHTML() === value) return
    editor.commands.setContent(value, { emitUpdate: false })
  }, [editor, value])

  return (
    <div className={cn('flex flex-col rounded-md border border-input bg-white focus-within:ring-2 focus-within:ring-ring', className)}>
      {editor && <Toolbar editor={editor} />}
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-transparent cursor-text" onClick={() => editor?.commands.focus()}>
        <EditorContent editor={editor} className="h-full" />
      </div>
    </div>
  )
}
