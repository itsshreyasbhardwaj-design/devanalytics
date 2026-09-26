import { defineWorkspace } from 'vitest/config';
import { alias } from './vitest.config.js';

const heavy = {
  testTimeout: 180_000,
  hookTimeout: 180_000,
  pool: 'forks' as const,
  poolOptions: { forks: { singleFork: true } },
};

export default defineWorkspace([
  {
    resolve: { alias },
    test: { name: 'unit', include: ['tests/unit/**/*.test.ts'], environment: 'node' },
  },
  {
    resolve: { alias },
    test: { name: 'integration', include: ['tests/integration/**/*.test.ts'], environment: 'node', ...heavy },
  },
  {
    resolve: { alias },
    test: { name: 'security', include: ['tests/security/**/*.test.ts'], environment: 'node', ...heavy },
  },
]);
