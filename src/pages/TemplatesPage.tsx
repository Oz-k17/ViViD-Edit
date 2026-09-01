import { useNavigate } from 'react-router-dom';
import { LayoutToggle } from '../components/LayoutToggle';
import { Brand, SiteNav } from '../components/SiteNav';
import { Panel } from '../components/ui';
import { player } from '../engine/player';
import { textClip } from '../model/factory';
import { placeClip, tracksOf } from '../model/ops';
import { useApp, type Template } from '../store/app';
import { useEditor } from '../store/editor';

export default function TemplatesPage() {
  const { templates, removeTemplate, renameTemplate } = useApp();
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
    } else {
      if (!window.confirm('現在のタイムラインをこのレイアウトで置き換えます。よろしいですか？')) return;
      dispatch({ type: 'load', project: { ...project, sequence: template.sequence } });
    }
    navigate('/');
  };

  const textTemplates = templates.filter((t) => t.kind === 'text');
  const layoutTemplates = templates.filter((t) => t.kind === 'layout');

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
            <p className="empty-hint">エディタ上部の「⌂ レイアウトを保存」で、いまのタイムライン構成を丸ごと保存できます。</p>
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
