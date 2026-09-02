import { useRef, useState, type MutableRefObject, type SyntheticEvent } from 'react';
import { EMOJI_FOLDER, formatTime, mediaRegistry } from '../../engine/media';
import { player } from '../../engine/player';
import { FONT_OPTIONS, LOOK_PRESETS, SPEED_PRESETS, TEXT_PRESETS } from '../../presets';
import { removeClips } from '../../model/ops';
import { uid } from '../../model/factory';
import {
  ASPECT_PRESETS,
  DEFAULT_BG_BLUR,
  EFFECT_META,
  TEXT_ANIMATION_LABELS,
  TRANSITION_META,
  emojiToken,
  previewText,
  type AspectKey,
  type Clip,
  type Effect,
  type EffectType,
  type TextAlign,
  type TextAnimation,
  type TextProps,
  type TransitionType,
} from '../../model/types';
import { useApp } from '../../store/app';
import { useEditor } from '../../store/editor';
import { ColorInput, EmptyHint, Field, Panel, Segmented, Slider, Tabs, Toggle } from '../ui';
import { importFiles, useMediaAssets } from './MediaPanel';

type TabKey = 'props' | 'effects' | 'text' | 'emoji';

/** テロップのテキストエリアで最後にカーソルがあった位置（絵文字タブから挿入する先）。 */
type CursorRef = MutableRefObject<{ clipId: string; pos: number } | null>;

export function Inspector() {
  const { sequence, selection, apply } = useEditor();
  const [tab, setTab] = useState<TabKey>('props');
  const cursorRef: CursorRef = useRef(null);

  const clips = sequence.clips.filter((c) => selection.includes(c.id));

  if (clips.length === 0) return <SequenceInspector />;

  if (clips.length > 1) {
    return (
      <Panel title={`${clips.length} 個のクリップ`}>
        <EmptyHint>複数選択中です。まとめて移動・削除できます。</EmptyHint>
        <button type="button" className="wide" onClick={() => apply((seq) => removeClips(seq, selection, false))}>
          まとめて削除
        </button>
        <button type="button" className="wide ghost" onClick={() => apply((seq) => removeClips(seq, selection, true))}>
          まとめてリップル削除
        </button>
      </Panel>
    );
  }

  const clip = clips[0];
  const tabs: { value: TabKey; label: string }[] = [
    { value: 'props', label: 'プロパティ' },
    ...(clip.kind === 'text' ? [{ value: 'text' as TabKey, label: 'テキスト' }, { value: 'emoji' as TabKey, label: '絵文字' }] : []),
    ...(clip.kind !== 'audio' ? [{ value: 'effects' as TabKey, label: 'エフェクト' }] : []),
  ];
  const active = tabs.some((t) => t.value === tab) ? tab : 'props';

  return (
    <Panel
      title={clip.kind === 'text' ? 'テロップ' : clip.kind === 'audio' ? 'オーディオ' : 'クリップ'}
      action={
        <div className="panel-actions">
          <button type="button" onClick={() => player.seek(clip.start)}>
            頭出し
          </button>
          <button type="button" className="danger" onClick={() => apply((seq) => removeClips(seq, [clip.id], false))}>
            削除
          </button>
        </div>
      }
    >
      <Tabs value={active} options={tabs} onChange={setTab} />
      {active === 'props' && <PropsTab clip={clip} />}
      {active === 'effects' && <EffectsTab clip={clip} />}
      {active === 'text' && clip.text && <TextTab clip={clip} text={clip.text} cursorRef={cursorRef} />}
      {active === 'emoji' && clip.text && <EmojiTab clip={clip} text={clip.text} cursorRef={cursorRef} />}
    </Panel>
  );
}

function useClipPatch(clip: Clip) {
  const { apply } = useEditor();
  return (changes: Partial<Clip>, key?: string) =>
    apply(
      (seq) => ({ ...seq, clips: seq.clips.map((c) => (c.id === clip.id ? { ...c, ...changes } : c)) }),
      key ? `${key}:${clip.id}` : undefined,
    );
}

function SequenceInspector() {
  const { project, sequence, dispatch, apply } = useEditor();
  return (
    <Panel title="シーケンス">
      <Field label="タイトル">
        <input
          type="text"
          value={project.name}
          onChange={(e) => dispatch({ type: 'project', patch: { name: e.target.value }, key: 'name' })}
        />
      </Field>
      <Field label="画角">
        <div className="aspect-grid">
          {ASPECT_PRESETS.map((preset) => (
            <button
              key={preset.key}
              type="button"
              className={sequence.aspect === preset.key ? 'aspect active' : 'aspect'}
              onClick={() => dispatch({ type: 'aspect', aspect: preset.key as AspectKey })}
            >
              <span className="aspect-shape" style={{ aspectRatio: `${preset.width} / ${preset.height}` }} />
              <strong>{preset.label}</strong>
            </button>
          ))}
        </div>
      </Field>
      <div className="two-col">
        <Field label="フレームレート">
          <select value={sequence.fps} onChange={(e) => apply((seq) => ({ ...seq, fps: Number(e.target.value) }))}>
            <option value={24}>24 fps</option>
            <option value={30}>30 fps</option>
            <option value={60}>60 fps</option>
          </select>
        </Field>
        <Field label="背景色">
          <ColorInput value={sequence.background} onChange={(background) => apply((seq) => ({ ...seq, background }), 'bg')} />
        </Field>
      </div>
      <p className="muted">
        出力サイズ {sequence.width} × {sequence.height}
      </p>
      <EmptyHint>
        クリップを選ぶと、ここで音量・不透明度・スケール・エフェクトを調整できます。
        <br />
        プレビューはドラッグで移動、ホイールで拡大縮小です。
      </EmptyHint>
    </Panel>
  );
}

function PropsTab({ clip }: { clip: Clip }) {
  const patch = useClipPatch(clip);
  const asset = mediaRegistry.get(clip.mediaId);
  const visual = clip.kind === 'video' || clip.kind === 'image';

  return (
    <>
      <p className="asset-name">{clip.kind === 'text' ? (previewText(clip.text?.content ?? '').split('\n')[0] || 'テロップ') : (asset?.name ?? '素材')}</p>
      <p className="muted">
        {formatTime(clip.start)} → {formatTime(clip.start + clip.duration)}（{clip.duration.toFixed(2)} 秒）
      </p>

      {clip.kind !== 'text' && (
        <>
          <Field label="速度">
            <div className="chip-row wrap">
              {SPEED_PRESETS.map((speed) => (
                <button
                  key={speed}
                  type="button"
                  className={clip.speed === speed ? 'chip active' : 'chip'}
                  onClick={() => patch({ speed })}
                >
                  {speed}×
                </button>
              ))}
            </div>
          </Field>
          <Field label="音量">
            <div className="row">
              <Slider
                value={clip.volume}
                min={0}
                max={2}
                onChange={(volume) => patch({ volume }, 'volume')}
                format={(v) => `${Math.round(v * 100)}%`}
                onReset={() => patch({ volume: 1 })}
              />
              <button type="button" className={clip.muted ? 'toggle active' : 'toggle'} onClick={() => patch({ muted: !clip.muted })}>
                {clip.muted ? '🔇' : '🔊'}
              </button>
            </div>
          </Field>
          {clip.kind === 'audio' && (
            <Toggle label="素材を繰り返して尺を埋める" checked={clip.loop} onChange={(loop) => patch({ loop })} />
          )}
        </>
      )}

      <Field label="不透明度">
        <Slider
          value={clip.opacity}
          min={0}
          max={1}
          onChange={(opacity) => patch({ opacity }, 'opacity')}
          format={(v) => `${Math.round(v * 100)}%`}
          onReset={() => patch({ opacity: 1 })}
        />
      </Field>
      <Field label="スケール">
        <Slider
          value={clip.scale}
          min={0.1}
          max={4}
          onChange={(scale) => patch({ scale }, 'scale')}
          format={(v) => `${v.toFixed(2)}×`}
          onReset={() => patch({ scale: 1 })}
        />
      </Field>
      <div className="two-col">
        <Field label="横位置">
          <Slider
            value={clip.x}
            min={-1}
            max={1}
            onChange={(x) => patch({ x }, 'x')}
            format={(v) => v.toFixed(2)}
            onReset={() => patch({ x: 0 })}
          />
        </Field>
        <Field label="縦位置">
          <Slider
            value={clip.y}
            min={-1}
            max={1}
            onChange={(y) => patch({ y }, 'y')}
            format={(v) => v.toFixed(2)}
            onReset={() => patch({ y: 0 })}
          />
        </Field>
      </div>
      <Field label="回転">
        <Slider
          value={clip.rotate}
          min={-180}
          max={180}
          step={1}
          onChange={(rotate) => patch({ rotate }, 'rotate')}
          format={(v) => `${v.toFixed(0)}°`}
          onReset={() => patch({ rotate: 0 })}
        />
      </Field>

      <div className="two-col">
        <Field label="フェードイン" hint="秒">
          <Slider
            value={clip.fadeIn}
            min={0}
            max={3}
            step={0.05}
            onChange={(fadeIn) => patch({ fadeIn }, 'fadeIn')}
            format={(v) => `${v.toFixed(2)}s`}
            onReset={() => patch({ fadeIn: 0 })}
          />
        </Field>
        <Field label="フェードアウト" hint="秒">
          <Slider
            value={clip.fadeOut}
            min={0}
            max={3}
            step={0.05}
            onChange={(fadeOut) => patch({ fadeOut }, 'fadeOut')}
            format={(v) => `${v.toFixed(2)}s`}
            onReset={() => patch({ fadeOut: 0 })}
          />
        </Field>
      </div>

      {visual && (
        <>
          <hr />
          <Field label="画角への収め方">
            <Segmented<'cover' | 'contain'>
              value={clip.fit}
              options={[
                { value: 'cover', label: '全画面' },
                { value: 'contain', label: '全体表示' },
              ]}
              onChange={(fit) => patch({ fit })}
            />
          </Field>

          <Toggle
            label="背景ぼかしで余白を埋める"
            checked={clip.bgBlur.enabled}
            onChange={(enabled) => patch({ bgBlur: { ...clip.bgBlur, enabled } })}
          />
          {clip.bgBlur.enabled && (
            <div className="two-col">
              <Field label="ぼかし強さ">
                <Slider
                  value={clip.bgBlur.strength}
                  min={0.01}
                  max={0.15}
                  step={0.005}
                  onChange={(strength) => patch({ bgBlur: { ...clip.bgBlur, strength } }, 'blurStrength')}
                  format={(v) => `${Math.round(v * 100)}`}
                  onReset={() => patch({ bgBlur: { ...clip.bgBlur, strength: DEFAULT_BG_BLUR.strength } })}
                />
              </Field>
              <Field label="拡大率">
                <Slider
                  value={clip.bgBlur.zoom}
                  min={1}
                  max={2}
                  step={0.05}
                  onChange={(zoom) => patch({ bgBlur: { ...clip.bgBlur, zoom } }, 'blurZoom')}
                  format={(v) => `${v.toFixed(2)}×`}
                  onReset={() => patch({ bgBlur: { ...clip.bgBlur, zoom: DEFAULT_BG_BLUR.zoom } })}
                />
              </Field>
            </div>
          )}

          <hr />
          <Toggle
            label="クロップ & 配置（一部を切り抜いて置く）"
            checked={clip.crop.enabled}
            onChange={(enabled) => patch({ crop: { ...clip.crop, enabled } })}
          />
          {clip.crop.enabled && <CropControls clip={clip} />}

          <hr />
          <TransitionControls clip={clip} />
        </>
      )}
    </>
  );
}

function CropControls({ clip }: { clip: Clip }) {
  const patch = useClipPatch(clip);
  const set = (changes: Partial<Clip['crop']>, key: string) => patch({ crop: { ...clip.crop, ...changes } }, key);
  return (
    <>
      <p className="muted small">元映像から切り抜く範囲</p>
      <div className="two-col">
        <Field label="X">
          <Slider value={clip.crop.sx} min={0} max={0.95} onChange={(sx) => set({ sx }, 'sx')} format={(v) => v.toFixed(2)} />
        </Field>
        <Field label="Y">
          <Slider value={clip.crop.sy} min={0} max={0.95} onChange={(sy) => set({ sy }, 'sy')} format={(v) => v.toFixed(2)} />
        </Field>
        <Field label="幅">
          <Slider value={clip.crop.sw} min={0.05} max={1} onChange={(sw) => set({ sw }, 'sw')} format={(v) => v.toFixed(2)} />
        </Field>
        <Field label="高さ">
          <Slider value={clip.crop.sh} min={0.05} max={1} onChange={(sh) => set({ sh }, 'sh')} format={(v) => v.toFixed(2)} />
        </Field>
      </div>
      <p className="muted small">出力画面での配置（枠はプレビュー上でドラッグできます）</p>
      <div className="two-col">
        <Field label="X">
          <Slider value={clip.crop.dx} min={-0.5} max={1} onChange={(dx) => set({ dx }, 'dx')} format={(v) => v.toFixed(2)} />
        </Field>
        <Field label="Y">
          <Slider value={clip.crop.dy} min={-0.5} max={1} onChange={(dy) => set({ dy }, 'dy')} format={(v) => v.toFixed(2)} />
        </Field>
        <Field label="幅">
          <Slider value={clip.crop.dw} min={0.05} max={1.5} onChange={(dw) => set({ dw }, 'dw')} format={(v) => v.toFixed(2)} />
        </Field>
        <Field label="高さ">
          <Slider value={clip.crop.dh} min={0.05} max={1.5} onChange={(dh) => set({ dh }, 'dh')} format={(v) => v.toFixed(2)} />
        </Field>
      </div>
    </>
  );
}

export function TransitionControls({ clip }: { clip: Clip }) {
  const patch = useClipPatch(clip);
  return (
    <>
      <Field label="継ぎ目の切り替え" hint="直前のカットとの間">
        <div className="chip-row wrap">
          {(Object.keys(TRANSITION_META) as TransitionType[]).map((type) => (
            <button
              key={type}
              type="button"
              className={clip.transitionIn.type === type ? 'chip active' : 'chip'}
              onClick={() => patch({ transitionIn: { ...clip.transitionIn, type } })}
            >
              {TRANSITION_META[type].icon} {TRANSITION_META[type].label}
            </button>
          ))}
        </div>
      </Field>
      {clip.transitionIn.type !== 'none' && (
        <Field label="長さ" hint="秒">
          <Slider
            value={clip.transitionIn.duration}
            min={0.1}
            max={2}
            step={0.05}
            onChange={(duration) => patch({ transitionIn: { ...clip.transitionIn, duration } }, 'trDur')}
            format={(v) => `${v.toFixed(2)}s`}
          />
        </Field>
      )}
    </>
  );
}

function EffectsTab({ clip }: { clip: Clip }) {
  const patch = useClipPatch(clip);

  const add = (type: EffectType) => {
    const effect: Effect = { id: uid('fx'), type, intensity: EFFECT_META[type].def };
    patch({ effects: [...clip.effects, effect] });
  };

  return (
    <>
      <Field label="ルック">
        <div className="chip-row wrap">
          {LOOK_PRESETS.map((look) => (
            <button
              key={look.key}
              type="button"
              className="chip"
              onClick={() =>
                patch({
                  effects: look.effects.map((e) => ({ id: uid('fx'), type: e.type as EffectType, intensity: e.intensity })),
                })
              }
            >
              {look.label}
            </button>
          ))}
        </div>
      </Field>

      <Field label="エフェクトを追加">
        <div className="chip-row wrap">
          {(Object.keys(EFFECT_META) as EffectType[]).map((type) => (
            <button key={type} type="button" className="chip" onClick={() => add(type)}>
              ＋ {EFFECT_META[type].label}
            </button>
          ))}
        </div>
      </Field>

      {clip.effects.length === 0 ? (
        <EmptyHint>まだエフェクトはありません。上のボタンから追加します。</EmptyHint>
      ) : (
        <ul className="effect-list">
          {clip.effects.map((effect) => (
            <li key={effect.id}>
              <div className="effect-head">
                <strong>{EFFECT_META[effect.type].label}</strong>
                <button
                  type="button"
                  className="danger"
                  onClick={() => patch({ effects: clip.effects.filter((e) => e.id !== effect.id) })}
                >
                  ×
                </button>
              </div>
              <Slider
                value={effect.intensity}
                min={0}
                max={1}
                onChange={(intensity) =>
                  patch(
                    { effects: clip.effects.map((e) => (e.id === effect.id ? { ...e, intensity } : e)) },
                    `fx:${effect.id}`,
                  )
                }
                format={(v) => `${Math.round(v * 100)}%`}
              />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function TextTab({ clip, text, cursorRef }: { clip: Clip; text: TextProps; cursorRef: CursorRef }) {
  const patch = useClipPatch(clip);
  const { addTemplate } = useApp();
  const set = (changes: Partial<TextProps>, key?: string) => patch({ text: { ...text, ...changes } }, key);
  // 絵文字タブから挿入するとき、テキストエリアで最後に触れていた位置に入れられるよう覚えておく。
  const trackCursor = (e: SyntheticEvent<HTMLTextAreaElement>) => {
    cursorRef.current = { clipId: clip.id, pos: e.currentTarget.selectionStart };
  };

  return (
    <>
      <textarea
        className="text-input"
        rows={3}
        value={text.content}
        placeholder="ここに文字を入力"
        onChange={(e) => {
          set({ content: e.target.value }, 'content');
          cursorRef.current = { clipId: clip.id, pos: e.target.selectionStart };
        }}
        onSelect={trackCursor}
        onClick={trackCursor}
        onKeyUp={trackCursor}
      />

      <Field label="スタイル">
        <div className="chip-row wrap">
          {TEXT_PRESETS.map((preset) => (
            <button key={preset.key} type="button" className="chip" onClick={() => set({ ...preset.text, content: text.content })}>
              {preset.label}
            </button>
          ))}
        </div>
      </Field>

      <Field label="フォント">
        <select value={text.fontFamily} onChange={(e) => set({ fontFamily: e.target.value })}>
          {FONT_OPTIONS.map((font) => (
            <option key={font.value} value={font.value}>
              {font.label}
            </option>
          ))}
        </select>
      </Field>

      <div className="two-col">
        <Field label="サイズ">
          <Slider value={text.fontSize} min={20} max={220} step={1} onChange={(fontSize) => set({ fontSize }, 'size')} format={(v) => `${v.toFixed(0)}`} />
        </Field>
        <Field label="太さ">
          <Slider value={text.weight} min={100} max={900} step={100} onChange={(weight) => set({ weight }, 'weight')} format={(v) => `${v}`} />
        </Field>
        <Field label="文字色">
          <ColorInput value={text.color} onChange={(color) => set({ color }, 'color')} />
        </Field>
        <Field label="フチ色">
          <ColorInput value={text.strokeColor} onChange={(strokeColor) => set({ strokeColor }, 'strokeColor')} />
        </Field>
        <Field label="フチの太さ">
          <Slider value={text.strokeWidth} min={0} max={20} step={0.5} onChange={(strokeWidth) => set({ strokeWidth }, 'sw')} format={(v) => v.toFixed(1)} />
        </Field>
        <Field label="影">
          <Slider value={text.shadow} min={0} max={40} step={1} onChange={(shadow) => set({ shadow }, 'shadow')} format={(v) => v.toFixed(0)} />
        </Field>
        <Field label="背景色">
          <ColorInput value={text.bgColor} onChange={(bgColor) => set({ bgColor }, 'bgColor')} />
        </Field>
        <Field label="背景の濃さ">
          <Slider value={text.bgOpacity} min={0} max={1} onChange={(bgOpacity) => set({ bgOpacity }, 'bgo')} format={(v) => `${Math.round(v * 100)}%`} />
        </Field>
      </div>

      <Field label="揃え">
        <Segmented<TextAlign>
          value={text.align}
          options={[
            { value: 'left', label: '左' },
            { value: 'center', label: '中央' },
            { value: 'right', label: '右' },
          ]}
          onChange={(align) => set({ align })}
        />
      </Field>

      <Field label="入場アニメーション">
        <div className="chip-row wrap">
          {(Object.keys(TEXT_ANIMATION_LABELS) as TextAnimation[]).map((animation) => (
            <button
              key={animation}
              type="button"
              className={text.animation === animation ? 'chip active' : 'chip'}
              onClick={() => set({ animation })}
            >
              {TEXT_ANIMATION_LABELS[animation]}
            </button>
          ))}
        </div>
      </Field>
      <Field label="アニメーションの長さ" hint="秒">
        <Slider
          value={text.animationDuration}
          min={0.1}
          max={1.5}
          step={0.05}
          onChange={(animationDuration) => set({ animationDuration }, 'animDur')}
          format={(v) => `${v.toFixed(2)}s`}
        />
      </Field>
      <Field label="折り返し幅">
        <Slider value={text.maxWidth} min={0.2} max={1} onChange={(maxWidth) => set({ maxWidth }, 'mw')} format={(v) => `${Math.round(v * 100)}%`} />
      </Field>

      <div className="chip-row">
        <button type="button" className="chip" onClick={() => patch({ x: 0, y: -0.32 })}>
          上
        </button>
        <button type="button" className="chip" onClick={() => patch({ x: 0, y: 0 })}>
          中央
        </button>
        <button type="button" className="chip" onClick={() => patch({ x: 0, y: 0.28 })}>
          下（字幕位置）
        </button>
      </div>

      <button
        type="button"
        className="wide ghost"
        onClick={() => {
          const name = window.prompt('テンプレート名', previewText(text.content).split('\n')[0] || 'テロップ');
          if (name) addTemplate({ kind: 'text', name, text });
        }}
      >
        このスタイルをテンプレートに保存
      </button>
    </>
  );
}

function EmojiTab({ clip, text, cursorRef }: { clip: Clip; text: TextProps; cursorRef: CursorRef }) {
  const patch = useClipPatch(clip);
  const assets = useMediaAssets();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const emojis = assets.filter((a) => a.folder === EMOJI_FOLDER && a.kind === 'image');

  const handleFiles = async (files: FileList | File[]) => {
    setBusy(true);
    setError(null);
    const errors = await importFiles(files, EMOJI_FOLDER);
    setBusy(false);
    if (errors.length) setError(errors.join(' / '));
  };

  /** 最後にカーソルがあった位置（無ければ末尾）へ、普通の文字と同じように差し込む。 */
  const insert = (mediaId: string) => {
    const content = text.content;
    const remembered = cursorRef.current?.clipId === clip.id ? cursorRef.current.pos : content.length;
    const pos = Math.max(0, Math.min(content.length, remembered));
    const token = emojiToken(mediaId);
    patch({ text: { ...text, content: content.slice(0, pos) + token + content.slice(pos) } }, 'content');
    cursorRef.current = { clipId: clip.id, pos: pos + token.length };
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) void handleFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <button type="button" className="wide ghost" onClick={() => inputRef.current?.click()} disabled={busy}>
        {busy ? '読込中…' : '＋ 画像から絵文字を追加'}
      </button>
      {error && <p className="error-note">{error}</p>}

      {emojis.length === 0 ? (
        <EmptyHint>
          画像をアップロードすると、ここからテロップの文字列の中へ、普通の文字と同じように挿入できます。
        </EmptyHint>
      ) : (
        <ul className="emoji-grid">
          {emojis.map((asset) => (
            <li key={asset.id}>
              <button type="button" className="emoji-btn" title={asset.name} onClick={() => insert(asset.id)}>
                {asset.thumbnail ? <img src={asset.thumbnail} alt={asset.name} /> : <span className="asset-icon">▦</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="muted small">
        タップすると、テキストタブで最後にカーソルがあった位置に挿入されます。挿入後は普通の文字と同じく選択・削除・並べ替えができます。
      </p>
    </>
  );
}
