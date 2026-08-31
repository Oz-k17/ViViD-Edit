import { formatTime, mediaRegistry } from '../engine/media';
import { player } from '../engine/player';
import { ANIMATION_LABELS, FONT_OPTIONS, LOOKS, SPEED_PRESETS, TEXT_PRESETS } from '../presets';
import { useEditor, type ClipPatch, type TextPatch } from '../store/editor';
import {
  DEFAULT_FILTERS,
  DEFAULT_TRANSFORM,
  clipDuration,
  type FitMode,
  type MusicTrack,
  type TextAlign,
  type TextAnimation,
} from '../types';
import { ColorInput, EmptyHint, Field, Panel, Segmented, Slider } from './ui';

export function Inspector() {
  const { selection } = useEditor();
  switch (selection.type) {
    case 'clip':
      return <ClipInspector />;
    case 'text':
      return <TextInspector />;
    case 'music':
      return <MusicInspector />;
    default:
      return (
        <Panel title="プロパティ">
          <EmptyHint>
            タイムラインのクリップやテキストを選ぶと、ここで細かく調整できます。
            <br />
            プレビューはドラッグで位置調整、ホイールでズームです。
          </EmptyHint>
        </Panel>
      );
  }
}

function ClipInspector() {
  const { selectedClip: clip, dispatch, select } = useEditor();
  if (!clip) return null;
  const asset = mediaRegistry.get(clip.mediaId);
  const patch = (p: ClipPatch, key?: string) => dispatch({ type: 'clip/patch', id: clip.id, patch: p, key });

  return (
    <Panel
      title="クリップ"
      action={
        <div className="panel-actions">
          <button type="button" onClick={() => dispatch({ type: 'clip/duplicate', id: clip.id })}>
            複製
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => {
              dispatch({ type: 'clip/remove', id: clip.id });
              select({ type: 'none' });
            }}
          >
            削除
          </button>
        </div>
      }
    >
      <p className="asset-name">{asset?.name ?? '素材'}</p>
      <p className="muted">
        尺 {clipDuration(clip).toFixed(2)} 秒（素材 {formatTime(clip.in)} → {formatTime(clip.out)}）
      </p>

      {clip.kind === 'video' && (
        <>
          <Field label="速度">
            <div className="chip-row">
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
        </>
      )}

      {clip.kind === 'image' && (
        <Field label="表示時間" hint="秒">
          <Slider
            value={clip.out}
            min={0.3}
            max={20}
            step={0.1}
            onChange={(out) => patch({ out }, 'imageDur')}
            format={(v) => `${v.toFixed(1)}s`}
          />
        </Field>
      )}

      <Field label="画角への収め方">
        <Segmented<FitMode>
          value={clip.fit ?? 'cover'}
          options={[
            { value: 'cover', label: '全画面', title: '画面いっぱい。はみ出した部分はカットされます' },
            { value: 'blur', label: 'ぼかし背景', title: '全体を映し、余白を同じ映像のぼかしで埋めます' },
            { value: 'contain', label: '全体表示', title: '全体を映し、余白は背景色になります' },
          ]}
          onChange={(fit) => patch({ fit })}
        />
      </Field>

      <Field label="ズーム" hint="ホイールでも操作できます">
        <Slider
          value={clip.transform.scale}
          min={0.3}
          max={4}
          onChange={(scale) => patch({ transform: { scale } }, 'scale')}
          format={(v) => `${v.toFixed(2)}×`}
          onReset={() => patch({ transform: { scale: 1 } })}
        />
      </Field>
      <div className="two-col">
        <Field label="横位置">
          <Slider
            value={clip.transform.x}
            min={-1}
            max={1}
            onChange={(x) => patch({ transform: { x } }, 'tx')}
            format={(v) => v.toFixed(2)}
            onReset={() => patch({ transform: { x: 0 } })}
          />
        </Field>
        <Field label="縦位置">
          <Slider
            value={clip.transform.y}
            min={-1}
            max={1}
            onChange={(y) => patch({ transform: { y } }, 'ty')}
            format={(v) => v.toFixed(2)}
            onReset={() => patch({ transform: { y: 0 } })}
          />
        </Field>
      </div>
      <Field label="回転">
        <Slider
          value={clip.transform.rotate}
          min={-180}
          max={180}
          step={1}
          onChange={(rotate) => patch({ transform: { rotate } }, 'rot')}
          format={(v) => `${v.toFixed(0)}°`}
          onReset={() => patch({ transform: { rotate: 0 } })}
        />
      </Field>
      <button type="button" className="wide ghost" onClick={() => patch({ transform: { ...DEFAULT_TRANSFORM } })}>
        位置とズームをリセット
      </button>

      <hr />

      <Field label="フィルター">
        <div className="chip-row wrap">
          {LOOKS.map((look) => (
            <button key={look.key} type="button" className="chip" onClick={() => patch({ filters: { ...look.filters } })}>
              {look.label}
            </button>
          ))}
        </div>
      </Field>
      <div className="two-col">
        <Field label="明るさ">
          <Slider
            value={clip.filters.brightness}
            min={0.2}
            max={2}
            onChange={(brightness) => patch({ filters: { brightness } }, 'fb')}
            format={(v) => v.toFixed(2)}
            onReset={() => patch({ filters: { brightness: 1 } })}
          />
        </Field>
        <Field label="コントラスト">
          <Slider
            value={clip.filters.contrast}
            min={0.2}
            max={2}
            onChange={(contrast) => patch({ filters: { contrast } }, 'fc')}
            format={(v) => v.toFixed(2)}
            onReset={() => patch({ filters: { contrast: 1 } })}
          />
        </Field>
        <Field label="彩度">
          <Slider
            value={clip.filters.saturation}
            min={0}
            max={3}
            onChange={(saturation) => patch({ filters: { saturation } }, 'fs')}
            format={(v) => v.toFixed(2)}
            onReset={() => patch({ filters: { saturation: 1 } })}
          />
        </Field>
        <Field label="ぼかし">
          <Slider
            value={clip.filters.blur}
            min={0}
            max={20}
            step={0.2}
            onChange={(blur) => patch({ filters: { blur } }, 'fbl')}
            format={(v) => v.toFixed(1)}
            onReset={() => patch({ filters: { blur: 0 } })}
          />
        </Field>
      </div>
      <button type="button" className="wide ghost" onClick={() => patch({ filters: { ...DEFAULT_FILTERS } })}>
        フィルターをリセット
      </button>

      <hr />

      <div className="two-col">
        <Field label="フェードイン" hint="秒">
          <Slider
            value={clip.fadeIn}
            min={0}
            max={3}
            step={0.05}
            onChange={(fadeIn) => patch({ fadeIn }, 'fi')}
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
            onChange={(fadeOut) => patch({ fadeOut }, 'fo')}
            format={(v) => `${v.toFixed(2)}s`}
            onReset={() => patch({ fadeOut: 0 })}
          />
        </Field>
      </div>
    </Panel>
  );
}

function TextInspector() {
  const { selectedText: overlay, dispatch, select } = useEditor();
  if (!overlay) return null;
  const patch = (p: TextPatch, key?: string) => dispatch({ type: 'text/patch', id: overlay.id, patch: p, key });
  const style = overlay.style;

  return (
    <Panel
      title="テキスト"
      action={
        <div className="panel-actions">
          <button type="button" onClick={() => player.seek(overlay.start)}>
            頭出し
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => {
              dispatch({ type: 'text/remove', id: overlay.id });
              select({ type: 'none' });
            }}
          >
            削除
          </button>
        </div>
      }
    >
      <textarea
        className="text-input"
        rows={3}
        value={overlay.text}
        placeholder="ここに文字を入力"
        onChange={(e) => patch({ text: e.target.value }, 'text')}
      />

      <Field label="スタイル">
        <div className="chip-row wrap">
          {TEXT_PRESETS.map((preset) => (
            <button
              key={preset.key}
              type="button"
              className="chip"
              onClick={() => patch({ style: { ...preset.style }, animation: preset.animation })}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </Field>

      <Field label="フォント">
        <select value={style.fontFamily} onChange={(e) => patch({ style: { fontFamily: e.target.value } })}>
          {FONT_OPTIONS.map((font) => (
            <option key={font.value} value={font.value}>
              {font.label}
            </option>
          ))}
        </select>
      </Field>

      <div className="two-col">
        <Field label="サイズ">
          <Slider
            value={style.fontSize}
            min={20}
            max={220}
            step={1}
            onChange={(fontSize) => patch({ style: { fontSize } }, 'size')}
            format={(v) => `${v.toFixed(0)}`}
          />
        </Field>
        <Field label="太さ">
          <Slider
            value={style.weight}
            min={100}
            max={900}
            step={100}
            onChange={(weight) => patch({ style: { weight } }, 'weight')}
            format={(v) => `${v}`}
          />
        </Field>
      </div>

      <div className="two-col">
        <Field label="文字色">
          <ColorInput value={style.color} onChange={(color) => patch({ style: { color } }, 'color')} />
        </Field>
        <Field label="フチ色">
          <ColorInput value={style.strokeColor} onChange={(strokeColor) => patch({ style: { strokeColor } }, 'stroke')} />
        </Field>
      </div>

      <div className="two-col">
        <Field label="フチの太さ">
          <Slider
            value={style.strokeWidth}
            min={0}
            max={20}
            step={0.5}
            onChange={(strokeWidth) => patch({ style: { strokeWidth } }, 'sw')}
            format={(v) => v.toFixed(1)}
          />
        </Field>
        <Field label="影">
          <Slider
            value={style.shadow}
            min={0}
            max={40}
            step={1}
            onChange={(shadow) => patch({ style: { shadow } }, 'shadow')}
            format={(v) => v.toFixed(0)}
          />
        </Field>
      </div>

      <div className="two-col">
        <Field label="背景色">
          <ColorInput value={style.bgColor} onChange={(bgColor) => patch({ style: { bgColor } }, 'bg')} />
        </Field>
        <Field label="背景の濃さ">
          <Slider
            value={style.bgOpacity}
            min={0}
            max={1}
            onChange={(bgOpacity) => patch({ style: { bgOpacity } }, 'bgo')}
            format={(v) => `${Math.round(v * 100)}%`}
          />
        </Field>
      </div>

      <Field label="揃え">
        <Segmented<TextAlign>
          value={style.align}
          options={[
            { value: 'left', label: '左' },
            { value: 'center', label: '中央' },
            { value: 'right', label: '右' },
          ]}
          onChange={(align) => patch({ style: { align } })}
        />
      </Field>

      <Field label="アニメーション">
        <Segmented<TextAnimation>
          value={overlay.animation}
          options={(['none', 'fade', 'pop', 'slideUp', 'typewriter'] as TextAnimation[]).map((value) => ({
            value,
            label: ANIMATION_LABELS[value],
          }))}
          onChange={(animation) => patch({ animation })}
        />
      </Field>

      <div className="two-col">
        <Field label="開始" hint="秒">
          <Slider
            value={overlay.start}
            min={0}
            max={Math.max(10, player.duration)}
            step={0.05}
            onChange={(start) => patch({ start }, 'start')}
            format={(v) => `${v.toFixed(2)}s`}
          />
        </Field>
        <Field label="表示時間" hint="秒">
          <Slider
            value={overlay.duration}
            min={0.2}
            max={20}
            step={0.05}
            onChange={(duration) => patch({ duration }, 'dur')}
            format={(v) => `${v.toFixed(2)}s`}
          />
        </Field>
      </div>

      <div className="two-col">
        <Field label="折り返し幅">
          <Slider
            value={overlay.maxWidth}
            min={0.2}
            max={1}
            onChange={(maxWidth) => patch({ maxWidth }, 'mw')}
            format={(v) => `${Math.round(v * 100)}%`}
          />
        </Field>
        <Field label="傾き">
          <Slider
            value={overlay.rotate}
            min={-45}
            max={45}
            step={1}
            onChange={(rotate) => patch({ rotate }, 'trot')}
            format={(v) => `${v.toFixed(0)}°`}
            onReset={() => patch({ rotate: 0 })}
          />
        </Field>
      </div>

      <div className="chip-row">
        <button type="button" className="chip" onClick={() => patch({ x: 0.5, y: 0.18 })}>
          上に配置
        </button>
        <button type="button" className="chip" onClick={() => patch({ x: 0.5, y: 0.5 })}>
          中央
        </button>
        <button type="button" className="chip" onClick={() => patch({ x: 0.5, y: 0.78 })}>
          下（字幕位置）
        </button>
      </div>
    </Panel>
  );
}

function MusicInspector() {
  const { project, dispatch, select } = useEditor();
  const music = project.music;
  if (!music) return null;
  const asset = mediaRegistry.get(music.mediaId);
  const patch = (p: Partial<MusicTrack>, key?: string) => dispatch({ type: 'music/patch', patch: p, key });

  return (
    <Panel
      title="BGM"
      action={
        <button
          type="button"
          className="danger"
          onClick={() => {
            dispatch({ type: 'music/set', music: null });
            select({ type: 'none' });
          }}
        >
          外す
        </button>
      }
    >
      <p className="asset-name">{asset?.name ?? '音声'}</p>
      <p className="muted">
        使用区間 {formatTime(music.in)} → {formatTime(music.out)}
      </p>
      <Field label="音量">
        <Slider
          value={music.volume}
          min={0}
          max={1.5}
          onChange={(volume) => patch({ volume }, 'mvol')}
          format={(v) => `${Math.round(v * 100)}%`}
          onReset={() => patch({ volume: 0.5 })}
        />
      </Field>
      <div className="two-col">
        <Field label="フェードイン" hint="秒">
          <Slider
            value={music.fadeIn}
            min={0}
            max={5}
            step={0.1}
            onChange={(fadeIn) => patch({ fadeIn }, 'mfi')}
            format={(v) => `${v.toFixed(1)}s`}
          />
        </Field>
        <Field label="フェードアウト" hint="秒">
          <Slider
            value={music.fadeOut}
            min={0}
            max={5}
            step={0.1}
            onChange={(fadeOut) => patch({ fadeOut }, 'mfo')}
            format={(v) => `${v.toFixed(1)}s`}
          />
        </Field>
      </div>
      <label className="checkbox">
        <input type="checkbox" checked={music.loop} onChange={(e) => patch({ loop: e.target.checked })} />
        映像が終わるまで繰り返す
      </label>
    </Panel>
  );
}
