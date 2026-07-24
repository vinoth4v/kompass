import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Kompass brand ramp — matches site/index.html's compass-blue → indigo gradient.
        brand: {
          400: '#38bdf8',
          500: '#4d8dff',
          600: '#6366f1',
        },
      },
      fontFamily: {
        mono: [
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'monospace',
        ],
      },
    },
  },
  plugins: [],
};
export default config;
