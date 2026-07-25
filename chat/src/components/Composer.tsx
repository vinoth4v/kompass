'use client';
import { ImagePlus, Send, Square, X } from 'lucide-react';
import { useRef, useState } from 'react';
import type { ConversationMode, ImageAttachment } from '@/lib/types';

const PLACEHOLDERS: Record<ConversationMode, string> = {
  chat: 'Message Kompass AI… (attach an image to ask about it)',
  image: 'Describe the image you want to generate…',
  research: 'What do you want researched? Kompass will search the web and cite sources…',
  council: 'Ask the council…',
};

function fileToAttachment(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const data = result.slice(result.indexOf(',') + 1);
      resolve({ mediaType: file.type || 'image/png', data, name: file.name });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function Composer({
  mode,
  busy,
  onSend,
  onStop,
}: {
  mode: ConversationMode;
  busy: boolean;
  onSend: (text: string, images: ImageAttachment[]) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState('');
  const [images, setImages] = useState<ImageAttachment[]>([]);
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
    const picked = await Promise.all(Array.from(files).slice(0, 4).map(fileToAttachment));
    setImages((prev) => [...prev, ...picked].slice(0, 4));
  };

  return (
    <div
      className="min-w-0 bg-gradient-to-t from-bg via-bg to-transparent px-3 pb-4 pt-6 sm:px-4"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (mode === 'chat') void handleFiles(e.dataTransfer.files);
      }}
    >
      <div className="mx-auto w-full max-w-thread">
        {images.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {images.map((img, i) => (
              <div key={i} className="group relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`data:${img.mediaType};base64,${img.data}`}
                  alt={img.name}
                  className="h-16 w-16 rounded-xl border border-line object-cover"
                />
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
          {mode === 'chat' && (
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
                title="Attach image"
              >
                <ImagePlus size={18} />
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
