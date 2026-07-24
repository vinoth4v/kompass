import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    include: ['test/**/*.test.ts'],
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          kvNamespaces: ['CONFIG'],
          bindings: {
            KOMPASS_BEARER: 'test-bearer-token',
            OPENROUTER_API_KEY: 'test-openrouter-key',
            GOOGLE_AI_KEY: 'test-google-key',
            NVIDIA_API_KEY: 'test-nvidia-key',
            CF_WORKERS_AI_KEY: 'test-cfai-key',
          },
        },
      },
    },
  },
});
