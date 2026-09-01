import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 出力した <script> から type="module" と crossorigin を外す。
 * どちらも file:// から読むと CORS で弾かれ、ファイルを直接開いた場合と
 * iOS 版の WKWebView（file:// で読み込む）で画面が真っ白になる。
 * 中身は IIFE なので、module 指定なしの defer で同じ挙動になる。
 */
function classicScript(): Plugin {
  return {
    name: 'classic-script-tag',
    enforce: 'post',
    transformIndexHtml(html) {
      return html.replace(/<script\s+type="module"\s+crossorigin\s+/g, '<script defer ');
    },
  };
}

export default defineConfig({
  plugins: [react(), classicScript()],
  // どこに置いても動くよう、参照は相対パスにする。
  base: './',
  build: {
    modulePreload: false,
    rollupOptions: {
      output: {
        format: 'iife',
        inlineDynamicImports: true,
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
      },
    },
  },
  server: {
    port: 5173,
    host: true,
  },
});
