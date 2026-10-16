import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { classicScript, singleFileOutput } from './vite-shared';

/**
 * 組み立てた時点の印（日本時間）。
 *
 * 「直したはずのものが出ない」の大半は、配り先に古いものが残っていること。
 * 画面に印が出ていれば、それを見るだけで新旧が分かる。
 *
 * 以前は commit の番号も入れていたが、組み立ててからコミットするので、**1 つ前の番号**が出ていた
 * （GitHub の最新と見比べると、古いものに見える）。日時だけにして、同じ印を README にも書く
 * （`scripts/sync-bundles.mjs` が `version.json` を読んで書き込む）。
 */
const BUILD_STAMP = (() => {
  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}（日本時間）`;
})();

/** 組み立ての印を dist/version.json にも置く（README に同じ印を書くため）。 */
function versionFile(): Plugin {
  return {
    name: 'vivid-version-file',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ stamp: BUILD_STAMP }) + '\n' });
    },
  };
}

export default defineConfig({
  define: { __BUILD_STAMP__: JSON.stringify(BUILD_STAMP) },
  plugins: [react(), classicScript(), versionFile()],
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
