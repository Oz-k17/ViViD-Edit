import { useEffect, useRef, useState } from 'react';
import { Brand, SiteNav } from '../components/SiteNav';
import { LayoutToggle } from '../components/LayoutToggle';
import { ButtonField, ColorInput, Field, Panel, Segmented, Slider, Toggle } from '../components/ui';
import { useFontOptions } from '../components/fontOptions';
import { FONT_FILE_ACCEPT, fontCss, fontRegistry } from '../engine/fonts';
import { player } from '../engine/player';
import { renderFrame } from '../engine/renderer';
import { DEFAULT_TEXT, createSequence, textClip } from '../model/factory';
import type { Sequence, TextProps } from '../model/types';
import { TEXT_PRESETS } from '../presets';
import { useNavigate } from '../router';
import { useApp } from '../store/app';
import { useEditor } from '../store/editor';
import { useSyncExternalStore } from 'react';

/**
 * テキストスタイルを作る画面。フォント（自分で足したものも）・文字の色・輪郭線（2 重まで）・太さ・大きさ・影などを、
 * 見本を見ながら決めて、テンプレート（テロップスタイル）として保存する。保存したものは、エディタの
 * テキストの「スタイル」→「自分のスタイル」から当てられる。
 */

const BACKGROUNDS = [
  { value: 'dark', label: '暗い背景' },
  { value: 'light', label: '明るい背景' },
  { value: 'busy', label: '映像っぽい背景' },
] as const;
type Backdrop = (typeof BACKGROUNDS)[number]['value'];

const WEIGHTS = [
  { value: '300', label: '細い' },
  { value: '400', label: 'ふつう' },
  { value: '700', label: '太い' },
  { value: '900', label: '極太' },
];

type Outline = '0' | '1' | '2';

const PREVIEW_W = 1080;
const PREVIEW_H = 600;

function drawBackdrop(ctx: CanvasRenderingContext2D, kind: Backdrop) {
  if (kind === 'dark' || kind === 'light') {
    ctx.fillStyle = kind === 'dark' ? '#1f2024' : '#f1f1f1';
    ctx.fillRect(0, 0, PREVIEW_W, PREVIEW_H);
    return;
  }
  // 映像の上に載せたときの読みやすさを見るための、色と明るさが混ざった背景。
  const g = ctx.createLinearGradient(0, 0, PREVIEW_W, PREVIEW_H);
  g.addColorStop(0, '#2b6cb0');
  g.addColorStop(0.45, '#f6e05e');
  g.addColorStop(0.7, '#e53e3e');
  g.addColorStop(1, '#22543d');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, PREVIEW_W, PREVIEW_H);
  for (let i = 0; i < 9; i++) {
    ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.35)';
    ctx.fillRect(i * 130 - 40, ((i * 97) % 5) * 110, 90, 160);
  }
}

function outlineOf(text: TextProps): Outline {
  if (text.strokeWidth > 0 && (text.strokeWidth2 ?? 0) > 0) return '2';
  if (text.strokeWidth > 0) return '1';
  return '0';
}

interface Editing {
  /** 書き換えているテンプレートの id。新しく作っているときは null。 */
  id: string | null;
  name: string;
  text: TextProps;
}

const freshStyle = (): TextProps => ({ ...DEFAULT_TEXT, content: 'テキストを入力', animation: 'none' });

export default function TextStylePage() {
  const { templates, addTemplate, updateTextTemplate, renameTemplate, removeTemplate } = useApp();
  const { sequence, selection, apply } = useEditor();
  const navigate = useNavigate();
  const styles = templates.filter((t) => t.kind === 'text');
  const [editing, setEditing] = useState<Editing>(() => ({ id: null, name: '', text: freshStyle() }));
  const [sample, setSample] = useState('今日の配信、\nいちばんの神回 BEST!');
  const [backdrop, setBackdrop] = useState<Backdrop>('busy');
  const [note, setNote] = useState<string | null>(null);
  const text = editing.text;
  const set = (patch: Partial<TextProps>) => setEditing((e) => ({ ...e, text: { ...e.text, ...patch } }));
  const fontOptions = useFontOptions(text.fontFamily);
  const fonts = useSyncExternalStore(fontRegistry.subscribe, () => fontRegistry.list());
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [fontsTick, setFontsTick] = useState(0);

  // フォントが読み込み終わったら描き直す（読み込み中は代わりのフォントで描かれるため）。
  useEffect(() => {
    const again = () => setFontsTick((n) => n + 1);
    document.fonts?.addEventListener?.('loadingdone', again);
    void document.fonts?.ready?.then(again);
    return () => document.fonts?.removeEventListener?.('loadingdone', again);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const base = createSequence();
    const track = base.tracks.find((t) => t.kind === 'text');
    if (!track) return;
    const clip = { ...textClip(track.id, 0, 3, { ...text, content: sample || 'あAa', animation: 'none' }), y: 0 };
    const preview: Sequence = { ...base, width: PREVIEW_W, height: PREVIEW_H, background: 'rgba(0,0,0,0)', clips: [clip] };
    drawBackdrop(ctx, backdrop);
    renderFrame(ctx, preview, 1.5, player.renderSources(), { guides: false });
  }, [text, sample, backdrop, fontsTick, fonts]);

  const startNew = () => {
    setEditing({ id: null, name: '', text: freshStyle() });
    setNote(null);
  };
  const open = (id: string) => {
    const t = styles.find((s) => s.id === id);
    if (t?.kind !== 'text') return;
    setEditing({ id, name: t.name, text: { ...t.text } });
    setNote(null);
  };
  const save = (asNew: boolean) => {
    const name = editing.name.trim() || `スタイル ${styles.length + 1}`;
    const style = { ...text, content: 'テキストを入力' };
    if (editing.id && !asNew) {
      updateTextTemplate(editing.id, style);
      renameTemplate(editing.id, name);
      setEditing((e) => ({ ...e, name }));
    } else {
      const created = addTemplate({ kind: 'text', name, text: style });
      setEditing({ id: created.id, name, text: style });
    }
    setNote(`「${name}」を保存しました。エディタのテキストの「スタイル」→「自分のスタイル」から当てられます。`);
  };
  const selectedTexts = sequence.clips.filter((c) => selection.includes(c.id) && c.kind === 'text');
  const applyToSelection = () => {
    const ids = new Set(selectedTexts.map((c) => c.id));
    apply((seq) => ({
      ...seq,
      clips: seq.clips.map((c) => (ids.has(c.id) && c.text ? { ...c, text: { ...text, content: c.text.content, speaker: c.text.speaker } } : c)),
    }));
    navigate('/');
  };

  // フォントを足す
  const fileRef = useRef<HTMLInputElement>(null);
  const [googleName, setGoogleName] = useState('');
  const [fontBusy, setFontBusy] = useState(false);
  const [fontNote, setFontNote] = useState<string | null>(null);
  const addFile = async (files: FileList | null) => {
    if (!files?.length) return;
    setFontBusy(true);
    setFontNote(null);
    try {
      let last = null;
      for (const file of Array.from(files)) last = await fontRegistry.addFile(file);
      if (last) set({ fontFamily: fontCss(last) });
      setFontNote(`「${last?.label}」を足して、このスタイルに選びました。`);
    } catch (e) {
      setFontNote(e instanceof Error ? e.message : 'フォントを足せませんでした');
    } finally {
      setFontBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };
  const addGoogle = async () => {
    setFontBusy(true);
    setFontNote(null);
    try {
      const font = await fontRegistry.addGoogle(googleName);
      set({ fontFamily: fontCss(font) });
      setGoogleName('');
      setFontNote(`「${font.label}」を足して、このスタイルに選びました。`);
    } catch (e) {
      setFontNote(e instanceof Error ? e.message : 'フォントを足せませんでした');
    } finally {
      setFontBusy(false);
    }
  };

  const outline = outlineOf(text);
  const setOutline = (value: Outline) => {
    const inner = text.strokeWidth > 0 ? text.strokeWidth : 6;
    const outer = (text.strokeWidth2 ?? 0) > 0 ? (text.strokeWidth2 as number) : 6;
    if (value === '0') set({ strokeWidth: 0, strokeWidth2: 0 });
    if (value === '1') set({ strokeWidth: inner, strokeWidth2: 0 });
    if (value === '2') set({ strokeWidth: inner, strokeWidth2: outer, strokeColor2: text.strokeColor2 ?? '#000000' });
  };

  return (
    <div className="page">
      <header className="topbar">
        <Brand />
        <SiteNav />
        <div className="topbar-actions">
          <LayoutToggle />
        </div>
      </header>

      <main className="page-body text-style-page">
        <Panel title={`スタイル（${styles.length}）`}>
          <button type="button" className={editing.id === null ? 'wide primary' : 'wide'} onClick={startNew}>
            ＋ 新しく作る
          </button>
          <Field label="見本から始める" hint="最初から入っているスタイルを土台にする">
            <select
              value=""
              onChange={(e) => {
                const preset = TEXT_PRESETS.find((p) => p.key === e.target.value);
                if (preset) set({ ...preset.text, content: 'テキストを入力', animation: 'none' });
              }}
            >
              <option value="">選ぶ…</option>
              {TEXT_PRESETS.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
          </Field>
          {styles.length === 0 ? (
            <p className="empty-hint">まだ保存したスタイルはありません。右で決めて「保存」を押すと、ここに並びます。</p>
          ) : (
            <ul className="text-style-list">
              {styles.map((t) =>
                t.kind === 'text' ? (
                  <li key={t.id}>
                    <button type="button" className={editing.id === t.id ? 'style-item active' : 'style-item'} onClick={() => open(t.id)}>
                      <span
                        className="style-swatch"
                        style={{
                          fontFamily: t.text.fontFamily,
                          fontWeight: t.text.weight,
                          color: t.text.color,
                          WebkitTextStroke: t.text.strokeWidth > 0 ? `${Math.min(3, t.text.strokeWidth / 3)}px ${t.text.strokeColor}` : undefined,
                        }}
                      >
                        あA
                      </span>
                      <span className="style-name">{t.name}</span>
                    </button>
                  </li>
                ) : null,
              )}
            </ul>
          )}
        </Panel>

        <section className="text-style-preview">
          <canvas ref={canvasRef} width={PREVIEW_W} height={PREVIEW_H} aria-label="見本" />
          <div className="text-style-preview-controls">
            <textarea value={sample} rows={2} onChange={(e) => setSample(e.target.value)} aria-label="見本の文字" />
            <Segmented value={backdrop} options={BACKGROUNDS.map((b) => ({ value: b.value, label: b.label }))} onChange={(v) => setBackdrop(v as Backdrop)} />
          </div>
        </section>

        <Panel title={editing.id ? 'スタイルを直す' : '新しいスタイル'}>
          <Field label="名前">
            <input type="text" value={editing.name} placeholder={`スタイル ${styles.length + 1}`} onChange={(e) => setEditing((s) => ({ ...s, name: e.target.value }))} />
          </Field>

          <Field label="フォント">
            <select value={text.fontFamily} onChange={(e) => set({ fontFamily: e.target.value })}>
              {fontOptions.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </Field>
          <details className="more-settings font-add">
            <summary>フォントを足す（ファイル・Google Fonts）</summary>
            <ButtonField label="フォントのファイル" hint=".ttf・.otf・.woff・.woff2。この端末に取っておきます">
              <input ref={fileRef} type="file" accept={FONT_FILE_ACCEPT} multiple hidden onChange={(e) => void addFile(e.target.files)} />
              <button type="button" className="wide" disabled={fontBusy} onClick={() => fileRef.current?.click()}>
                ファイルから足す
              </button>
            </ButtonField>
            <ButtonField label="Google Fonts の名前" hint="例: Dela Gothic One（fonts.google.com で探せます。使うときにネットが要ります）">
              <div className="font-google-row">
                <input type="text" value={googleName} placeholder="フォントの名前" aria-label="Google Fonts の名前" onChange={(e) => setGoogleName(e.target.value)} />
                <button type="button" disabled={fontBusy || !googleName.trim()} onClick={() => void addGoogle()}>
                  足す
                </button>
              </div>
            </ButtonField>
            {fontNote && <p className="muted small">{fontNote}</p>}
            {fonts.length > 0 && (
              <ul className="font-list">
                {fonts.map((f) => (
                  <li key={f.id}>
                    <span style={{ fontFamily: fontCss(f) }}>{f.label}</span>
                    <span className="muted small">{f.source === 'file' ? 'ファイル' : 'Google Fonts'}</span>
                    <button type="button" className="danger" onClick={() => void fontRegistry.remove(f.id)}>
                      消す
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </details>

          <ButtonField label="太さ" hint="フォントに無い太さは、近い太さで表示されます">
            <Segmented value={String(text.weight)} options={WEIGHTS} onChange={(v) => set({ weight: Number(v) })} />
          </ButtonField>
          <Field label="太さ（細かく）">
            <Slider value={text.weight} min={100} max={900} step={100} onChange={(weight) => set({ weight })} format={(v) => `${v}`} />
          </Field>
          <Field label="大きさ">
            <Slider value={text.fontSize} min={24} max={200} step={2} onChange={(fontSize) => set({ fontSize })} format={(v) => `${v}`} />
          </Field>
          <Field label="文字の色">
            <ColorInput value={text.color} onChange={(color) => set({ color })} />
          </Field>

          <ButtonField label="輪郭線" hint="2 重にすると、内側の線のさらに外へ、もう 1 本引きます">
            <Segmented
              value={outline}
              options={[
                { value: '0', label: 'なし' },
                { value: '1', label: '1 重' },
                { value: '2', label: '2 重' },
              ]}
              onChange={(v) => setOutline(v as Outline)}
            />
          </ButtonField>
          {outline !== '0' && (
            <div className="two-col">
              <Field label={outline === '2' ? '内側の線の色' : '線の色'}>
                <ColorInput value={text.strokeColor} onChange={(strokeColor) => set({ strokeColor })} />
              </Field>
              <Field label={outline === '2' ? '内側の線の太さ' : '線の太さ'}>
                <Slider value={text.strokeWidth} min={1} max={30} step={0.5} onChange={(strokeWidth) => set({ strokeWidth })} format={(v) => v.toFixed(1)} />
              </Field>
            </div>
          )}
          {outline === '2' && (
            <div className="two-col">
              <Field label="外側の線の色">
                <ColorInput value={text.strokeColor2 ?? '#000000'} onChange={(strokeColor2) => set({ strokeColor2 })} />
              </Field>
              <Field label="外側の線の太さ">
                <Slider value={text.strokeWidth2 ?? 0} min={1} max={30} step={0.5} onChange={(strokeWidth2) => set({ strokeWidth2 })} format={(v) => v.toFixed(1)} />
              </Field>
            </div>
          )}

          <details className="more-settings">
            <summary>影・字間・行間・帯</summary>
            <Field label="影">
              <Slider value={text.shadow} min={0} max={40} step={1} onChange={(shadow) => set({ shadow })} format={(v) => `${v}`} />
            </Field>
            <Field label="字間">
              <Slider value={text.letterSpacing} min={-10} max={40} step={1} onChange={(letterSpacing) => set({ letterSpacing })} format={(v) => `${v}`} />
            </Field>
            <Field label="行間">
              <Slider value={text.lineHeight} min={0.9} max={2} step={0.05} onChange={(lineHeight) => set({ lineHeight })} format={(v) => v.toFixed(2)} />
            </Field>
            <div className="two-col">
              <Field label="帯の色">
                <ColorInput value={text.bgColor} onChange={(bgColor) => set({ bgColor })} />
              </Field>
              <Field label="帯の濃さ">
                <Slider value={text.bgOpacity} min={0} max={1} step={0.05} onChange={(bgOpacity) => set({ bgOpacity })} format={(v) => `${Math.round(v * 100)}%`} />
              </Field>
            </div>
            <Toggle
              label="見出し・飾りとして使う（「字幕なし」で書き出しても残る）"
              checked={text.role === 'design'}
              onChange={(on) => set({ role: on ? 'design' : 'caption' })}
            />
          </details>

          <div className="text-style-actions">
            <button type="button" className="wide primary" onClick={() => save(false)}>
              {editing.id ? '上書きして保存' : '保存'}
            </button>
            {editing.id && (
              <button type="button" className="wide" onClick={() => save(true)}>
                別のスタイルとして保存
              </button>
            )}
            {selectedTexts.length > 0 && (
              <button type="button" className="wide" onClick={applyToSelection}>
                エディタで選んでいるテロップ（{selectedTexts.length}）に当てる
              </button>
            )}
            {editing.id && (
              <button
                type="button"
                className="wide ghost danger"
                onClick={() => {
                  if (editing.id) removeTemplate(editing.id);
                  startNew();
                }}
              >
                このスタイルを消す
              </button>
            )}
          </div>
          {note && <p className="muted small">{note}</p>}
        </Panel>
      </main>
    </div>
  );
}
