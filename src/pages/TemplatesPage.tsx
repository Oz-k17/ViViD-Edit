import { useState } from 'react';
import { applyToCaptions } from '../model/dictionary';
import { useNavigate } from '../router';
import { LayoutToggle } from '../components/LayoutToggle';
import { Brand, SiteNav } from '../components/SiteNav';
import { Panel } from '../components/ui';
import { player } from '../engine/player';
import { textClip } from '../model/factory';
import { placeClip, tracksOf } from '../model/ops';
import { useApp, type Template } from '../store/app';
import { useEditor } from '../store/editor';

export default function TemplatesPage() {
  const { templates, removeTemplate, renameTemplate, dictionary, learnWord, removeWord, recordHits } = useApp();
  const [newFrom, setNewFrom] = useState('');
  const [newTo, setNewTo] = useState('');
  const [applied, setApplied] = useState<string | null>(null);
  const applyDict = () => {
    // 外のタイムラインごと当てる（まとめたクリップの中の字幕は、中に入って当てる）。
    const result = applyToCaptions(sequence, dictionary);
    if (result.changed > 0) {
      apply(() => result.sequence);
      recordHits(result.counts);
    }
    const total = [...result.counts.values()].reduce((a, b) => a + b, 0);
    setApplied(result.changed > 0 ? `字幕 ${result.changed} 行・${total} か所を直しました。` : '直す所はありませんでした。');
  };
  const { project, sequence, apply, dispatch, selection, setSelection } = useEditor();
  const navigate = useNavigate();

  /** テロップスタイル: 選択中のテロップに当てる。無ければ再生ヘッド位置に新規作成。 */
  const applyTemplate = (template: Template) => {
    if (template.kind === 'text') {
      const target = sequence.clips.find((c) => selection.includes(c.id) && c.kind === 'text');
      if (target) {
        apply((seq) => ({
          ...seq,
          clips: seq.clips.map((c) =>
            c.id === target.id ? { ...c, text: { ...template.text, content: c.text?.content ?? template.text.content } } : c,
          ),
        }));
      } else {
        const track = tracksOf(sequence, 'text')[0];
        if (!track) return;
        const clip = textClip(track.id, player.time, 3, template.text);
        apply((seq) => placeClip(seq, clip));
        setSelection([clip.id]);
      }
    } else if (template.kind === 'layout') {
      if (!window.confirm('現在のタイムラインをこのレイアウトで置き換えます。よろしいですか？')) return;
      dispatch({ type: 'load', project: { ...project, sequence: template.sequence } });
    }
    navigate('/');
  };

  const textTemplates = templates.filter((t) => t.kind === 'text');
  const layoutTemplates = templates.filter((t) => t.kind === 'layout');
  const kitTemplates = templates.filter((t) => t.kind === 'kit');

  return (
    <div className="page">
      <header className="topbar">
        <Brand />
        <SiteNav />
        <div className="topbar-actions">
          <LayoutToggle />
        </div>
      </header>

      <main className="page-body">
        <Panel title={`わたし辞書（${dictionary.length}）`}>
          <p className="empty-hint">
            字幕を手で直すと、その直しをここに覚えます。次に音から字幕を起こしたとき、自動で直します（見出しや飾りの文字には当てません）。
          </p>
          {dictionary.length > 0 && (
            <ul className="template-list dictionary-list">
              {[...dictionary].reverse().map((entry) => (
                <li key={entry.from}>
                  <span className="dict-pair">
                    <span>{entry.from}</span> → <strong>{entry.to || '（消す）'}</strong>
                  </span>
                  <span className="muted">{entry.hits > 0 ? `${entry.hits} 回直した` : 'まだ使っていない'}</span>
                  <button type="button" className="danger" onClick={() => removeWord(entry.from)}>
                    削除
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="dict-add">
            <input type="text" value={newFrom} placeholder="間違える言葉" aria-label="間違える言葉" onChange={(e) => setNewFrom(e.target.value)} />
            <span aria-hidden="true">→</span>
            <input type="text" value={newTo} placeholder="正しい言葉" aria-label="正しい言葉" onChange={(e) => setNewTo(e.target.value)} />
            <button
              type="button"
              disabled={!newFrom.trim() || newFrom === newTo}
              onClick={() => {
                learnWord(newFrom.trim(), newTo.trim());
                setNewFrom('');
                setNewTo('');
              }}
            >
              足す
            </button>
          </div>
          {dictionary.length > 0 && (
            <button type="button" className="wide" onClick={applyDict}>
              いまのタイムラインの字幕に当てる
            </button>
          )}
          {applied && <p className="muted small">{applied}（エディタの「戻す」で戻せます）</p>}
        </Panel>

        <Panel title={`自分の型（${kitTemplates.length}）`}>
          {kitTemplates.length === 0 ? (
            <p className="empty-hint">
              一度組んだ 3 分割（まとめたクリップ）を選び、「この 3 分割を自分の型にする」で追加できます。
              次からは「3 分割に組む」の型の欄で選ぶだけで、同じ切り抜き位置・同じ見出しの体裁で組めます。
            </p>
          ) : (
            <ul className="template-list">
              {kitTemplates.map((template) => (
                <li key={template.id}>
                  <span className="template-preview layout">型</span>
                  <input type="text" value={template.name} onChange={(e) => renameTemplate(template.id, e.target.value)} />
                  <span className="muted">
                    {template.kind === 'kit' ? (template.kit.title ? '見出しつき' : '見出しなし') : ''}
                  </span>
                  <button type="button" className="danger" onClick={() => removeTemplate(template.id)}>
                    削除
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title={`テロップスタイル（${textTemplates.length}）`}>
          {textTemplates.length === 0 ? (
            <p className="empty-hint">
              エディタでテロップを選び、テキストタブの「このスタイルをテンプレートに保存」から追加できます。
            </p>
          ) : (
            <ul className="template-list">
              {textTemplates.map((template) => (
                <li key={template.id}>
                  <span
                    className="template-preview"
                    style={{
                      fontFamily: template.kind === 'text' ? template.text.fontFamily : undefined,
                      color: template.kind === 'text' ? template.text.color : undefined,
                      WebkitTextStroke:
                        template.kind === 'text' && template.text.strokeWidth > 0
                          ? `${Math.min(3, template.text.strokeWidth / 3)}px ${template.text.strokeColor}`
                          : undefined,
                      fontWeight: template.kind === 'text' ? template.text.weight : undefined,
                    }}
                  >
                    Aa あ
                  </span>
                  <input type="text" value={template.name} onChange={(e) => renameTemplate(template.id, e.target.value)} />
                  <button type="button" onClick={() => applyTemplate(template)}>
                    適用
                  </button>
                  <button type="button" className="danger" onClick={() => removeTemplate(template.id)}>
                    削除
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title={`動画レイアウト（${layoutTemplates.length}）`}>
          {layoutTemplates.length === 0 ? (
            <p className="empty-hint">エディタ上部の「レイアウトを保存」で、いまのタイムライン構成を丸ごと保存できます。</p>
          ) : (
            <ul className="template-list">
              {layoutTemplates.map((template) => (
                <li key={template.id}>
                  <span className="template-preview layout">
                    {template.kind === 'layout' ? template.sequence.aspect : ''}
                  </span>
                  <input type="text" value={template.name} onChange={(e) => renameTemplate(template.id, e.target.value)} />
                  <span className="muted">
                    {template.kind === 'layout'
                      ? `${template.sequence.clips.length} クリップ / ${template.sequence.tracks.length} トラック`
                      : ''}
                  </span>
                  <button type="button" onClick={() => applyTemplate(template)}>
                    適用
                  </button>
                  <button type="button" className="danger" onClick={() => removeTemplate(template.id)}>
                    削除
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </main>
    </div>
  );
}
