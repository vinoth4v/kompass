import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';

// Self-hosted at build time by next/font — no CDN request, no layout shift, and
// no dependency on a third party staying up. The default system stack was the
// single biggest reason the UI read as unfinished.
const sans = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-sans',
  axes: ['opsz'],
});
const mono = JetBrains_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-mono',
});

export const metadata: Metadata = {
  title: 'Kompass AI',
  description:
    'Chat, vision, image generation and web research — routed through your free-model Kompass gateway.',
  icons: {
    icon: [
      {
        // Same compass mark as components/Logo.tsx, flattened to fixed colours
        // for the tab (a favicon cannot read CSS variables).
        url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='13.25' stroke='%23a0a0aa' stroke-width='1.5' fill='none'/%3E%3Cpath d='M16 7.2 20.1 17 16 15.1Z' fill='%234f5bd5'/%3E%3Cpath d='M16 7.2 11.9 17 16 15.1Z' fill='%236d7cff'/%3E%3Cpath d='M16 24.8 11.9 17 16 18.9Z' fill='%2374747e'/%3E%3Cpath d='M16 24.8 20.1 17 16 18.9Z' fill='%23a0a0aa'/%3E%3C/svg%3E",
        type: 'image/svg+xml',
      },
    ],
  },
};

// Theme is applied to <html> before paint via an inline script (avoids a
// flash of the wrong theme — the class is read from localStorage, which
// isn't available during server rendering).
const themeInitScript = `
try {
  var s = JSON.parse(localStorage.getItem('kompass_chat_settings_v1') || 'null');
  // Light is the default; only an explicit stored preference selects dark.
  var theme = s && s.theme === 'dark' ? 'dark' : 'light';
  document.documentElement.classList.toggle('light', theme === 'light');
} catch (e) {}
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} light`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
