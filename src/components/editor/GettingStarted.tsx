import { useRef, useState } from 'react';
import { mediaRegistry } from '../../engine/media';
import { clipFromAsset } from '../../model/factory';
import { placeClips } from '../../model/editOps';
import { adoptSourceFps, tracksOf } from '../../model/ops';
import { clipEnd } from '../../model/types';
import { useEditor } from '../../store/editor';
import { Icon } from '../Icon';
import { importFiles } from './MediaPanel';

/**
 * 何も置いていないときだけ出す、はじめの案内。
 * 「素材を入れる → 切る → 文字 → 書き出す」の 4 手を、言葉で並べる。
 * 最初のボタンは、選んだ動画を読み込んで、そのままタイムラインの頭から並べる
 * （「読み込む」と「置く」を別々に覚えなくてよいように）。
 */
export function GettingStarted() {
  const { sequence, apply } = useEditor();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (sequence.clips.length > 0) return null;

  const start = async (files: FileList) => {
    setBusy(true);
    setError(null);
    const before = new Set(mediaRegistry.all().map((a) => a.id));
    const errors = await importFiles(files);
    const added = mediaRegistry
      .all()
      .filter((a) => !before.has(a.id))
      .sort((a, b) => a.createdAt - b.createdAt);
    setBusy(false);
    if (errors.length) setError(errors.join(' / '));
    if (added.length === 0) return;
    apply((seq) => {
      let next = seq;
      for (const kind of ['video', 'audio'] as const) {
        const group = added.filter((a) => (a.kind === 'audio' ? 'audio' : 'video') === kind);
        const track = tracksOf(next, kind)[0];
        if (group.length === 0 || !track) continue;
        let at = 0;
        const clips = group.map((asset) => {
          const clip = clipFromAsset(asset, track.id, at);
          at = clipEnd(clip);
          return clip;
        });
        next = placeClips(adoptSourceFps(next, group[0].fps), clips, false);
      }
      return next;
    });
  };

  return (
    <div className="getting-started" role="region" aria-label="はじめかた">
      <h2>はじめかた</h2>
      <ol>
        <li>
          <strong>動画を選ぶ</strong>
          <span>下のボタンで、編集したい動画を選びます（何本でも）。</span>
        </li>
        <li>
          <strong>いらない所を切る</strong>
          <span>切りたい所で止めて「分割」。いらない部分を選んで「削除」。</span>
        </li>
        <li>
          <strong>文字を入れる</strong>
          <span>「＋ テロップ」を押して、文字を打ちます。</span>
        </li>
        <li>
          <strong>保存する</strong>
          <span>右上の「書き出し」を押すと、投稿できる動画になります。</span>
        </li>
      </ol>
      <input
        ref={inputRef}
        type="file"
        accept="video/*,image/*,audio/*"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) void start(e.target.files);
          e.target.value = '';
        }}
      />
      <button type="button" className="primary big" disabled={busy} onClick={() => inputRef.current?.click()}>
        {busy ? '読み込み中…' : <><Icon name="plus" />動画を選ぶ</>}
      </button>
      {error && <p className="error-note">{error}</p>}
      <p className="muted small">ファイルはこの端末の中だけで処理されます。どこにも送られません。</p>
    </div>
  );
}
