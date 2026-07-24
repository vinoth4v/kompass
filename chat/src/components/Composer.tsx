'use client';
import { ImagePlus, Send, Square, X } from 'lucide-react';
import { useRef, useState } from 'react';
import type { ConversationMode, ImageAttachment } from '@/lib/types';

const PLACEHOLDERS: Record<ConversationMode, string> = {
  chat: 'Message Kompass AI… (attach an image to ask about it)',
  image: 'Describe the image you want to generate…',
  research: 'What do you want researched? Kompass will search the web and cite sources…',
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
      className="min-w-0 border-t border-white/10 p-3 sm:p-4"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (mode === 'chat') void handleFiles(e.dataTransfer.files);
      }}
    >
      {images.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {images.map((img, i) => (
            <div key={i} className="group relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`data:${img.mediaType};base64,${img.data}`}
                alt={img.name}
                className="h-16 w-16 rounded-lg border border-white/10 object-cover"
              />
              <button
                onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                className="absolute -right-1.5 -top-1.5 rounded-full bg-black/80 p-0.5 text-white/80 opacity-0 transition group-hover:opacity-100"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2 rounded-2xl border border-white/10 bg-white/[0.04] p-2 focus-within:border-brand-500/60">
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
              className="shrink-0 rounded-lg p-2 text-white/40 hover:bg-white/10 hover:text-white"
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
          className="max-h-[200px] flex-1 resize-none bg-transparent py-1.5 text-sm outline-none placeholder:text-white/30"
        />

        {busy ? (
          <button
            onClick={onStop}
            className="shrink-0 rounded-xl bg-white/15 p-2.5 text-white transition hover:bg-white/25"
            title="Stop"
          >
            <Square size={16} />
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={!text.trim() && images.length === 0}
            className="shrink-0 rounded-xl bg-brand-500 p-2.5 text-black/90 transition hover:bg-brand-400 disabled:cursor-not-allowed disabled:opacity-30"
            title="Send (Enter)"
          >
            <Send size={16} />
          </button>
        )}
      </div>
      <p className="mt-1.5 px-1 text-[0.72em] text-white/25">
        Enter to send · Shift+Enter for a new line
      </p>
    </div>
  );
}
