'use client';
import { Check, Copy, Download, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import type { ChatMessage } from '@/lib/types';
import { CodeBlock } from './CodeBlock';

const markdownComponents = {
  pre: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  code: CodeBlock,
  a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...props} target="_blank" rel="noopener noreferrer" />
  ),
};

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function IconButton({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="rounded-md p-1.5 text-white/40 transition hover:bg-white/10 hover:text-white/90"
    >
      {children}
    </button>
  );
}

export function MessageBubble({
  message,
  isLast,
  onRegenerate,
  onEdit,
  onDelete,
}: {
  message: ChatMessage;
  isLast: boolean;
  onRegenerate?: () => void;
  onEdit?: (text: string) => void;
  onDelete: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.text);
  const isUser = message.role === 'user';

  const copy = () => {
    navigator.clipboard.writeText(message.text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className={`kompass-fade-in group flex w-full min-w-0 ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`flex min-w-0 max-w-[85%] flex-col gap-1.5 sm:max-w-[75%] ${isUser ? 'items-end' : 'items-start'}`}
      >
        {message.images && message.images.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {message.images.map((img, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={i}
                src={`data:${img.mediaType};base64,${img.data}`}
                alt={img.name}
                className="max-h-48 rounded-lg border border-white/10 object-cover"
              />
            ))}
          </div>
        )}

        {editing ? (
          <div className="w-full min-w-[240px] rounded-2xl border border-brand-500/50 bg-white/5 p-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={Math.min(10, draft.split('\n').length + 1)}
              className="w-full resize-none bg-transparent text-[0.95em] text-inherit outline-none"
              autoFocus
            />
            <div className="mt-1 flex justify-end gap-2 text-xs">
              <button
                onClick={() => setEditing(false)}
                className="rounded-md px-2 py-1 text-white/50 hover:bg-white/10"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setEditing(false);
                  onEdit?.(draft);
                }}
                className="rounded-md bg-brand-500 px-2 py-1 font-medium text-black/90 hover:bg-brand-400"
              >
                Save &amp; resend
              </button>
            </div>
          </div>
        ) : (
          <div
            className={
              // max-w-full is load-bearing here, not cosmetic: this div is a flex
              // item under `align-items: flex-start` (see the wrapper above), which
              // sizes it via fit-content — without an explicit cap it renders at its
              // *unwrapped* content width and pushes past the wrapper's max-w-[85%]
              // instead of wrapping. min-w-0 alone (the usual flex-overflow fix)
              // does not touch this; only max-width does.
              (isUser
                ? 'rounded-2xl rounded-br-md bg-brand-600/90 px-4 py-2.5 text-white'
                : message.error
                  ? 'rounded-2xl rounded-bl-md border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-red-200'
                  : 'rounded-2xl rounded-bl-md bg-white/[0.06] px-4 py-2.5') + ' max-w-full'
            }
          >
            {message.generatedImage ? (
              <div className="flex flex-col gap-2">
                {message.text && <p className="text-sm text-white/70">{message.text}</p>}
                <div className="group/img relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`data:${message.generatedImage.mime};base64,${message.generatedImage.b64}`}
                    alt="Generated"
                    className="max-w-full rounded-lg border border-white/10 sm:max-w-sm"
                  />
                  <a
                    href={`data:${message.generatedImage.mime};base64,${message.generatedImage.b64}`}
                    download="kompass-image.jpg"
                    className="absolute right-2 top-2 rounded-lg bg-black/60 p-1.5 opacity-0 backdrop-blur transition group-hover/img:opacity-100"
                    title="Download"
                  >
                    <Download size={16} />
                  </a>
                </div>
              </div>
            ) : isUser ? (
              <p className="whitespace-pre-wrap break-words text-[0.95em]">{message.text}</p>
            ) : (
              <div className="prose-kompass max-w-none break-words text-[0.95em]">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeHighlight]}
                  components={markdownComponents}
                >
                  {message.text || ' '}
                </ReactMarkdown>
              </div>
            )}

            {message.sources && message.sources.length > 0 && (
              <div className="mt-2 border-t border-white/10 pt-2">
                <div className="mb-1 text-[0.72em] font-medium uppercase tracking-wide text-white/40">
                  Sources
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {message.sources.map((s, i) => (
                    <a
                      key={i}
                      href={s.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="max-w-[220px] truncate rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[0.78em] text-white/60 hover:bg-white/10 hover:text-white"
                      title={s.title}
                    >
                      {i + 1}. {s.title}
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="flex items-center gap-0.5 px-1 opacity-0 transition group-hover:opacity-100">
          {!isUser && !!message.text && (
            <IconButton onClick={copy} title="Copy">
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </IconButton>
          )}
          {isUser && onEdit && !editing && (
            <IconButton onClick={() => setEditing(true)} title="Edit &amp; resend">
              <Pencil size={14} />
            </IconButton>
          )}
          {!isUser && isLast && onRegenerate && (
            <IconButton onClick={onRegenerate} title="Regenerate">
              <RefreshCw size={14} />
            </IconButton>
          )}
          <IconButton onClick={onDelete} title="Delete">
            <Trash2 size={14} />
          </IconButton>
          {!isUser && (message.servedBy || message.usage) && (
            <span className="ml-1 flex items-center gap-1.5 text-[0.72em] text-white/30">
              {message.lane && (
                <span className="rounded-full border border-white/10 px-1.5 py-0.5">
                  {message.lane}
                </span>
              )}
              {message.servedBy && <span className="font-mono">{message.servedBy}</span>}
              {message.usage && (
                <span>
                  {fmtTokens(message.usage.input)}→{fmtTokens(message.usage.output)} tok
                </span>
              )}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
