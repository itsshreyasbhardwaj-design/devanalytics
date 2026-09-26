import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const pkg = (name: string) => path.join(root, 'packages', name, 'src', 'index.ts');

export const alias: Record<string, string> = {
  '@devanalytics/core': pkg('core'),
  '@devanalytics/api': pkg('api'),
  '@devanalytics/db': pkg('db'),
  '@devanalytics/event-ingestion': pkg('event-ingestion'),
  '@devanalytics/metrics': pkg('metrics'),
  '@devanalytics/anomaly-detection': pkg('anomaly-detection'),
  '@devanalytics/investigations': pkg('investigations'),
  '@devanalytics/github': pkg('github'),
  '@devanalytics/ai': pkg('ai'),
  '@devanalytics/sdk': pkg('sdk'),
  '@devanalytics/demo-data': pkg('demo-data'),
};

export default defineConfig({
  resolve: { alias },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});
