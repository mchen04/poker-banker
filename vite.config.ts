import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ command }) => {
  const release = process.env.RELEASE_VERSION?.trim();
  if (command === 'build' && !release) throw new Error('RELEASE_VERSION is required. Use pnpm build to stamp the worker');
  return {
    envDir: false,
    plugins: [react(), {
      name: 'release-meta',
      transformIndexHtml: () => [{ tag: 'meta', attrs: { name: 'pb-release', content: release ?? 'development' }, injectTo: 'head' }],
    }],
    define: { __APP_RELEASE__: JSON.stringify(release ?? 'development') },
  };
});
