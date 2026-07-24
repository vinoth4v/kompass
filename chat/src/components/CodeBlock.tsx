'use client';
import { Check, Copy } from 'lucide-react';
import { useRef, useState } from 'react';

/**
 * react-markdown `code` override. Fenced code blocks arrive with a
 * `language-xxx` className (from the ``` info string) plus rehype-highlight's
 * `hljs` tokenization spans as children; inline code has no className. Pair
 * with `pre: ({ children }) => <>{children}</>` in the markdown `components`
 * prop so this renders the only <pre> (otherwise block code ends up wrapped
 * in two nested <pre> tags).
 */
export function CodeBlock({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLElement> & { children?: React.ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState(false);
  const isBlock = /language-/.test(className ?? '');
  const lang = /language-(\S+)/.exec(className ?? '')?.[1] ?? 'text';

  if (!isBlock) {
    return (
      <code className="rounded bg-white/10 px-1.5 py-0.5 text-[0.88em]" {...props}>
        {children}
      </code>
    );
  }

  const copy = () => {
    const text = ref.current?.textContent ?? '';
    navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className="my-3 overflow-hidden rounded-xl border border-white/10 bg-black/40">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-1.5 text-xs text-white/50">
        <span className="font-mono">{lang}</span>
        <button
          onClick={copy}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-white/60 transition hover:bg-white/10 hover:text-white"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 text-[0.86em] leading-relaxed">
        <code ref={ref} className={className} {...props}>
          {children}
        </code>
      </pre>
    </div>
  );
}
