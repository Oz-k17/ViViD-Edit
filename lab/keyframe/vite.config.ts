import { defineConfig } from 'vite';
import { classicScript, singleFileOutput } from '../../vite-shared';

/**
 * キーフレームの画面のビルド設定。ほかの 5 つの画面と同じ理由で同じ形にしてある
 * （置き場所は `docs/lab/` だったり、リポジトリを落として直接開いたりするので、
 * file:// で開いても動く 1 ファイルにまとめる）。
 *
 * `server.fs.allow` を広げているのは、この画面が root（`lab/keyframe`）の外にある
 * **判断を置かない部品**を 1 つ借りているため——見た目（`auto-cut/src/style.css`）だけ。
 * この試作は素材を読まないので、`scene-cut/src/decode.ts` は借りていない
 * （絵は `<video>` / `<img>` にそのまま出させるので、コマの列に起こす必要が無い）。
 */
export default defineConfig({
  plugins: [classicScript()],
  base: './',
  server: { fs: { allow: ['../..'] } },
  build: {
    modulePreload: false,
    rollupOptions: { output: singleFileOutput },
  },
});
