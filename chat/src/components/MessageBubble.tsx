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
      className="rounded-lg p-1.5 text-ink-muted transition hover:bg-surface-hover hover:text-ink"
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
    <div
      className={`kompass-fade-in group flex w-full min-w-0 ${isUser ? 'justify-end' : 'justify-start'}`}
    >
      <div
        className={
          // Bubbles for the user, full measure for the assistant. Wrapping long
          // model replies in a 75%-wide tinted box is the single strongest
          // "amateur chat app" signal; every serious assistant UI lets the
          // answer occupy the reading column and distinguishes speakers by
          // spacing and weight instead.
          `flex min-w-0 flex-col gap-2 ${isUser ? 'max-w-[85%] items-end sm:max-w-[78%]' : 'w-full items-start'}`
        }
      >
        {message.images && message.images.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {message.images.map((img, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={i}
                src={`data:${img.mediaType};base64,${img.data}`}
                alt={img.name}
                className="max-h-52 rounded-xl border border-line object-cover"
              />
            ))}
          </div>
        )}

        {editing ? (
          <div className="w-full min-w-[260px] rounded-[1.25rem] border border-accent/50 bg-surface p-2.5">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={Math.min(10, draft.split('\n').length + 1)}
              className="w-full resize-none bg-transparent text-[0.95em] text-inherit outline-none placeholder:text-ink-faint"
              autoFocus
            />
            <div className="mt-1 flex justify-end gap-2 text-xs">
              <button
                onClick={() => setEditing(false)}
                className="rounded-lg px-2.5 py-1 text-ink-muted transition hover:bg-surface-hover hover:text-ink"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setEditing(false);
                  onEdit?.(draft);
                }}
                className="rounded-lg bg-accent px-2.5 py-1 font-medium text-accent-contrast transition hover:bg-accent-hover"
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
                ? 'rounded-[1.25rem] rounded-br-md bg-surface-strong px-4 py-2.5 text-ink'
                : message.error
                  ? 'w-full rounded-xl border border-danger/40 bg-danger-soft px-4 py-3 text-danger'
                  : 'w-full') + ' max-w-full'
            }
          >
            {message.generatedImage ? (
              <div className="flex flex-col gap-2">
                {message.text && <p className="text-sm text-ink-secondary">{message.text}</p>}
                <div className="group/img relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`data:${message.generatedImage.mime};base64,${message.generatedImage.b64}`}
                    alt="Generated"
                    className="max-w-full rounded-xl border border-line sm:max-w-md"
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
              <div className="mt-3 border-t border-line pt-3">
                <div className="mb-1.5 text-[0.7em] font-semibold uppercase tracking-[0.08em] text-ink-muted">
                  Sources
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {message.sources.map((s, i) => (
                    <a
                      key={i}
                      href={s.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="max-w-[240px] truncate rounded-full border border-line bg-surface px-2.5 py-1 text-[0.78em] text-ink-secondary transition hover:border-line-strong hover:bg-surface-hover hover:text-ink"
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

        <div className="flex items-center gap-0.5 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
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
            <span className="ml-1 flex items-center gap-1.5 text-[0.72em] text-ink-faint">
              {message.lane && (
                <span className="rounded-full border border-line px-1.5 py-0.5">
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
