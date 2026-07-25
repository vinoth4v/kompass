'use client';
import { FileText, Image as ImageIcon, Paperclip, Send, Square, X } from 'lucide-react';
import { useRef, useState } from 'react';
import type { Attachment, ConversationMode } from '@/lib/types';

/** Extensions treated as text even when the browser reports no MIME type —
 *  which it routinely does for source files. */
const TEXT_EXTENSIONS =
  /\.(txt|md|markdown|csv|tsv|json|jsonl|ya?ml|toml|ini|cfg|conf|log|xml|html?|css|scss|jsx?|tsx?|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|bash|zsh|sql|graphql|env|dockerfile|makefile|gitignore)$/i;

const MAX_TEXT_BYTES = 400_000;

function classify(file: File): Attachment['kind'] {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type === 'application/pdf') return 'document';
  return 'text';
}

const PLACEHOLDERS: Record<ConversationMode, string> = {
  chat: 'Message Kompass AI… (attach images, PDFs, code or data to ask about them)',
  image: 'Describe the image you want to generate…',
  research: 'What do you want researched? Kompass will search the web and cite sources…',
  council: 'Ask the council…',
};

async function fileToAttachment(file: File): Promise<Attachment> {
  const kind = classify(file);

  if (kind === 'text') {
    if (!file.type.startsWith('text/') && !TEXT_EXTENSIONS.test(file.name) && file.type !== '') {
      throw new Error(`unsupported file type: ${file.type || file.name}`);
    }
    const text = await file.text();
    return {
      kind: 'text',
      mediaType: file.type || 'text/plain',
      data: '',
      // Truncated rather than refused: a 2MB log is still worth asking about,
      // and the model is told plainly that the tail was cut.
      text:
        text.length > MAX_TEXT_BYTES
          ? `${text.slice(0, MAX_TEXT_BYTES)}\n\n… [truncated ${text.length - MAX_TEXT_BYTES} characters]`
          : text,
      name: file.name,
      size: file.size,
    };
  }

  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  return {
    kind,
    mediaType: file.type || 'application/octet-stream',
    data,
    name: file.name,
    size: file.size,
  };
}

export function Composer({
  mode,
  busy,
  onSend,
  onStop,
}: {
  mode: ConversationMode;
  busy: boolean;
  onSend: (text: string, images: Attachment[]) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState('');
  const [images, setImages] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const resize = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(200, el.scrollHeight)}px`;
  };

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed && images.length === 0) return;
    if (busy) return;
    onSend(trimmed, images);
    setText('');
    setImages([]);
    requestAnimationFrame(resize);
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files) return;
    setAttachError(null);
    const settled = await Promise.allSettled(Array.from(files).slice(0, 6).map(fileToAttachment));
    const ok = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    const failed = settled.filter((r) => r.status === 'rejected').length;
    if (failed > 0) setAttachError(`${failed} file(s) could not be attached.`);
    setImages((prev) => [...prev, ...ok].slice(0, 6));
  };

  return (
    <div
      className="min-w-0 bg-gradient-to-t from-bg via-bg to-transparent px-3 pb-4 pt-6 sm:px-4"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (mode !== 'image') void handleFiles(e.dataTransfer.files);
      }}
    >
      <div className="mx-auto w-full max-w-thread">
        {attachError && <p className="mb-2 text-[0.75rem] text-danger">{attachError}</p>}
        {images.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {images.map((img, i) => (
              <div key={i} className="group relative">
                {img.kind === 'image' ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={`data:${img.mediaType};base64,${img.data}`}
                    alt={img.name}
                    className="h-16 w-16 rounded-xl border border-line object-cover"
                  />
                ) : (
                  <div className="flex h-16 max-w-[190px] items-center gap-2 rounded-xl border border-line bg-surface px-3">
                    {img.kind === 'document' ? (
                      <FileText size={16} className="shrink-0 text-ink-muted" />
                    ) : (
                      <ImageIcon size={16} className="shrink-0 text-ink-muted opacity-0" />
                    )}
                    <div className="min-w-0">
                      <div className="truncate text-[0.78rem] text-ink">{img.name}</div>
                      <div className="text-[0.7rem] text-ink-muted">
                        {img.kind === 'document'
                          ? 'PDF'
                          : `${Math.max(1, Math.round((img.text?.length ?? 0) / 1024))} KB text`}
                      </div>
                    </div>
                  </div>
                )}
                <button
                  onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                  className="absolute -right-1.5 -top-1.5 rounded-full bg-elevated p-1 text-ink shadow-md ring-1 ring-line-strong transition hover:bg-surface-hover"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-end gap-1.5 rounded-[1.6rem] border border-line bg-elevated p-2 shadow-md transition-colors duration-200 focus-within:border-line-strong">
          {mode !== 'image' && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,application/pdf"
                multiple
                hidden
                onChange={(e) => void handleFiles(e.target.files)}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="shrink-0 rounded-full p-2.5 text-ink-muted transition hover:bg-surface-hover hover:text-ink"
                title="Attach files — images, PDFs, code, CSV, JSON, logs"
              >
                <Paperclip size={18} />
              </button>
            </>
          )}

          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              resize();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={PLACEHOLDERS[mode]}
            rows={1}
            className="max-h-[220px] flex-1 resize-none bg-transparent px-1.5 py-2 text-[0.95rem] leading-relaxed outline-none placeholder:text-ink-faint"
          />

          {busy ? (
            <button
              onClick={onStop}
              className="shrink-0 rounded-full bg-surface-strong p-2.5 text-ink transition hover:bg-surface-hover"
              title="Stop"
            >
              <Square size={16} />
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={!text.trim() && images.length === 0}
              className="shrink-0 rounded-full bg-accent p-2.5 text-accent-contrast shadow-sm transition duration-200 hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-surface-strong disabled:text-ink-faint disabled:shadow-none"
              title="Send (Enter)"
            >
              <Send size={16} />
            </button>
          )}
        </div>
        <p className="mt-2 text-center text-[0.72rem] text-ink-faint">
          Enter to send · Shift+Enter for a new line
        </p>
      </div>
    </div>
  );
}
