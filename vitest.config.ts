import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    include: ['test/**/*.test.ts'],
    poolOptions: {
      workers: {
        // Not wrangler.jsonc: that declares the Workers AI binding, which has no
        // local Miniflare implementation and forces the pool into remote mode
        // (fails without `wrangler login`). See test/config-parity.test.ts.
        wrangler: { configPath: './wrangler.test.jsonc' },
        miniflare: {
          kvNamespaces: ['CONFIG'],
          bindings: {
            KOMPASS_BEARER: 'test-bearer-token',
            OPENROUTER_API_KEY: 'test-openrouter-key',
            GOOGLE_AI_KEY: 'test-google-key',
            NVIDIA_API_KEY: 'test-nvidia-key',
            CF_WORKERS_AI_KEY: 'test-cfai-key',
            // Enables the encrypted key vault inside the Worker under test.
            // Without it, SELF.fetch requests see a disabled vault and every
            // vault-backed credential resolves to "not configured".
            KOMPASS_MASTER_KEY: 'test-master-key-0123456789abcdef',
          },
        },
      },
    },
  },
});
