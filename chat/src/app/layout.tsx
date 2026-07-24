import type { Metadata } from 'next';
import './globals.css';
import 'highlight.js/styles/github-dark.css';

export const metadata: Metadata = {
  title: 'Kompass AI',
  description: 'Chat, vision, image generation and web research — routed through your free-model Kompass gateway.',
  icons: {
    icon: [
      {
        url:
          "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Cdefs%3E%3ClinearGradient id='kg' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%2338bdf8'/%3E%3Cstop offset='1' stop-color='%236366f1'/%3E%3C/linearGradient%3E%3C/defs%3E%3Ccircle cx='32' cy='32' r='30' fill='url(%23kg)'/%3E%3Ccircle cx='32' cy='32' r='24' fill='%230f172a'/%3E%3Cg stroke='%237dd3fc' stroke-width='2.5' stroke-linecap='round'%3E%3Cline x1='32' y1='11' x2='32' y2='15' transform='rotate(45 32 32)'/%3E%3Cline x1='32' y1='11' x2='32' y2='15' transform='rotate(135 32 32)'/%3E%3Cline x1='32' y1='11' x2='32' y2='15' transform='rotate(225 32 32)'/%3E%3Cline x1='32' y1='11' x2='32' y2='15' transform='rotate(315 32 32)'/%3E%3C/g%3E%3Cpolygon points='32,12 39,32 25,32' fill='%23f43f5e'/%3E%3Cpolygon points='32,52 25,32 39,32' fill='%23e2e8f0'/%3E%3Ccircle cx='32' cy='32' r='3.5' fill='%230f172a' stroke='%23e2e8f0' stroke-width='1.5'/%3E%3C/svg%3E",
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
  var theme = s && s.theme === 'light' ? 'light' : 'dark';
  document.documentElement.classList.toggle('light', theme === 'light');
} catch (e) {}
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
