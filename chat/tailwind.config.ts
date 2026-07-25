import type { Config } from 'tailwindcss';

/**
 * Colours resolve to the CSS variables in globals.css, so `bg-surface` and
 * friends are theme-aware by construction. Components no longer need paired
 * `white/10 dark:black/10` classes, which is what made the old UI drift between
 * light and dark.
 */
const config: Config = {
  // The theme switch adds `.light` to <html>; there is no `.dark` class. So
  // `dark:` is defined as "not .light", letting components carry a
  // light-safe colour plus a dark override in one string.
  darkMode: ['variant', '&:where(html:not(.light) *)'],
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        elevated: 'var(--bg-elevated)',
        surface: {
          DEFAULT: 'var(--surface)',
          hover: 'var(--surface-hover)',
          strong: 'var(--surface-strong)',
        },
        line: {
          DEFAULT: 'var(--border)',
          strong: 'var(--border-strong)',
        },
        ink: {
          DEFAULT: 'var(--text)',
          secondary: 'var(--text-secondary)',
          muted: 'var(--text-muted)',
          faint: 'var(--text-faint)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          hover: 'var(--accent-hover)',
          contrast: 'var(--accent-contrast)',
          soft: 'var(--accent-soft)',
        },
        warn: { DEFAULT: 'var(--warn)', soft: 'var(--warn-soft)' },
        ok: { DEFAULT: 'var(--ok)', soft: 'var(--ok-soft)' },
        danger: { DEFAULT: 'var(--danger)', soft: 'var(--danger-soft)' },
        info: { DEFAULT: 'var(--info)', soft: 'var(--info-soft)' },
        // Kept so any remaining brand-* class still resolves during the redesign.
        brand: { 400: 'var(--accent-hover)', 500: 'var(--accent)', 600: 'var(--accent)' },
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      boxShadow: {
        sm: 'var(--shadow-sm)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
      },
      maxWidth: {
        // Reading measure for assistant prose — ~68 characters at the base size.
        thread: '46rem',
      },
      transitionTimingFunction: {
        out: 'cubic-bezier(0.22, 1, 0.36, 1)',
      },
    },
  },
  plugins: [],
};
export default config;
