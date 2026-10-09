import { useEffect, useState } from 'react';
import { isFrameAccurate, isNativeHost } from '../engine/exporter';
import { mediaRegistry } from '../engine/media';

/** この端末で、何が使えて何が使えないか。症状を伝えるとき、そのままコピーして送れるようにする。 */
async function collect(): Promise<string[]> {
  const g = globalThis as Record<string, unknown>;
  const yes = (v: boolean) => (v ? '○' : '×');
  const lines: string[] = [];

  lines.push(`組み立て: ${typeof __BUILD_STAMP__ === 'string' ? __BUILD_STAMP__ : '不明'}`);
  lines.push(`開き方: ${isNativeHost() ? 'iOS アプリ版（WKWebView）' : 'ブラウザ'} / ${location.protocol}`);
  lines.push(`端末: ${navigator.userAgent}`);
  const nav = navigator as Navigator & { deviceMemory?: number };
  lines.push(
    `メモリの目安: ${nav.deviceMemory ? nav.deviceMemory + 'GB' : '分からない（iPad は教えてくれません）'} / CPU ${navigator.hardwareConcurrency ?? '?'} コア / 画面 ${screen.width}×${screen.height} @${window.devicePixelRatio}x`,
  );
  lines.push(`安全なコンテキスト: ${yes(window.isSecureContext)}`);

  lines.push(
    `WebCodecs: 映像の書き出し ${yes(typeof g.VideoEncoder === 'function')} / 映像の読み込み ${yes(typeof g.VideoDecoder === 'function')} / 音の書き出し ${yes(typeof g.AudioEncoder === 'function')} / 音の読み込み ${yes(typeof g.AudioDecoder === 'function')}`,
  );
  lines.push(`書き出しの方式: ${isFrameAccurate() ? '1 コマずつ（高精度）' : '実時間で収録（保険の方式。尺と同じだけ時間がかかる）'}`);

  const recorder = typeof MediaRecorder !== 'undefined' ? MediaRecorder : null;
  lines.push(
    `実時間収録: ${recorder ? `MP4 ${yes(recorder.isTypeSupported('video/mp4'))} / WebM ${yes(recorder.isTypeSupported('video/webm'))}` : '使えません'}`,
  );

  try {
    await navigator.storage.getDirectory();
    lines.push('ブラウザ内のファイル領域（OPFS）: ○');
  } catch {
    lines.push('ブラウザ内のファイル領域（OPFS）: ×（軽量版はメモリで作るため、短い動画だけ）');
  }
  try {
    const estimate = await navigator.storage.estimate();
    const mb = (n?: number) => (n === undefined ? '?' : Math.round(n / 1024 / 1024) + 'MB');
    lines.push(`保存領域: 使用 ${mb(estimate.usage)} / 上限 ${mb(estimate.quota)}`);
  } catch {
    lines.push('保存領域: 調べられません');
  }
  try {
    const persisted = await navigator.storage.persisted?.();
    lines.push(`保存領域を消されないようにする設定: ${persisted === undefined ? '分からない' : yes(persisted)}`);
  } catch {
    /* 無い環境 */
  }

  const assets = mediaRegistry.all();
  const total = assets.reduce((n, a) => n + (a.src ? 0 : a.size), 0);
  const longest = assets.reduce((m, a) => Math.max(m, a.duration), 0);
  lines.push(
    `素材: ${assets.length} 本（取り込み ${Math.round(total / 1024 / 1024)}MB / 最長 ${Math.round(longest / 60)} 分 / 軽量版 ${assets.filter((a) => a.proxy).length} 本）`,
  );

  try {
    const count = localStorage.getItem('vivid-edit.recoveries');
    const at = localStorage.getItem('vivid-edit.recoveries.at');
    lines.push(
      `メモリ不足で画面が読み込み直された回数: ${count ?? '0'}${at ? `（最後: ${new Date(at).toLocaleString('ja-JP')}）` : ''}`,
    );
  } catch {
    /* 数えていない */
  }
  return lines;
}

export function Diagnostics() {
  const [lines, setLines] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void mediaRegistry.restore().then(() => collect()).then(setLines);
  }, []);

  const copy = async () => {
    if (!lines) return;
    const text = lines.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      // クリップボードに書けない環境（file:// など）では、選択してコピーしてもらう。
      const el = document.getElementById('diagnostics-text');
      if (el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    }
  };

  return (
    <>
      <pre
        id="diagnostics-text"
        className="diagnostics"
        style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 11, lineHeight: 1.6, margin: 0, userSelect: 'text' }}
      >
        {lines ? lines.join('\n') : '調べています…'}
      </pre>
      <button type="button" className="wide ghost" onClick={() => void copy()} disabled={!lines}>
        {copied ? 'コピーしました' : '診断をコピー'}
      </button>
    </>
  );
}
