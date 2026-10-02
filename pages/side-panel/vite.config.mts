import { resolve } from 'node:path';
import { withPageConfig } from '@extension/vite-config';

const rootDir = resolve(__dirname);
const srcDir = resolve(rootDir, 'src');
// The agent spider's engine lives with the content script; the chat panel runs the same one.
const spiderDir = resolve(rootDir, '..', 'content', 'src', 'spider');

export default withPageConfig({
  resolve: {
    alias: {
      '@src': srcDir,
      '@spider': spiderDir,
    },
  },
  publicDir: resolve(rootDir, 'public'),
  build: {
    outDir: resolve(rootDir, '..', '..', 'dist', 'side-panel'),
  },
});
