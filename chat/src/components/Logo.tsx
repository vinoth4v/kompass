/**
 * Kompass mark and wordmark.
 *
 * A compass rose reduced to its essential gesture: a ring, a north needle, and
 * a south counterweight. Drawn with `currentColor` for the ring and the muted
 * half of the needle so it inherits the theme instead of carrying a second
 * palette — the previous favicon hardcoded slate/rose/sky and looked pasted-on
 * against either theme.
 *
 * The needle is the only saturated element. That is deliberate: one accent per
 * mark is what keeps it legible at 16px in a browser tab.
 */
export function LogoMark({ size = 24, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <circle cx="16" cy="16" r="13.25" stroke="currentColor" strokeWidth="1.5" opacity="0.32" />
      {/* Cardinal ticks — subtle, they read as texture rather than detail. */}
      <g stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.32">
        <path d="M16 3.4v2.4" />
        <path d="M16 26.2v2.4" />
        <path d="M3.4 16h2.4" />
        <path d="M26.2 16h2.4" />
      </g>
      {/* North needle in the accent, south in the neutral — the classic compass
          asymmetry, which also tells you at a glance which way is up. */}
      <path d="M16 7.2 20.1 17 16 15.1Z" fill="var(--accent)" />
      <path d="M16 7.2 11.9 17 16 15.1Z" fill="var(--accent)" opacity="0.62" />
      <path d="M16 24.8 11.9 17 16 18.9Z" fill="currentColor" opacity="0.55" />
      <path d="M16 24.8 20.1 17 16 18.9Z" fill="currentColor" opacity="0.3" />
      <circle cx="16" cy="16.9" r="1.5" fill="var(--bg)" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`flex items-center gap-2 ${className}`}>
      <LogoMark size={22} className="text-ink" />
      <span className="text-[0.95rem] font-semibold tracking-[-0.015em] text-ink">
        Kompass
        <span className="ml-1 font-normal text-ink-muted">AI</span>
      </span>
    </span>
  );
}
