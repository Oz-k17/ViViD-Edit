import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { classicScript, singleFileOutput } from './vite-shared';

/**
 * 組み立てた時点の印。
 *
 * 「直したはずのものが出ない」の大半は、配り先に古いものが残っていること。
 * 画面に印が出ていれば、それを見るだけで新旧が分かる。
 * git が無い所で組んでも落ちないようにしてある。
 */
function buildStamp(): string {
  const at = new Date().toISOString().slice(0, 16).replace('T', ' ');
  try {
    const commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
    return `${at} (${commit})`;
  } catch {
    return at;
  }
}

export default defineConfig({
  define: { __BUILD_STAMP__: JSON.stringify(buildStamp()) },
  plugins: [react(), classicScript()],
  // どこに置いても動くよう、参照は相対パスにする。
  base: './',
  build: {
    modulePreload: false,
    rollupOptions: { output: singleFileOutput },
  },
  server: {
    port: 5173,
    host: true,
  },
});
