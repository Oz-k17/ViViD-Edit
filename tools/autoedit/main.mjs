/**
 * 書き起こしと素材から、ViViD Edit で開けるプロジェクトを組み立てる。
 *
 *   npm run autoedit -- --video /srv/media/配信.mp4 --src 配信.mp4 \
 *     --transcript 書き起こし.json --from 3600 --to 3660 --out 切り抜き.vivid.json
 *
 * 作るのは**完成品ではなく下書き**。アプリで開いて、気に入らない所を直す前提。
 *
 * `--src` は**アプリ側の素材フォルダから見た相対パス**。ここがずれると、
 * 開いた側で絵が出ない（プロジェクトファイルは素材の実体を持たないため）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const { buildAutoEdit, toProjectFile } = await import('../../src/model/autoedit.ts');
const { parseTranscript } = await import('../../src/model/transcript.ts');
const { TEXT_PRESETS } = await import('../../src/presets.ts');

/** `--名前 値` と `--名前`（真偽）を読む。 */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

const HELP = `
使い方:
  npm run autoedit -- --video <素材ファイル> --transcript <書き起こし> --out <出力.vivid.json>

要るもの:
  --video <path>        素材の実体。寸法と尺を読むのに使う
  --transcript <path>   SRT / VTT / Whisper の JSON
  --out <path>          書き出す先（.vivid.json）

任意:
  --src <path>          アプリの素材フォルダから見た相対パス（既定: --video のファイル名）
  --from <秒> --to <秒> 使う範囲（既定: 丸ごと）
  --layout full|three   画の組み方（既定: full）
  --style <key>         テロップの体裁（既定: tv）。${TEXT_PRESETS.map((p) => p.key).join(' / ')}
  --title <文言>        見出しを置く
  --max-chars <数>      1 枚の文字数の上限（既定: 24）
  --no-extend           短い行を伸ばさない
  --width --height --duration
                        ffprobe が無いときに、素材の寸法と尺を直接渡す
`;

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.video || !args.transcript || !args.out) {
  console.log(HELP);
  process.exit(args.help ? 0 : 1);
}

/** ffprobe があれば寸法と尺を読む。無ければ渡された値を使う。 */
function probe(file) {
  const given = {
    width: Number(args.width) || 0,
    height: Number(args.height) || 0,
    duration: Number(args.duration) || 0,
  };
  if (given.width && given.height && given.duration) return given;
  try {
    const json = execFileSync(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration',
       '-of', 'json', file],
      { encoding: 'utf8' },
    );
    const data = JSON.parse(json);
    const stream = data.streams?.[0] ?? {};
    return {
      width: given.width || Number(stream.width) || 0,
      height: given.height || Number(stream.height) || 0,
      duration: given.duration || Number(data.format?.duration) || 0,
    };
  } catch {
    return given;
  }
}

const info = probe(args.video);
if (!info.duration) {
  console.error('素材の尺が分かりません。ffprobe を入れるか、--duration（と --width --height）を渡してください。');
  process.exit(1);
}

const cues = parseTranscript(fs.readFileSync(args.transcript, 'utf8'));
if (cues.length === 0) {
  console.error('書き起こしを読めませんでした。SRT・VTT・Whisper の JSON のどれかを渡してください。');
  process.exit(1);
}

const styleKey = typeof args.style === 'string' ? args.style : 'tv';
const style = TEXT_PRESETS.find((p) => p.key === styleKey);
if (!style) {
  console.error(`体裁 "${styleKey}" は見つかりません。${TEXT_PRESETS.map((p) => p.key).join(' / ')} から選んでください。`);
  process.exit(1);
}
const titleStyle = TEXT_PRESETS.find((p) => p.key === 'title');

const media = {
  id: `asset_${path.basename(args.video).replace(/[^\w.-]/g, '_')}`,
  name: path.basename(args.video),
  kind: 'video',
  src: typeof args.src === 'string' ? args.src : path.basename(args.video),
  ...info,
};

const result = buildAutoEdit(media, cues, {
  name: typeof args.name === 'string' ? args.name : undefined,
  from: args.from !== undefined ? Number(args.from) : undefined,
  to: args.to !== undefined ? Number(args.to) : undefined,
  layout: args.layout === 'three' ? 'three' : 'full',
  captionStyle: style.text,
  titleStyle: titleStyle?.text,
  title: typeof args.title === 'string' ? args.title : undefined,
  speakerColors: { 1: '#5cd6ff', 2: '#c084fc' },
  maxChars: args['max-chars'] !== undefined ? Number(args['max-chars']) : undefined,
  extendShort: !args['no-extend'],
});

fs.writeFileSync(args.out, JSON.stringify(toProjectFile(result, media), null, 2));

console.log(`書き出しました: ${args.out}`);
console.log(`  範囲    ${result.span.from.toFixed(1)} 〜 ${result.span.to.toFixed(1)} 秒`);
console.log(`  テロップ ${result.captions} 枚`);
console.log(`  素材    ${media.src}（${info.width}x${info.height} / ${info.duration.toFixed(1)} 秒）`);
if (result.notes.length) {
  console.log('\n確かめてほしい所:');
  for (const note of result.notes) console.log('  - ' + note);
}
console.log('\nアプリの「設定 → プロジェクトの受け渡し」から開いてください。');
