import { useEffect, useMemo, useRef, useState, type MutableRefObject, type SyntheticEvent } from 'react';
import { EMOJI_FOLDER, formatTime, mediaRegistry } from '../../engine/media';
import { player } from '../../engine/player';
import { defaultCrop } from '../../engine/renderer';
import { FONT_OPTIONS, LOOK_PRESETS, SPEED_PRESETS, TEXT_PRESETS } from '../../presets';
import { FPS_OPTIONS, nearestFpsOption, removeClips } from '../../model/ops';
import { uid } from '../../model/factory';
import { buildThreeBand } from '../../model/threeBand';
import { DEFAULT_EFFECT_TIMING, EFFECT_SHAPES, type EffectTiming } from '../../model/effects';
import {
  buildCaptionClips,
  cuesByPart,
  groupTranscribeTargets,
  mergeClipCues,
  parseTranscript,
  tidyCues,
  type ConcatPart,
} from '../../model/transcript';
import { WHISPER_MODELS, checkWhisper, toMono16k, transcribe, type WhisperDevice, type WhisperSupport } from '../../engine/transcribe';
import { decodeAssetAudioRange } from '../../engine/offline-export';
import { CARD_ICON_LABELS, CARD_ICON_NAMES } from '../../engine/cardIcons';
import { sortSpeakers } from '../../engine/speakerSort';
import {
  ASPECT_PRESETS,
  DEFAULT_BG_BLUR,
  EFFECT_META,
  DEFAULT_TEXT_FRAME,
  SPEAKERS,
  TEXT_ANIMATION_LABELS,
  TEXT_FIT_LABELS,
  TEXT_ROLE_LABELS,
  TRANSITION_META,
  emojiToken,
  previewText,
  type AspectKey,
  type Clip,
  type Effect,
  type EffectType,
  type TextAlign,
  type TextAnimation,
  type TextFit,
  type TextFrame,
  type TextProps,
  type TextRole,
  type TransitionType,
} from '../../model/types';
import { useApp } from '../../store/app';
import { useEditor } from '../../store/editor';
import { ColorInput, EmptyHint, Field, MuteIcon, Panel, Segmented, Slider, SoundIcon, Tabs, Toggle } from '../ui';
import { importFiles, useMediaAssets } from './MediaPanel';
import { Icon } from '../Icon';
import { AnalysisSection } from './AnalysisSection';
import { TRANSITION_ICON } from './transitionIcon';

type TabKey = 'props' | 'effects' | 'text' | 'emoji';

/** テロップのテキストエリアで最後にカーソルがあった位置（絵文字タブから挿入する先）。 */
type CursorRef = MutableRefObject<{ clipId: string; pos: number } | null>;

/**
 * インスペクタ。上は選んでいるものによって変わり、下の「字幕」は**常に出る**。
 *
 * 字幕の取り込みと文字起こしは、どれか 1 つのクリップに対する操作ではないので、
 * 最初はシーケンスの欄（＝何も選んでいないとき）に置いていた。
 * ところが素材を置いた直後はそのクリップが選ばれるので、**まず目に入らない**。
 * 常に同じ場所へ出し、選び直しても消えないようにしてある
 *（作りとしても、上と並びの位置に置いて、文字起こしの途中で作り直されないようにする）。
 */
export function Inspector() {
  return (
    <>
      <InspectorBody />
      <CaptionPanel />
    </>
  );
}

function InspectorBody() {
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
            {FPS_OPTIONS.map((value) => (
              <option key={value} value={value}>
                {value} fps
              </option>
            ))}
          </select>
        </Field>
        <Field label="背景色">
          <ColorInput value={sequence.background} onChange={(background) => apply((seq) => ({ ...seq, background }), 'bg')} />
        </Field>
      </div>
      <p className="muted">
        出力サイズ {sequence.width} × {sequence.height}
      </p>
      <SourceFpsHint />
      <EmptyHint>
        クリップを選ぶと、ここで音量・不透明度・スケール・エフェクトを調整できます。
        <br />
        プレビューはドラッグで移動、ホイールで拡大縮小です。
      </EmptyHint>
    </Panel>
  );
}


/**
 * 「字幕」の枠。ドックのパネルではなく、インスペクタの中にもう 1 枚置いている。
 * 見出しを押すと畳める。
 */
function CaptionPanel() {
  const [open, setOpen] = useState(true);
  return (
    <section className="panel">
      <header className="panel-head">
        <h2>字幕</h2>
        <div className="panel-head-tail">
          <button type="button" onClick={() => setOpen((v) => !v)}>
            {open ? '畳む' : '開く'}
          </button>
        </div>
      </header>
      {open && (
        <div className="panel-body">
          <TranscriptSection />
        </div>
      )}
    </section>
  );
}

/**
 * 書き起こし（SRT / VTT / Whisper の JSON）を読んで、テロップを一気に並べる。
 *
 * 文字起こしそのものはこの道具の外で作る前提。時刻付きの文さえあれば、
 * 置き場所を手で決めずに済む。長い行は読める文字数へ割り、短すぎる行は
 * 次の行にぶつからない範囲で伸ばす（`model/transcript.ts`）。
 */
function TranscriptSection() {
  const { apply } = useEditor();
  const [preset, setPreset] = useState('tv');
  const [maxChars, setMaxChars] = useState(24);
  const [offset, setOffset] = useState(0);
  const [extendShort, setExtendShort] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  /** 整えて置き、やったことをそのまま知らせる。取り込みでも文字起こしでも同じ道を通る。 */
  const place = (cues: Parameters<typeof tidyCues>[0], label: string, shift = 0, extra = '') => {
    const tidy = tidyCues(cues, { maxChars, offset: shift, extendShort });
    const style = TEXT_PRESETS.find((p) => p.key === preset)?.text;
    apply((seq) =>
      buildCaptionClips(seq, tidy.cues, SPEAKERS, {
        style,
        speakerColors: SPEAKER_DEFAULT_COLORS,
        trackName: `${label} ${new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`,
      }),
    );
    const parts = [`${tidy.cues.length} 行を置きました`];
    if (tidy.split > 0) parts.push(`長い行を割って ${tidy.split} 行ぶん増えました`);
    if (tidy.extended > 0) parts.push(`短い行を ${tidy.extended} 行伸ばしました`);
    if (tidy.stillShort > 0) parts.push(`${tidy.stillShort} 行は次の行が近く、読める長さに届いていません`);
    setNote(parts.join('。') + '。' + extra);
  };

  const load = async (file: File) => {
    const source = await file.text();
    const parsed = parseTranscript(source);
    if (parsed.length === 0) {
      setNote('読めませんでした。SRT・VTT・Whisper の JSON のどれかを選んでください。');
      return;
    }
    place(parsed, '字幕', offset);
  };

  return (
    <>
      <p className="muted small">書き起こしから字幕を置く</p>
      <div className="two-col">
        <Field label="体裁">
          <select value={preset} onChange={(e) => setPreset(e.target.value)}>
            {TEXT_PRESETS.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="1 枚の文字数" hint="超えたら割る">
          <Slider value={maxChars} min={8} max={60} step={1} onChange={setMaxChars} format={(v) => v.toFixed(0)} />
        </Field>
      </div>
      <Field label="先頭のずれ" hint="秒。素材の途中から起こしたとき">
        <Slider value={offset} min={-60} max={600} step={0.5} onChange={setOffset} format={(v) => v.toFixed(1)} />
      </Field>
      <Toggle
        label="短い行を読める長さまで伸ばす"
        checked={extendShort}
        onChange={setExtendShort}
      />
      <input
        ref={fileRef}
        type="file"
        accept=".srt,.vtt,.json,.txt,text/plain,application/json"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void load(file);
        }}
      />
      <button type="button" className="wide" onClick={() => fileRef.current?.click()}>
        書き起こしを選ぶ（SRT / VTT / JSON）
      </button>
      <WhisperSection
        place={(cues, extra) => place(cues, '文字起こし', 0, extra)}
        busy={busy}
        setBusy={setBusy}
        setNote={setNote}
        maxChars={maxChars}
      />
      {note && <p className="muted small">{note}</p>}
    </>
  );
}

/**
 * 音から直接、文字を起こす。
 *
 * 重い部分（transformers.js・onnxruntime・モデル）は同梱していないので、
 * 置いていない環境では理由だけ出して素通りさせる。iOS 版（file://）は必ずこちら。
 */
function WhisperSection({
  place,
  busy,
  setBusy,
  setNote,
  maxChars,
}: {
  place: (cues: Parameters<typeof tidyCues>[0], extra?: string) => void;
  busy: boolean;
  setBusy: (v: boolean) => void;
  setNote: (v: string) => void;
  maxChars: number;
}) {
  const { sequence, selection } = useEditor();
  const [support, setSupport] = useState<WhisperSupport | null>(null);
  const [modelId, setModelId] = useState<string>(WHISPER_MODELS[1].id);
  const [device, setDevice] = useState<WhisperDevice>('wasm');
  const [local, setLocal] = useState(false);
  // 探す道を増やすと取り違えが減る。手順書の仕上げも 5 で回している。
  const [careful, setCareful] = useState(false);
  const [sourceId, setSourceId] = useState<string>('');

  useEffect(() => {
    void checkWhisper().then((result) => {
      setSupport(result);
      // WebGPU があるなら、そちらのほうが桁違いに速い。
      if (result.webgpu) setDevice('webgpu');
    });
  }, []);

  const sources = sequence.clips.filter((c) => c.mediaId && (c.kind === 'video' || c.kind === 'audio'));
  const chosen = sources.find((c) => c.id === sourceId) ?? sources[0] ?? null;
  // 選んでいるクリップがあれば、そのすべてから起こす。何も選んでいないときだけ、下の「どの素材から」を使う。
  const selectedSources = sources.filter((c) => selection.includes(c.id));
  const targets = selectedSources.length > 0 ? selectedSources : chosen ? [chosen] : [];
  const mediaCount = new Set(targets.map((c) => c.mediaId)).size;

  if (!support) return null;
  if (!support.installed) {
    return (
      <p className="muted small">
        音からの文字起こしは、この開き方では使えません（{support.reason}）。
        書き起こしファイルの取り込みは使えます。
      </p>
    );
  }

  const run = async () => {
    if (targets.length === 0 || busy) return;
    setBusy(true);
    // どこで止まったかで、言うべきことが変わる。
    let stage = 'audio';
    try {
      // 素材ごとに、選んだクリップが使う範囲だけを取り出し、全部を 1 本につないで 1 回で起こす
      // （起こすたびにモデルを読み込み直すと遅いので）。つなぎ目には無音を挟み、行が混ざらないようにする。
      const groups = groupTranscribeTargets(
        targets.map((c) => ({
          id: c.id,
          mediaId: c.mediaId as string,
          start: c.start,
          duration: c.duration,
          sourceIn: c.sourceIn,
          speed: c.speed || 1,
        })),
      );
      const RATE = 16000;
      const GAP = 2;
      const pieces: Array<{ samples: Float32Array; part: ConcatPart }> = [];
      let cursor = 0;
      for (let i = 0; i < groups.length; i += 1) {
        const group = groups[i];
        const name = mediaRegistry.get(group.mediaId)?.name ?? group.mediaId;
        setNote(`音を取り出しています… ${i + 1} / ${groups.length}（${name}）`);
        const decoded = await decodeAssetAudioRange(group.mediaId, group.from, group.to);
        if (!decoded) {
          setNote(`「${name}」から音を取り出せませんでした。`);
          return;
        }
        const samples = await toMono16k(decoded.buffer);
        pieces.push({ samples, part: { offset: cursor, length: samples.length / RATE, from: decoded.start } });
        cursor += samples.length / RATE + GAP;
      }
      const audio = new Float32Array(Math.max(1, Math.ceil((cursor - GAP) * RATE)));
      for (const piece of pieces) audio.set(piece.samples, Math.round(piece.part.offset * RATE));

      const result = await transcribe(audio, {
        modelId,
        device,
        maxChars,
        beams: careful ? 5 : 1,
        localLibrary: support.localLibrary,
        localModels: local ? 'models/' : null,
        localWasm: local ? 'ort/' : null,
        onStage: (next) => {
          stage = next;
          setNote(
            next === 'library'
              ? '文字起こしの部品を読み込んでいます…'
              : next === 'model'
                ? 'モデルを読み込んでいます（初回は時間がかかります）…'
                : '書き起こしています…',
          );
        },
        onProgress: (percent, file) => setNote(`モデルを読み込んでいます… ${percent.toFixed(0)}% ${file}`),
      });
      if (result.cues.length === 0) {
        setNote('言葉が見つかりませんでした。声の入っている素材か確かめてください。');
        return;
      }
      // 何をどれだけ落としたかは出しておく。黙って捨てると、消えた言葉を探すことになる。
      const dropped = result.clean.boilerplate + result.clean.repeated + result.clean.garbled;
      const parts: string[] = [];
      if (result.clean.boilerplate) parts.push(`決まり文句 ${result.clean.boilerplate}`);
      if (result.clean.repeated) parts.push(`繰り返し ${result.clean.repeated}`);
      if (result.clean.garbled) parts.push(`壊れた出力 ${result.clean.garbled}`);
      const extra =
        `声のある所は全体の ${Math.round(result.kept * 100)}%。` +
        (dropped > 0 ? `幻とみて ${dropped} 行落としました（${parts.join(' / ')}）。` : '');
      // つないだ音の中の時刻 → 素材内の時刻 → 選んだ各クリップのタイムライン上の時刻。
      const placed = mergeClipCues(groups, cuesByPart(result.cues, pieces.map((p) => p.part)));
      if (placed.length === 0) {
        setNote('選んだクリップの範囲に、言葉は見つかりませんでした。');
        return;
      }
      const scope = targets.length > 1 ? `選んだ ${targets.length} 個のクリップ（素材 ${mediaCount} 本）から起こしました。` : '';
      place(placed, scope + extra);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 取りに行けなかったときは、どちらを取りに行って駄目だったのかまで言わないと直せない。
      const network = /fetch|NetworkError|network/i.test(message);
      const hint = !network
        ? ''
        : stage === 'library'
          ? '（文字起こしの部品を取りに行けませんでした。ネットにつながっていないなら、'
            + '`npm run whisper:pack` で手元へ写してください）'
          : '（モデルを取りに行けませんでした。ネットにつながっていないか、置き場所に届いていません。'
            + '「手元に置いたモデルだけを使う」にするか、つないでから試してください）';
      setNote(`文字起こしに失敗しました: ${message}${hint}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className="muted small">または、音から直接起こす</p>
      {selectedSources.length > 0 ? (
        <p className="muted small">
          選んでいる {selectedSources.length} 個のクリップ（素材 {mediaCount} 本）から、使っている範囲だけを起こします。
        </p>
      ) : null}
      <Field label={selectedSources.length > 0 ? 'どの素材から（クリップを選んでいないとき）' : 'どの素材から'}>
        <select value={chosen?.id ?? ''} onChange={(e) => setSourceId(e.target.value)} disabled={selectedSources.length > 0}>
          {sources.length === 0 && <option value="">（タイムラインに映像か音がありません）</option>}
          {sources.map((c) => (
            <option key={c.id} value={c.id}>
              {mediaRegistry.get(c.mediaId ?? '')?.name ?? c.mediaId} （{formatTime(c.start)} から）
            </option>
          ))}
        </select>
      </Field>
      <div className="two-col">
        <Field label="モデル">
          <select value={modelId} onChange={(e) => setModelId(e.target.value)}>
            {WHISPER_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="どこで回すか">
          <Segmented<WhisperDevice>
            value={device}
            options={[
              { value: 'webgpu', label: 'GPU' },
              { value: 'wasm', label: 'CPU' },
            ]}
            onChange={setDevice}
          />
        </Field>
      </div>
      {!support.webgpu && device === 'webgpu' && (
        <p className="muted small">このブラウザでは GPU が使えません。CPU にしてください。</p>
      )}
      <Toggle
        label="丁寧に起こす（遅くなります）"
        checked={careful}
        onChange={setCareful}
      />
      <Toggle label="手元に置いたモデルだけを使う（ネット無し）" checked={local} onChange={setLocal} />
      <button type="button" className="wide" disabled={busy || targets.length === 0} onClick={() => void run()}>
        {busy ? '起こしています…' : '音から文字を起こす'}
      </button>
    </>
  );
}

/**
 * タイムラインに置いた映像のフレームレートが、シーケンスの設定と食い違っているときだけ出す。
 * 60fps で撮った素材を 30fps のまま書き出すと、動きの滑らかさが半分になってしまうため。
 */
function SourceFpsHint() {
  const { sequence, apply } = useEditor();
  const assets = useMediaAssets();

  const sourceFps = useMemo(() => {
    const rates = new Set<number>();
    for (const clip of sequence.clips) {
      if (clip.kind !== 'video' || !clip.mediaId) continue;
      const fps = assets.find((a) => a.id === clip.mediaId)?.fps;
      if (fps) rates.add(nearestFpsOption(fps));
    }
    return [...rates].sort((a, b) => b - a);
  }, [sequence.clips, assets]);

  const best = sourceFps[0];
  if (!best || best === sequence.fps) return null;

  return (
    <p className="hint-note">
      素材は {sourceFps.join(' / ')} fps です。いまの設定（{sequence.fps} fps）で書き出すと、
      そのぶん動きが粗くなります。
      <button type="button" className="link" onClick={() => apply((seq) => ({ ...seq, fps: best }))}>
        {best} fps に合わせる
      </button>
    </p>
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
                {clip.muted ? <MuteIcon /> : <SoundIcon />}
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
          <ThreeBandSection clip={clip} />

          <hr />
          <CropSection clip={clip} />

          {clip.kind === 'video' && (
            <>
              <hr />
              <AnalysisSection clip={clip} />
            </>
          )}

          <hr />
          <TransitionControls clip={clip} />
        </>
      )}
    </>
  );
}

/**
 * 「上に見出し・中に本編・下に顔」の 3 分割へ組み直す入口。
 *
 * 横長の配信をそのまま縦に入れると絵が小さくなる。見せたい所を 2 か所取り出して
 * 縦に積むと、同じ画面で本編も表情も見える。帯の高さは黄金比で決める。
 *
 * 切り出す位置は素材によって違うので、ここでは中心から取るだけにして、
 * そのあと各クリップのクロップでつまんで合わせてもらう。
 */
function ThreeBandSection({ clip }: { clip: Clip }) {
  const { sequence, apply, setSelection } = useEditor();
  const asset = mediaRegistry.get(clip.mediaId);

  const build = (withTitle: boolean) => {
    const media = { width: asset?.width || sequence.width, height: asset?.height || sequence.height };
    const titleStyle = TEXT_PRESETS.find((preset) => preset.key === 'title')?.text;
    apply((seq) =>
      buildThreeBand(seq, clip, media, {
        titleStyle: withTitle ? titleStyle : undefined,
        titleText: withTitle ? '見出しを入れる' : undefined,
      }),
    );
    setSelection([]);
  };

  return (
    <>
      <Field label="画面構成" hint="このクリップを 3 本に置き換えます">
        <div className="chip-row wrap">
          <button type="button" className="chip" onClick={() => build(true)}>
            3分割に組む（見出しつき）
          </button>
          <button type="button" className="chip" onClick={() => build(false)}>
            3分割に組む
          </button>
        </div>
      </Field>
      <p className="muted small">
        上＝ぼかした背景と見出し、中＝本編、下＝顔のアップ。
        切り出す場所は中心から取るので、置いたあと各クリップのクロップで合わせてください。
      </p>
    </>
  );
}

/**
 * クロップの入口。
 * 数値をいじって当てるのは当てずっぽうになるので、まずプレビュー上でなぞって選ばせる。
 * 数値は「そのあと微調整したいとき」のものとして畳んでおく。
 */
function CropSection({ clip }: { clip: Clip }) {
  const { sequence, cropTarget, setCropTarget } = useEditor();
  const patch = useClipPatch(clip);
  const [showNumbers, setShowNumbers] = useState(false);
  const asset = mediaRegistry.get(clip.mediaId);
  const selecting = cropTarget === clip.id;

  const toggle = (enabled: boolean) => {
    if (!enabled) {
      setCropTarget(null);
      patch({ crop: { ...clip.crop, enabled: false } });
      return;
    }
    // 入れた瞬間は「全体を選んだ状態」＝見た目そのまま。そのまま範囲指定へ入る。
    const media = { width: asset?.width || sequence.width, height: asset?.height || sequence.height };
    patch({ crop: defaultCrop(sequence, clip, media) });
    setCropTarget(clip.id);
  };

  return (
    <>
      <Toggle label="クロップ（一部を切り抜いて使う）" checked={clip.crop.enabled} onChange={toggle} />
      {clip.crop.enabled && (
        <>
          <button
            type="button"
            className={selecting ? 'wide primary' : 'wide'}
            onClick={() => setCropTarget(selecting ? null : clip.id)}
          >
            {selecting ? '範囲を指定中（押して終了）' : 'プレビューで範囲を選ぶ'}
          </button>
          <p className="muted small">
            {selecting
              ? 'プレビューをなぞると、その範囲だけが残ります。大きさが決まったら、プレビュー下で「場所だけ」に切り替えると、大きさを変えずに切り抜く場所だけずらせます（矢印キーでも動きます）。'
              : '切り抜いた絵は、プレビュー上でドラッグして動かせます。四隅のつまみで大きさも変えられます（比率は保たれます）。'}
          </p>
          <button type="button" className="wide ghost" onClick={() => setShowNumbers((v) => !v)}>
            {showNumbers ? '数値で調整を閉じる' : '数値で微調整'}
          </button>
          {showNumbers && <CropControls clip={clip} />}
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
              <Icon name={TRANSITION_ICON[type]} size={16} /> {TRANSITION_META[type].label}
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
              <Icon name="plus" size={15} />{EFFECT_META[type].label}
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
                  <Icon name="xmark" size={14} />
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
              <EffectTimingRow
                effect={effect}
                duration={clip.duration}
                onChange={(timing) =>
                  patch(
                    { effects: clip.effects.map((e) => (e.id === effect.id ? { ...e, timing } : e)) },
                    `fxt:${effect.id}`,
                  )
                }
              />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * 1 つのエフェクトを「いつ効かせるか」。
 *
 * 掛けたら最後まで掛かりっぱなし、だと作れないものが多い。
 * 頭だけ寄る・決めの所で一瞬・ゆっくり入る、はどれも時間で変わる。
 * よく使う形は押すだけにして、細かい所はそのあと数字で動かす。
 */
function EffectTimingRow({
  effect,
  duration,
  onChange,
}: {
  effect: Effect;
  duration: number;
  onChange: (timing: EffectTiming | null) => void;
}) {
  const timing = effect.timing ?? null;
  const set = (patch: Partial<EffectTiming>) => onChange({ ...(timing ?? DEFAULT_EFFECT_TIMING), ...patch });
  const same = (a: EffectTiming, b: EffectTiming) =>
    a.start === b.start && a.duration === b.duration && a.attack === b.attack && a.release === b.release;

  return (
    <div className="effect-timing">
      <div className="chip-row wrap">
        <button
          type="button"
          className={timing === null ? 'chip active' : 'chip'}
          onClick={() => onChange(null)}
          title="時間で変えない（クリップ全体に一定で掛かる）"
        >
          ずっと
        </button>
        {EFFECT_SHAPES.filter((shape) => shape.key !== 'always').map((shape) => (
          <button
            key={shape.key}
            type="button"
            className={timing && same(timing, shape.timing) ? 'chip active' : 'chip'}
            onClick={() => onChange({ ...shape.timing })}
            title={shape.hint}
          >
            {shape.label}
          </button>
        ))}
      </div>
      {timing && (
        <div className="two-col">
          <Field label="いつから" hint="秒">
            <Slider
              value={timing.start}
              min={0}
              max={Math.max(0.5, duration)}
              step={0.05}
              onChange={(start) => set({ start })}
              format={(v) => v.toFixed(2)}
            />
          </Field>
          <Field label="どれだけ" hint="0 で最後まで">
            <Slider
              value={timing.duration}
              min={0}
              max={Math.max(0.5, duration)}
              step={0.05}
              onChange={(d) => set({ duration: d })}
              format={(v) => (v <= 0 ? '最後まで' : v.toFixed(2))}
            />
          </Field>
          <Field label="立ち上がり" hint="秒">
            <Slider
              value={timing.attack}
              min={0}
              max={2}
              step={0.02}
              onChange={(attack) => set({ attack })}
              format={(v) => v.toFixed(2)}
            />
          </Field>
          <Field label="抜け" hint="秒">
            <Slider
              value={timing.release}
              min={0}
              max={2}
              step={0.02}
              onChange={(release) => set({ release })}
              format={(v) => v.toFixed(2)}
            />
          </Field>
        </div>
      )}
    </div>
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
        <Field label="外フチ色">
          <ColorInput value={text.strokeColor2 ?? '#000000'} onChange={(strokeColor2) => set({ strokeColor2 }, 'strokeColor2')} />
        </Field>
        <Field label="外フチの太さ" hint="フチのさらに外側">
          <Slider
            value={text.strokeWidth2 ?? 0}
            min={0}
            max={20}
            step={0.5}
            onChange={(strokeWidth2) => set({ strokeWidth2 }, 'sw2')}
            format={(v) => v.toFixed(1)}
          />
        </Field>
        <Field label="影">
          <Slider value={text.shadow} min={0} max={40} step={1} onChange={(shadow) => set({ shadow }, 'shadow')} format={(v) => v.toFixed(0)} />
        </Field>
        <Field label="影を下へ" hint="縁と影の中心をずらす">
          <Slider
            value={text.shadowY ?? text.shadow * 0.25}
            min={0}
            max={24}
            step={1}
            onChange={(shadowY) => set({ shadowY }, 'shadowY')}
            format={(v) => v.toFixed(0)}
          />
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
      <Field label="幅の合わせ方" hint="縮める側は、改行した所でだけ行が変わる">
        <Segmented<TextFit>
          value={text.fit ?? 'wrap'}
          options={(Object.keys(TEXT_FIT_LABELS) as TextFit[]).map((fit) => ({ value: fit, label: TEXT_FIT_LABELS[fit] }))}
          onChange={(fit) => set({ fit })}
        />
      </Field>
      <Field label="種類" hint="字幕なしで書き出すと「字幕」だけが消える">
        <Segmented<TextRole>
          value={text.role ?? 'caption'}
          options={(Object.keys(TEXT_ROLE_LABELS) as TextRole[]).map((role) => ({ value: role, label: TEXT_ROLE_LABELS[role] }))}
          onChange={(role) => set({ role })}
        />
      </Field>

      <hr />
      <SpeakerSection text={text} set={set} />

      <hr />
      <CardFrameSection text={text} set={set} />

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
        {busy ? '読込中…' : <><Icon name="plus" />画像から絵文字を追加</>}
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
                {asset.thumbnail ? <img src={asset.thumbnail} alt={asset.name} /> : <span className="asset-icon"><Icon name="photo" size={18} /></span>}
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

/**
 * テロップの後ろに敷く台紙。
 *
 * 「視聴者のコメントを札にして見せる」ような、文字だけでは足りない見せ方のためのもの。
 * 見出しの帯と、その左右に置く印まで含めて 1 つの部品として扱う。
 */
function CardFrameSection({
  text,
  set,
}: {
  text: TextProps;
  set: (changes: Partial<TextProps>, key?: string) => void;
}) {
  const frame = text.frame ?? null;
  const patchFrame = (changes: Partial<TextFrame>, key?: string) =>
    set({ frame: { ...(frame ?? DEFAULT_TEXT_FRAME), ...changes } }, key);

  const iconOptions = (
    <>
      <option value="">なし</option>
      {CARD_ICON_NAMES.map((name) => (
        <option key={name} value={name}>
          {CARD_ICON_LABELS[name]}
        </option>
      ))}
    </>
  );

  return (
    <>
      <Toggle
        label="台紙を敷く（コメントカード）"
        checked={frame !== null}
        onChange={(on) => set({ frame: on ? { ...DEFAULT_TEXT_FRAME } : null })}
      />
      {frame && (
        <>
          <Field label="見出し" hint="空にすると帯を出さない">
            <input
              type="text"
              value={frame.heading}
              placeholder="コメント"
              onChange={(e) => patchFrame({ heading: e.target.value })}
            />
          </Field>
          <div className="two-col">
            <Field label="左の印">
              <select value={frame.iconLeft ?? ''} onChange={(e) => patchFrame({ iconLeft: e.target.value || null })}>
                {iconOptions}
              </select>
            </Field>
            <Field label="右の印">
              <select value={frame.iconRight ?? ''} onChange={(e) => patchFrame({ iconRight: e.target.value || null })}>
                {iconOptions}
              </select>
            </Field>
            <Field label="台紙の色">
              <ColorInput value={frame.background} onChange={(background) => patchFrame({ background }, 'cardBg')} />
            </Field>
            <Field label="枠の色">
              <ColorInput value={frame.borderColor} onChange={(borderColor) => patchFrame({ borderColor }, 'cardBorder')} />
            </Field>
            <Field label="帯の色">
              <ColorInput
                value={frame.headingBackground}
                onChange={(headingBackground) => patchFrame({ headingBackground }, 'cardBand')}
              />
            </Field>
            <Field label="見出しの色">
              <ColorInput value={frame.headingColor} onChange={(headingColor) => patchFrame({ headingColor }, 'cardHead')} />
            </Field>
            <Field label="枠の太さ">
              <Slider
                value={frame.borderWidth}
                min={0}
                max={24}
                step={1}
                onChange={(borderWidth) => patchFrame({ borderWidth }, 'cardBw')}
                format={(v) => v.toFixed(0)}
              />
            </Field>
            <Field label="角の丸み">
              <Slider
                value={frame.radius}
                min={0}
                max={80}
                step={1}
                onChange={(radius) => patchFrame({ radius }, 'cardRadius')}
                format={(v) => v.toFixed(0)}
              />
            </Field>
            <Field label="影">
              <Slider
                value={frame.shadow}
                min={0}
                max={60}
                step={1}
                onChange={(shadow) => patchFrame({ shadow }, 'cardShadow')}
                format={(v) => v.toFixed(0)}
              />
            </Field>
          </div>
          <p className="muted small">
            台紙の大きさは本文に合わせて決まります。幅は「折り返し幅」で調整してください。
          </p>
        </>
      )}
    </>
  );
}

/**
 * 話者ごとの色分け。
 *
 * 手順書と同じ組み立て。**人が「この行はこの人」と手本を 2 つ示し、
 * 残りを声の近さで振り分ける**。手本無しに 2 つへ割る手は、手順書自身が
 * 「両者が同じ側に寄る」と書いているので採らない。
 *
 * 迷った行（1 番目と 2 番目の差が小さい行）は数えて伝える。黙って片方へ倒すと、
 * どこを見直せばよいか分からなくなる。
 */
const SPEAKER_DEFAULT_COLORS: Record<string, string> = { '1': '#5cd6ff', '2': '#c084fc' };
/** これより差が小さい行は「迷った」として数える。 */
const UNSURE_MARGIN = 0.03;

function SpeakerSection({ text, set }: { text: TextProps; set: (changes: Partial<TextProps>, key?: string) => void }) {
  const { sequence, apply } = useEditor();
  const [colors, setColors] = useState(SPEAKER_DEFAULT_COLORS);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const captions = sequence.clips.filter((c) => c.kind === 'text' && (c.text?.role ?? 'caption') === 'caption');
  const anchorFor = (speaker: string) => captions.find((c) => c.text?.speaker === speaker) ?? null;
  const ready = SPEAKERS.every((s) => anchorFor(s) !== null);

  const run = async () => {
    setBusy(true);
    setNote(null);
    try {
      const anchors = SPEAKERS.map((speaker) => ({ clipId: anchorFor(speaker)!.id, speaker: String(speaker) }));
      const anchorIds = new Set(anchors.map((a) => a.clipId));
      const targets = captions.filter((c) => !anchorIds.has(c.id));
      const { results, anchorsUsed, missing } = await sortSpeakers(sequence, { anchors, targets });

      if (anchorsUsed.length < 2) {
        setNote(`手本の声を取り出せませんでした（話者 ${missing.join('・')}）。声の出ている行を手本にしてください。`);
        return;
      }

      const decided = new Map(results.filter((r) => r.decision).map((r) => [r.clipId, r.decision!]));
      apply((seq) => ({
        ...seq,
        clips: seq.clips.map((c) => {
          if (c.kind !== 'text' || !c.text) return c;
          // 手本そのものにも色を当てる（見比べられるように）。
          const own = anchors.find((a) => a.clipId === c.id);
          if (own) return { ...c, text: { ...c.text, color: colors[own.speaker] ?? c.text.color } };
          const decision = decided.get(c.id);
          if (!decision) return c;
          return { ...c, text: { ...c.text, speaker: decision.id, color: colors[decision.id] ?? c.text.color } };
        }),
      }));

      const unsure = [...decided.values()].filter((d) => d.margin < UNSURE_MARGIN).length;
      const skipped = results.length - decided.size;
      setNote(
        `${decided.size} 行を振り分けました。` +
          (unsure ? `うち ${unsure} 行は迷っています（見直してください）。` : '') +
          (skipped ? `${skipped} 行は声が見つからず、そのままにしました。` : ''),
      );
    } catch (e) {
      setNote(e instanceof Error ? e.message : '振り分けに失敗しました');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Field label="話者" hint="2 人ぶん印を付けると、残りを声で振り分けられます">
        <Segmented<string>
          value={text.speaker ?? ''}
          options={[{ value: '', label: 'なし' }, ...SPEAKERS.map((s) => ({ value: String(s), label: `話者${s}` }))]}
          onChange={(speaker) => set({ speaker: speaker || null })}
        />
      </Field>
      <div className="two-col">
        {SPEAKERS.map((speaker) => (
          <Field key={speaker} label={`話者${speaker} の色`} hint={anchorFor(speaker) ? '手本あり' : '手本なし'}>
            <ColorInput
              value={colors[speaker] ?? '#ffffff'}
              onChange={(value) => setColors((prev) => ({ ...prev, [speaker]: value }))}
            />
          </Field>
        ))}
      </div>
      <button type="button" className="wide" disabled={!ready || busy} onClick={() => void run()}>
        {busy ? '声を調べています…' : '残りを声で振り分けて色を付ける'}
      </button>
      {!ready && (
        <p className="muted small">
          まず「話者1」「話者2」の行をそれぞれ 1 つずつ選んで、上の「話者」で印を付けてください。
          その 2 行を手本にして、残りを振り分けます。
        </p>
      )}
      {note && <p className="muted small">{note}</p>}
      <p className="muted small">
        声の高さと音色で判断します。同じ人でもささやくと外れることがあるので、
        迷った行として数えたものは目で確かめてください。
      </p>
    </>
  );
}
