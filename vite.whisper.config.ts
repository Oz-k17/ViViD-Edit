import { defineConfig } from 'vite';

/**
 * 文字起こしの Worker だけを別に組む。
 *
 * 本体は 1 ファイルの IIFE（`file://` と iOS の WKWebView のため）だが、
 * transformers.js と onnxruntime はそこへ入れると本体が桁違いに重くなる。
 * 使うときだけ取りに行けるよう、ここだけ ES モジュールとして切り離す。
 */
export default defineConfig({
  build: {
    outDir: 'whisper-dist',
    emptyOutDir: true,
    target: 'es2022',
    lib: {
      entry: 'src/whisper/worker.ts',
      formats: ['es'],
      fileName: () => 'worker.js',
    },
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
});
