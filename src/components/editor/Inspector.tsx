import { useEffect, useMemo, useRef, useState, type MutableRefObject, type SyntheticEvent } from 'react';
import { EMOJI_FOLDER, formatTime, mediaRegistry } from '../../engine/media';
import { player } from '../../engine/player';
import { canvasFilterSupported, defaultCrop, unsupportedEffectTypes } from '../../engine/renderer';
import { LOOK_PRESETS, SPEED_PRESETS, TEXT_PRESETS, TEXT_PRESET_GROUPS } from '../../presets';
import { FPS_OPTIONS, nearestFpsOption, removeClips } from '../../model/ops';
import { uid } from '../../model/factory';
import { buildThreeBand, relayoutThreeBand } from '../../model/threeBand';
import { useThreeBandLayouts } from './threeBandLayouts';
import { useFontOptions } from '../fontOptions';
import { NestSceneSplit } from './NestSceneSplit';
import { NestHighlights } from './NestHighlights';
import { captureKit } from '../../model/kit';
import { goldenBands } from '../../model/layout';
import { cutRanges, removeRanges, removeRangesInNest, tempoOptions, type TimeRange } from '../../model/tempo';
import { renderAudioMix } from '../../engine/offline-export';
import { usedSourceRange } from '../../model/analysisEdits';
import { analyzeLoudness, type LoudnessTrack } from '../../analysis/audio/loudness';
import { planJetCut } from '../../analysis/audio/silence';
import { partnerOf, separateSound, unlinkClips } from '../../model/links';
import { canJoin, flattenNests, joinClips, nestClips, nestedLength, unnestClip } from '../../model/nest';
import { clipsOnTrack } from '../../model/ops';
import { DEFAULT_EFFECT_TIMING, EFFECT_SHAPES, SLOW_IN_TIMING, type EffectTiming } from '../../model/effects';
import {
  buildCaptionClips,
  cuesByPart,
  groupTranscribeTargets,
  mergeClipCues,
  tidyCues,
  type ConcatPart,
} from '../../model/transcript';
import { WHISPER_MODELS, checkWhisper, toMono16k, transcribe, type WhisperDevice, type WhisperSupport } from '../../engine/transcribe';
import { decodeAssetAudioRange, describeMediaSupport } from '../../engine/offline-export';
import { CARD_ICON_LABELS, CARD_ICON_NAMES } from '../../engine/cardIcons';
import { sortSpeakers } from '../../engine/speakerSort';
import {
  ASPECT_PRESETS,
  DEFAULT_BG_BLUR,
  EFFECT_HINTS,
  EFFECT_META,
  MOTION_EFFECTS,
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
  type Sequence,
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
import { MoreSettings, useEasy } from '../UiModeToggle';
import { useEditor } from '../../store/editor';
import { ButtonField, ColorInput, EmptyHint, Field, MuteIcon, Panel, Segmented, Slider, SoundIcon, Tabs, Toggle } from '../ui';
import { importFiles, useMediaAssets } from './MediaPanel';
import { Icon } from '../Icon';
import { AnalysisSection } from './AnalysisSection';
import { LearnedNote, useCaptionLearning } from './useCaptionLearning';
import { applyDictionary, mergeCounts } from '../../model/dictionary';
import { TRANSITION_ICON } from './transitionIcon';
import { TransitionHint, TransitionName } from './TransitionPicker';
import { Hint } from '../Hint';
import { EffectDemo, TextDemo, ThreeBandDemo, TimelineDemo } from '../demos';

type TabKey = 'props' | 'effects' | 'text' | 'emoji' | 'auto';

/** テロップのテキストエリアで最後にカーソルがあった位置（絵文字タブから挿入する先）。 */
type CursorRef = MutableRefObject<{ clipId: string; pos: number } | null>;

/**
 * インスペクタ。上は選んでいるものによって変わり、下の「字幕」は**常に出る**。
 *
 * 文字起こしは、どれか 1 つのクリップに対する操作ではないので、
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
  const { sequence, selection, setSelection, apply } = useEditor();
  const easy = useEasy();
  const [tab, setTab] = useState<TabKey>('props');
  const cursorRef: CursorRef = useRef(null);

  const clips = sequence.clips.filter((c) => selection.includes(c.id));

  if (clips.length === 0) return <SequenceInspector />;

  if (clips.length > 1) {
    return (
      <Panel title={`${clips.length} 個のクリップ`}>
        <EmptyHint>複数選択中です。まとめて移動・削除できます。</EmptyHint>
        <button
          type="button"
          className="wide"
          disabled={!clips.some((c) => c.kind === 'video' || c.kind === 'image')}
          onClick={() => {
            // apply に渡した処理は次の描画で走るので、まとめたクリップの id は先に決めて渡す。
            const id = uid('cl');
            apply((seq) => nestClips(seq, selection, 'まとめたクリップ', id).sequence);
            setSelection([id]);
          }}
          title="選んだクリップを 1 本のクリップにまとめます。ダブルクリックで中に入って編集できます"
        >
          <Icon name="layers" /> 1 つにまとめる
        </button>
        <button
          type="button"
          className="wide"
          disabled={!joinablePair(sequence, clips)}
          onClick={() => apply((seq) => joinClips(seq, selection))}
          title="分割したクリップを 1 本に戻します（同じ素材で、隣り合っていて、切れ目で時間が続いているもの）"
        >
          <Icon name="link" /> 繋ぐ（分割を戻す）
        </button>
        <button type="button" className="wide" onClick={() => apply((seq) => removeClips(seq, selection, easy))}>
          まとめて削除
        </button>
        {!easy && (
          <button type="button" className="wide ghost" onClick={() => apply((seq) => removeClips(seq, selection, true))}>
            まとめて詰めて削除（リップル削除）
          </button>
        )}
      </Panel>
    );
  }

  const clip = clips[0];
  if (clip.kind === 'nest') return <NestInspector clip={clip} tab={tab} setTab={setTab} />;
  const tabs: { value: TabKey; label: string }[] = [
    { value: 'props', label: 'プロパティ' },
    ...(clip.kind === 'text' ? [{ value: 'text' as TabKey, label: 'テキスト' }, { value: 'emoji' as TabKey, label: '絵文字' }] : []),
    ...(clip.kind !== 'audio' ? [{ value: 'effects' as TabKey, label: 'エフェクト' }] : []),
    ...(hasAutoTab(clip) ? [{ value: 'auto' as TabKey, label: '自動' }] : []),
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
          <button type="button" className="danger" onClick={() => apply((seq) => removeClips(seq, [clip.id], easy))}>
            削除
          </button>
        </div>
      }
    >
      <Tabs value={active} options={tabs} onChange={setTab} />
      {active === 'props' && <PropsTab clip={clip} />}
      {active === 'effects' && <EffectsTab clip={clip} />}
      {active === 'auto' && <AutoTab clip={clip} />}
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
  const easy = useEasy();
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
      {!easy && (
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
      )}
      <p className="muted">
        出力サイズ {sequence.width} × {sequence.height}
      </p>
      <SourceFpsHint />
      <EmptyHint>
        クリップを選ぶと、ここで音量・大きさ・エフェクトを調整できます。
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
 * 音から起こした字幕を、テロップとして一気に並べる。
 *
 * 長い行は読める文字数へ割り、短すぎる行は次の行にぶつからない範囲で伸ばす（`model/transcript.ts`）。
 * （以前は SRT / VTT / JSON のファイルを選んで取り込むこともできたが、使わないので外した。）
 */
function TranscriptSection() {
  const { apply } = useEditor();
  const { dictionary, recordHits } = useApp();
  const [preset, setPreset] = useState('tv');
  const [maxChars, setMaxChars] = useState(24);
  const [extendShort, setExtendShort] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** 整えて置き、やったことをそのまま知らせる。 */
  const place = (cues: Parameters<typeof tidyCues>[0], label: string, extra = '') => {
    const tidied = tidyCues(cues, { maxChars, extendShort });
    // わたし辞書の直しを当ててから置く（いつも同じように間違える名前や用語を、毎回直さなくてよいように）。
    const counts = new Map<string, number>();
    const tidy = {
      ...tidied,
      cues: tidied.cues.map((cue) => {
        const fixed = applyDictionary(cue.text, dictionary);
        mergeCounts(counts, fixed.counts);
        return fixed.text === cue.text ? cue : { ...cue, text: fixed.text };
      }),
    };
    recordHits(counts);
    const fixedCount = [...counts.values()].reduce((a, b) => a + b, 0);
    const style = TEXT_PRESETS.find((p) => p.key === preset)?.text;
    apply((seq) =>
      buildCaptionClips(seq, tidy.cues, SPEAKERS, {
        style,
        speakerColors: SPEAKER_DEFAULT_COLORS,
        trackName: `${label} ${new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`,
      }),
    );
    const parts = [`${tidy.cues.length} 行を置きました`];
    if (fixedCount > 0) parts.push(`わたし辞書で ${fixedCount} か所直しました`);
    if (tidy.split > 0) parts.push(`長い行を割って ${tidy.split} 行ぶん増えました`);
    if (tidy.extended > 0) parts.push(`短い行を ${tidy.extended} 行伸ばしました`);
    if (tidy.stillShort > 0) parts.push(`${tidy.stillShort} 行は次の行が近く、読める長さに届いていません`);
    setNote(parts.join('。') + '。' + extra);
  };

  return (
    <>
      <WhisperSection
        place={(cues, extra) => place(cues, '文字起こし', extra)}
        busy={busy}
        setBusy={setBusy}
        setNote={setNote}
        maxChars={maxChars}
      />
      {note && <p className="muted small">{note}</p>}
      <MoreSettings summary="くわしい設定（字幕の見た目・1 枚の文字数）">
      <div className="two-col">
        <Field label="体裁">
          <select value={preset} onChange={(e) => setPreset(e.target.value)}>
            {TEXT_PRESET_GROUPS.map((group) => (
              <optgroup key={group.key} label={group.label}>
                {TEXT_PRESETS.filter((p) => p.group === group.key).map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </Field>
        <Field label="1 枚の文字数" hint="超えたら割る">
          <Slider value={maxChars} min={8} max={60} step={1} onChange={setMaxChars} format={(v) => v.toFixed(0)} />
        </Field>
      </div>
      <Toggle
        label="短い行を読める長さまで伸ばす"
        checked={extendShort}
        onChange={setExtendShort}
      />
      </MoreSettings>
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
  const easy = useEasy();
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
        音からの文字起こしは、アプリ版では使えません（{support.reason}）。NAS（Docker 版）から開くと使えます。
      </p>
    );
  }

  const run = async () => {
    if (targets.length === 0 || busy) return;
    setBusy(true);
    // どこで止まったかで、言うべきことが変わる。
    let stage = 'audio';
    let initTimer: number | null = null;
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
          setNote(`「${name}」から音を取り出せませんでした。（${await describeMediaSupport(group.mediaId)}）`);
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
          if (initTimer !== null && next !== 'model') {
            window.clearInterval(initTimer);
            initTimer = null;
          }
          setNote(
            next === 'library'
              ? '文字起こしの部品を読み込んでいます…'
              : next === 'model'
                ? 'モデルを読み込んでいます（初回は時間がかかります）…'
                : '書き起こしています…',
          );
        },
        onProgress: (percent, file) => {
          if (percent < 100) {
            setNote(`モデルを読み込んでいます… ${percent.toFixed(0)}% ${file}`);
            return;
          }
          // 100% は「ファイルを受け取り終えた」だけ。このあと、モデルを計算機の中へ組み立てる時間がかかる
          // （CPU では 1〜数分、画面に動きが出ない）。止まって見えるので、経過を出して動いていることを示す。
          if (initTimer === null) {
            const since = Date.now();
            const tick = () =>
              setNote(
                `モデルを受け取りました。計算の準備をしています… ${Math.round((Date.now() - since) / 1000)} 秒`
                  + '（CPU では 1〜数分かかることがあります。動いています）',
              );
            tick();
            initTimer = window.setInterval(tick, 1000);
          }
        },
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
      if (initTimer !== null) window.clearInterval(initTimer);
      setBusy(false);
    }
  };

  return (
    <>
      <p className="muted small">{easy ? '音声から字幕を自動で作る' : 'または、音から直接起こす'}</p>
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
      <MoreSettings summary="くわしい設定（精度・処理する場所・ネットなしで使う）">
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
      </MoreSettings>
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

/** 間を詰める・場面で分けるなどの自動の機能があるクリップか（説明が長いので、別のタブにまとめる）。 */
function hasAutoTab(clip: Clip): boolean {
  if (clip.kind === 'video') return true;
  return clip.kind === 'audio' && !!clip.mediaId && mediaRegistry.get(clip.mediaId)?.hasAudio !== false;
}

/** 「自動」タブ: 間を詰める（テンポ）・場面で分ける・顔の位置・表紙など、押すと自動で直す機能。 */
function AutoTab({ clip }: { clip: Clip }) {
  const asset = mediaRegistry.get(clip.mediaId);
  const tempo = (clip.kind === 'video' || clip.kind === 'audio') && !!clip.mediaId && asset?.hasAudio !== false;
  return (
    <>
      {tempo && <TempoSection key={clip.id} clip={clip} />}
      {clip.kind === 'video' && (
        <>
          {tempo && <hr />}
          <AnalysisSection clip={clip} />
        </>
      )}
    </>
  );
}

function PropsTab({ clip }: { clip: Clip }) {
  const patch = useClipPatch(clip);
  const easy = useEasy();
  const { sequence, apply } = useEditor();
  const asset = mediaRegistry.get(clip.mediaId);
  const visual = clip.kind === 'video' || clip.kind === 'image';
  // 映像と音を分けた動画は、映像の側は鳴らない。音量・ミュートは音の側を直す。
  const partner = partnerOf(sequence, clip);
  const soundClip = clip.kind === 'video' && partner ? partner : clip;
  const soundPatch = useClipPatch(soundClip);

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
                value={soundClip.volume}
                min={0}
                max={2}
                onChange={(volume) => soundPatch({ volume }, 'volume')}
                format={(v) => `${Math.round(v * 100)}%`}
                onReset={() => soundPatch({ volume: 1 })}
              />
              <button
                type="button"
                className={soundClip.muted ? 'toggle active' : 'toggle'}
                onClick={() => soundPatch({ muted: !soundClip.muted })}
              >
                {soundClip.muted ? <MuteIcon /> : <SoundIcon />}
              </button>
            </div>
          </Field>
          {clip.kind === 'audio' && !clip.linkId && (
            <Toggle label="素材を繰り返して尺を埋める" checked={clip.loop} onChange={(loop) => patch({ loop })} />
          )}
          {clip.linkId && partner ? (
            <div className="link-row">
              <span className="muted small">
                <Icon name="link" size={14} /> {clip.kind === 'video' ? '音（音声レーン）' : '映像（映像レーン）'}とつないであります。移動・長さ・分割・削除が一緒に動きます。
              </span>
              <button type="button" className="ghost" onClick={() => apply((seq) => unlinkClips(seq, [clip.id]))}>
                つなぎを外す
              </button>
            </div>
          ) : (
            // 自分で音を鳴らしている動画だけ（つなぎを外したあとの映像は、音を音声レーンの側が鳴らしている）。
            clip.kind === 'video' &&
            clip.mediaId &&
            !clip.muted &&
            asset?.hasAudio !== false && (
              <button type="button" className="wide ghost" onClick={() => apply((seq) => separateSound(seq, clip.id))}>
                音を音声レーンに分ける
              </button>
            )
          )}
        </>
      )}

      <Field label="大きさ">
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
        <Field label="左右の位置">
          <Slider
            value={clip.x}
            min={-1}
            max={1}
            onChange={(x) => patch({ x }, 'x')}
            format={(v) => v.toFixed(2)}
            onReset={() => patch({ x: 0 })}
          />
        </Field>
        <Field label="上下の位置">
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

      {easy ? (
        <details className="more-settings">
          <summary>くわしい設定（透明度・回転・切り抜きなど）</summary>
      <Field label="濃さ（下げると透ける）">
        <Slider
          value={clip.opacity}
          min={0}
          max={1}
          onChange={(opacity) => patch({ opacity }, 'opacity')}
          format={(v) => `${Math.round(v * 100)}%`}
          onReset={() => patch({ opacity: 1 })}
        />
      </Field>
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

          <hr />
          <TransitionControls clip={clip} />
        </>
      )}
        </details>
      ) : (
        <>
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

          <hr />
          <TransitionControls clip={clip} />
        </>
      )}
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
  // 組んだ 3 本（と見出し・音）を、1 本のクリップにまとめておくか。ダブルクリックで中を直せる。
  const [nest, setNest] = useState(true);
  const layouts = useThreeBandLayouts();
  const [layoutValue, setLayoutValue] = useState(layouts.defaultValue);
  const layout = layouts.resolve(layoutValue);
  // いまの画面（まとめの中に入っているときは、その中身）が 3 分割なら、型にできる・レイアウトを変えられる。
  const capturable = useMemo(() => captureKit(sequence, sequence.clips), [sequence]);
  // 選んだクリップが、その 3 分割の帯の 1 本か（違う録画を選んでいるなら、組めるようにしておく）。
  const isBand = useMemo(() => {
    const bands = goldenBands(sequence.height);
    return (
      clip.crop.enabled &&
      Math.abs(clip.crop.dw - 1) < 0.002 &&
      [bands.top, bands.middle, bands.bottom].some((b) => Math.abs(clip.crop.dy - b.dy) < 0.002 && Math.abs(clip.crop.dh - b.dh) < 0.002)
    );
  }, [clip, sequence.height]);

  const build = (withTitle: boolean) => {
    const media = { width: asset?.width || sequence.width, height: asset?.height || sequence.height };
    const presetTitle = TEXT_PRESETS.find((preset) => preset.key === 'title')?.text;
    const titleStyle = layout.title ? { ...layout.title, content: '見出しを入れる' } : presetTitle;
    layouts.remember(layoutValue);
    // apply に渡した処理は次の描画で走るので、まとめたクリップの id は先に決めて渡す。
    const nestId = uid('cl');
    apply((seq) => {
      const built = buildThreeBand(seq, clip, media, {
        titleStyle: withTitle ? titleStyle : undefined,
        titleText: withTitle ? '見出しを入れる' : undefined,
        sources: layout.sources,
      });
      if (!nest) return built;
      const before = new Set(seq.clips.map((c) => c.id));
      const created = built.clips.filter((c) => !before.has(c.id)).map((c) => c.id);
      // 本編の帯に音をつないであれば、音も一緒に入る（nestClips が相手を足す）。
      return nestClips(built, created, '3分割', nestId).sequence;
    });
    setSelection(nest ? [nestId] : []);
  };

  return (
    <>
      {capturable && isBand ? (
        // もう 3 分割になっている（まとめずに組んだ・まとめの中に入っている）なら、組み直さずにレイアウトだけ変える。
        <RelayoutField mode="here" />
      ) : (
        <>
          <ButtonField label="縦 3 段に組む（3分割）" hint="横長の録画を、縦長の形にします">
            <div className="chip-row wrap">
              <Hint
                title="見出しつきで 3 段に組む"
                alias="3分割"
                desc="このクリップを、上＝見出し、中＝本編、下＝顔のアップ の 3 段に置き換えます。見出しの文字は、あとで書き換えます。"
                demo={() => <ThreeBandDemo title />}
              >
                <button type="button" className="chip" onClick={() => build(true)}>
                  見出しつきで組む
                </button>
              </Hint>
              <Hint
                title="見出しなしで 3 段に組む"
                alias="3分割"
                desc="上＝ぼかした背景、中＝本編、下＝顔のアップ の 3 段に置き換えます。見出しの文字は入れません。"
                demo={() => <ThreeBandDemo title={false} />}
              >
                <button type="button" className="chip" onClick={() => build(false)}>
                  見出しなしで組む
                </button>
              </Hint>
            </div>
          </ButtonField>
          <Field label="顔の位置（レイアウト）" hint="録画の中で顔が映っている所">
            <select value={layoutValue} onChange={(e) => setLayoutValue(e.target.value)}>
              {layouts.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
          <Toggle label="組んだあと 1 つにまとめる（ダブルクリックで中を編集）" checked={nest} onChange={setNest} />
          <p className="muted small">
            上＝ぼかした背景と見出し、中＝本編、下＝顔のアップ。
            {layoutValue === 'center'
              ? '切り出す場所は中心から取るので、置いたあと各クリップのクロップで合わせてください。合わせ終えたら「自分の型にする」で、次からはそのまま組めます。'
              : `「${layout.label}」の位置で切り抜きます。組んだあとでも、まとめたクリップの「レイアウトを変える」で変えられます。`}
          </p>
        </>
      )}
      {capturable && <SaveKitButton kit={capturable} />}
    </>
  );
}

/**
 * 組んである 3 分割のレイアウトを変える。帯の切り抜き位置（と自分の型なら見出しの体裁）だけを付け替え、時間や音は変えない。
 * `nest` を渡せばそのまとめたクリップの中身に、`here` ならいま見ているシーケンスに当てる。
 */
function RelayoutField({ mode, nestId }: { mode: 'here' | 'nest'; nestId?: string }) {
  const { apply } = useEditor();
  const layouts = useThreeBandLayouts();
  const [note, setNote] = useState<string | null>(null);
  const mediaOf = (c: Clip) => {
    const a = mediaRegistry.get(c.mediaId);
    return a && a.width > 0 && a.height > 0 ? { width: a.width, height: a.height } : null;
  };
  const change = (value: string) => {
    if (!value) return;
    const layout = layouts.resolve(value);
    layouts.remember(value);
    apply((seq) => {
      if (mode === 'here') return relayoutThreeBand(seq, layout.sources, mediaOf, layout.title).sequence;
      return {
        ...seq,
        clips: seq.clips.map((c) =>
          c.id === nestId && c.nested ? { ...c, nested: relayoutThreeBand(c.nested, layout.sources, mediaOf, layout.title).sequence } : c,
        ),
      };
    });
    setNote(`「${layout.label}」に変えました（「戻す」で戻せます）。`);
  };
  return (
    <>
      <Field label="レイアウトを変える" hint="顔（カメラ）の位置が違う録画のとき">
        <select value="" onChange={(e) => change(e.target.value)}>
          <option value="">選ぶ…</option>
          {layouts.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>
      {note && <p className="muted small">{note}</p>}
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
          <Toggle
            label="置き場所を固定して、切り抜く範囲だけ選ぶ"
            checked={!!clip.crop.keepDest}
            onChange={(keepDest) => patch({ crop: { ...clip.crop, keepDest } })}
          />
          <p className="muted small">
            3 分割の帯のように、置き場所が決まっているときに使います。範囲を選ぶとき、元の絵の全体が画面に収まって見えます。
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
      <Field label="場面の切り替え" hint="直前のクリップとの継ぎ目">
        <div className="chip-row wrap">
          {(Object.keys(TRANSITION_META) as TransitionType[]).map((type) => (
            <TransitionHint key={type} type={type}>
              <button
                type="button"
                className={clip.transitionIn.type === type ? 'chip active' : 'chip'}
                onClick={() => patch({ transitionIn: { ...clip.transitionIn, type } })}
              >
                <Icon name={TRANSITION_ICON[type]} size={16} /> <TransitionName type={type} />
              </button>
            </TransitionHint>
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

/**
 * 動きのエフェクトの、押すだけで足せる形。
 * 同じ「寄る」でも、いつ効かせるかで使いどころが変わるので、よく使う 3 つを分けて置く。
 */
const MOTION_PRESETS: {
  key: string;
  label: string;
  hint: string;
  type: EffectType;
  intensity: number;
  timing: EffectTiming | null;
  demo: 'zoom-slow' | 'zoom-punch' | 'zoom-hold' | 'shake' | 'shake-once' | 'vignette';
}[] = [
  { key: 'zoom-slow', label: 'じわっと寄る', hint: 'クリップの頭から終わりまでかけて、ゆっくり寄っていきます。話に引き込みたい所に。', type: 'zoom', intensity: 0.3, timing: SLOW_IN_TIMING, demo: 'zoom-slow' },
  { key: 'zoom-punch', label: '一瞬寄る', hint: 'クリップの頭で、ぐっと寄ってすぐ戻ります。カットの切り替わりや決めの一言に。', type: 'zoom', intensity: 0.3, timing: { start: 0, duration: 0.3, attack: 0.05, release: 0.22 }, demo: 'zoom-punch' },
  { key: 'zoom-hold', label: '寄ったまま（ズーム）', hint: 'クリップのあいだ、ずっと大きく映します。強さで寄り具合を決めます。', type: 'zoom', intensity: 0.35, timing: null, demo: 'zoom-hold' },
  { key: 'shake-once', label: '一瞬揺らす', hint: 'クリップの頭で、短く揺らします。驚き・ツッコミ・衝撃に。', type: 'shake', intensity: 0.6, timing: { start: 0, duration: 0.4, attack: 0, release: 0.3 }, demo: 'shake-once' },
  { key: 'shake', label: '揺らし続ける', hint: 'クリップのあいだ、ずっと細かく揺らします。', type: 'shake', intensity: 0.3, timing: null, demo: 'shake' },
  { key: 'vignette', label: '周りを暗く', hint: '絵の周りを暗くして、真ん中に目を集めます。', type: 'vignette', intensity: 0.6, timing: null, demo: 'vignette' },
];

/** 見本でかける強さ。既定の強さでは違いが小さいものは、分かるように強めにする。 */
function demoIntensity(type: EffectType): number {
  if (type === 'brightness' || type === 'contrast') return 0.8;
  if (type === 'saturate') return 0.9;
  if (type === 'blur') return 0.12;
  return EFFECT_META[type].def;
}

function EffectsTab({ clip }: { clip: Clip }) {
  const patch = useClipPatch(clip);
  // 見本は、選んでいるクリップの絵にかけて見せる（無ければ色の帯）。
  const thumbnail = mediaRegistry.get(clip.mediaId)?.thumbnail;

  const add = (type: EffectType) => {
    const effect: Effect = { id: uid('fx'), type, intensity: EFFECT_META[type].def };
    patch({ effects: [...clip.effects, effect] });
  };

  const filterOk = canvasFilterSupported();
  const missing = unsupportedEffectTypes(clip.effects);
  return (
    <>
      {!filterOk && (
        <p className="warn small" role="note">
          この端末では、色のエフェクト（明るさ・白黒など）が映りません（iPadOS 17 以前の Safari は、キャンバスの色のフィルタに対応していないため）。
          ぼかしと背景ぼかしは、簡易な描き方で代わりに映します。iPadOS 18 以降にすると、すべて使えます。
          {missing.length > 0 && <> このクリップの「{missing.map((t) => EFFECT_META[t].label).join('・')}」は、書き出しにも入りません。</>}
        </p>
      )}
      <Field label="色味のおまかせ（ルック）">
        <div className="chip-row wrap">
          {LOOK_PRESETS.map((look) => (
            <Hint
              key={look.key}
              title={look.label}
              desc={
                look.effects.length === 0
                  ? 'エフェクトをすべて外して、元の絵に戻します。'
                  : `${look.effects.map((e) => EFFECT_META[e.type as EffectType].label).join(' と ')}を、ちょうどよい強さでかけます。`
              }
              demo={() => <EffectDemo effects={look.effects as { type: EffectType; intensity: number }[]} thumbnail={thumbnail} />}
            >
              <button
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
            </Hint>
          ))}
        </div>
      </Field>

      <ButtonField label="動きを付ける" hint="寄る・揺らす・周りを暗く">
        <div className="chip-row wrap">
          {MOTION_PRESETS.map((preset) => (
            <Hint
              key={preset.key}
              title={preset.label}
              desc={preset.hint}
              demo={() => <EffectDemo effects={[{ type: preset.type, intensity: preset.intensity }]} thumbnail={thumbnail} motion={preset.demo} />}
            >
              <button
                type="button"
                className="chip"
                onClick={() =>
                  patch({
                    effects: [
                      ...clip.effects,
                      {
                        id: uid('fx'),
                        type: preset.type,
                        intensity: preset.intensity,
                        // 「じわっと」は、このクリップの長さいっぱいを使って効かせる（あとで秒数を見て直せるよう、実際の長さを入れる）。
                        timing: preset.timing === SLOW_IN_TIMING ? { ...SLOW_IN_TIMING, attack: Number(clip.duration.toFixed(2)) } : preset.timing,
                      },
                    ],
                  })
                }
              >
                <Icon name="plus" size={15} />{preset.label}
              </button>
            </Hint>
          ))}
        </div>
      </ButtonField>

      <ButtonField label="色を変える" hint="明るさ・色あい・ぼかし">
        <div className="chip-row wrap">
          {(Object.keys(EFFECT_META) as EffectType[]).filter((type) => !MOTION_EFFECTS.includes(type)).map((type) => (
            <Hint
              key={type}
              title={EFFECT_META[type].label}
              desc={`${EFFECT_HINTS[type]}足したあと、強さをつまみで変えられます。`}
              demo={() => <EffectDemo effects={[{ type, intensity: demoIntensity(type) }]} thumbnail={thumbnail} />}
            >
              <button type="button" className="chip" onClick={() => add(type)}>
                <Icon name="plus" size={15} />{EFFECT_META[type].label}
              </button>
            </Hint>
          ))}
        </div>
      </ButtonField>

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

/**
 * テロップの入場の動きを、その場で一度だけ見せる。頭へ戻して再生し、動き終わったら止める。
 * 選び直すたびに文字がどう入ってくるかを、再生ボタンを探さずに確かめられる。
 */
let entrancePause: ReturnType<typeof setTimeout> | undefined;
/** カーソルを合わせると、いまの文字がその動きで出てくる様子を見せる。 */
function AnimationHint({ animation, text, children }: { animation: TextAnimation; text: TextProps; children: React.ReactNode }) {
  return (
    <Hint
      title={TEXT_ANIMATION_LABELS[animation]}
      desc={animation === 'none' ? '動かさずに、そのまま出します。' : 'テロップが出てくるときの動きです。いまの文字で試しています。'}
      demo={() => <TextDemo text={{ ...text, animation, animationDuration: Math.max(0.45, text.animationDuration) }} />}
    >
      {children}
    </Hint>
  );
}

function previewEntrance(clip: Clip, animationSeconds: number) {
  clearTimeout(entrancePause);
  player.seek(clip.start);
  if (!player.playing) player.play();
  const until = clip.start + Math.min(clip.duration, animationSeconds + 0.6);
  entrancePause = setTimeout(() => {
    // 途中で別の所へ飛んだり止めたりしたなら、こちらからは触らない。
    if (player.playing && player.time >= clip.start && player.time <= until + 0.5) player.pause();
  }, (until - clip.start) * 1000);
}

function TextTab({ clip, text, cursorRef }: { clip: Clip; text: TextProps; cursorRef: CursorRef }) {
  const patch = useClipPatch(clip);
  const learning = useCaptionLearning();
  const { addTemplate, templates } = useApp();
  const fontOptions = useFontOptions(text.fontFamily);
  const [savedStyle, setSavedStyle] = useState<string | null>(null);
  const myStyles = templates.filter((t) => t.kind === 'text');
  const easy = useEasy();
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
        onFocus={() => learning.begin(clip)}
        onBlur={(e) => learning.finish(clip, e.target.value)}
        onChange={(e) => {
          set({ content: e.target.value }, 'content');
          cursorRef.current = { clipId: clip.id, pos: e.target.selectionStart };
        }}
        onSelect={trackCursor}
        onClick={trackCursor}
        onKeyUp={trackCursor}
      />
      <LearnedNote learned={learning.learned} forget={learning.forget} />

      <ButtonField label="スタイル" hint="使いどころで分けてあります">
        <div className="style-groups">
          {myStyles.length > 0 && (
            <div className="style-group">
              <span className="style-group-label" title="テキストスタイルの画面で作ったもの">
                自分のスタイル
              </span>
              <div className="chip-row wrap">
                {myStyles.map((t) =>
                  t.kind === 'text' ? (
                    <button key={t.id} type="button" className="chip" onClick={() => set({ ...t.text, content: text.content })}>
                      {t.name}
                    </button>
                  ) : null,
                )}
              </div>
            </div>
          )}
          {TEXT_PRESET_GROUPS.map((group) => (
            <div key={group.key} className="style-group">
              <span className="style-group-label" title={group.hint}>
                {group.label}
              </span>
              <div className="chip-row wrap">
                {TEXT_PRESETS.filter((preset) => preset.group === group.key).map((preset) => (
                  <Hint
                    key={preset.key}
                    title={preset.label}
                    desc={`${group.label}。${group.hint}。いまの文字に当てた見た目です。`}
                    demo={() => <TextDemo still text={{ ...preset.text, content: text.content }} />}
                  >
                    <button type="button" className="chip" onClick={() => set({ ...preset.text, content: text.content })}>
                      {preset.label}
                    </button>
                  </Hint>
                ))}
              </div>
            </div>
          ))}
        </div>
      </ButtonField>

      <div className="two-col">
        <Field label="サイズ">
          <Slider value={text.fontSize} min={20} max={220} step={1} onChange={(fontSize) => set({ fontSize }, 'size')} format={(v) => `${v.toFixed(0)}`} />
        </Field>
        <Field label="文字色">
          <ColorInput value={text.color} onChange={(color) => set({ color }, 'color')} />
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

      <Field label="位置">
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

      </Field>
      {easy ? (
        <details className="more-settings">
          <summary>くわしい設定（フォント・フチ・影・動きなど）</summary>
      <Field label="フォント">
        <select value={text.fontFamily} onChange={(e) => set({ fontFamily: e.target.value })}>
          {fontOptions.map((font) => (
            <option key={font.value} value={font.value}>
              {font.label}
            </option>
          ))}
        </select>
      </Field>

      <div className="two-col">
        <Field label="太さ">
          <Slider value={text.weight} min={100} max={900} step={100} onChange={(weight) => set({ weight }, 'weight')} format={(v) => `${v}`} />
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

      <Field label="出てくるときの動き（入場アニメーション）">
        <div className="chip-row wrap">
          {(Object.keys(TEXT_ANIMATION_LABELS) as TextAnimation[]).map((animation) => (
            <AnimationHint key={animation} animation={animation} text={text}>
              <button
                type="button"
                className={text.animation === animation ? 'chip active' : 'chip'}
                onClick={() => {
                  set({ animation });
                  previewEntrance(clip, text.animationDuration);
                }}
              >
                {TEXT_ANIMATION_LABELS[animation]}
              </button>
            </AnimationHint>
          ))}
          <button
            type="button"
            className="chip ghost"
            title="このテロップの頭から、入ってくる動きを再生します"
            onClick={() => previewEntrance(clip, text.animationDuration)}
          >
            <Icon name="play" />動きを確認
          </button>
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


          <hr />
          <SpeakerSection text={text} set={set} />

          <hr />
          <CardFrameSection text={text} set={set} />
      <button
        type="button"
        className="wide ghost"
        onClick={() => {
          // window.prompt は iPad のアプリで出ないことがあるので、名前は決め打ちで付ける（テキストスタイルの画面で直せる）。
          const { content: _content, ...style } = text;
          const name = `スタイル ${templates.filter((t) => t.kind === 'text').length + 1}`;
          addTemplate({ kind: 'text', name, text: { ...style, content: 'テキストを入力' } });
          setSavedStyle(name);
        }}
      >
        このスタイルをテンプレートに保存
      </button>
      {savedStyle && <p className="muted small">「{savedStyle}」として保存しました。名前や細かい所は「テキストスタイル」の画面で直せます。</p>}
        </details>
      ) : (
        <>
      <Field label="フォント">
        <select value={text.fontFamily} onChange={(e) => set({ fontFamily: e.target.value })}>
          {fontOptions.map((font) => (
            <option key={font.value} value={font.value}>
              {font.label}
            </option>
          ))}
        </select>
      </Field>

          <div className="two-col">
        <Field label="太さ">
          <Slider value={text.weight} min={100} max={900} step={100} onChange={(weight) => set({ weight }, 'weight')} format={(v) => `${v}`} />
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
      <Field label="出てくるときの動き（入場アニメーション）">
        <div className="chip-row wrap">
          {(Object.keys(TEXT_ANIMATION_LABELS) as TextAnimation[]).map((animation) => (
            <AnimationHint key={animation} animation={animation} text={text}>
              <button
                type="button"
                className={text.animation === animation ? 'chip active' : 'chip'}
                onClick={() => set({ animation })}
              >
                {TEXT_ANIMATION_LABELS[animation]}
              </button>
            </AnimationHint>
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


          <hr />
          <SpeakerSection text={text} set={set} />

          <hr />
          <CardFrameSection text={text} set={set} />
      <button
        type="button"
        className="wide ghost"
        onClick={() => {
          // window.prompt は iPad のアプリで出ないことがあるので、名前は決め打ちで付ける（テキストスタイルの画面で直せる）。
          const { content: _content, ...style } = text;
          const name = `スタイル ${templates.filter((t) => t.kind === 'text').length + 1}`;
          addTemplate({ kind: 'text', name, text: { ...style, content: 'テキストを入力' } });
          setSavedStyle(name);
        }}
      >
        このスタイルをテンプレートに保存
      </button>
      {savedStyle && <p className="muted small">「{savedStyle}」として保存しました。名前や細かい所は「テキストスタイル」の画面で直せます。</p>}
        </>
      )}
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
const SPEAKER_DEFAULT_COLORS: Record<string, string> = { '1': '#5cd6ff', '2': '#ffb347' };
/** これより差が小さい行は「迷った」として数える。 */
const UNSURE_MARGIN = 0.03;

function SpeakerSection({ text, set }: { text: TextProps; set: (changes: Partial<TextProps>, key?: string) => void }) {
  const { sequence, apply, setSelection } = useEditor();
  const [colors, setColors] = useState(SPEAKER_DEFAULT_COLORS);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const captions = sequence.clips.filter((c) => c.kind === 'text' && (c.text?.role ?? 'caption') === 'caption');
  const anchorFor = (speaker: string) => captions.find((c) => c.text?.speaker === speaker) ?? null;
  const ready = SPEAKERS.every((s) => anchorFor(s) !== null);
  /** 声で決めきれなかった行（時刻順）。 */
  const unsureRows = captions.filter((c) => c.text?.speakerGuess).sort((a, b) => a.start - b.start);
  /** 要確認の行を、人が決める。色もその人の色にする。 */
  const decide = (clipId: string, speaker: string) =>
    apply((seq) => ({
      ...seq,
      clips: seq.clips.map((c) =>
        c.id === clipId && c.text
          ? { ...c, text: { ...c.text, speaker, speakerGuess: null, color: colors[speaker] ?? c.text.color } }
          : c,
      ),
    }));

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
          // 決めきれなかった行は、推測で色を付けない。「たぶんこちら」だけ覚えて、要確認の一覧に出す。
          if (decision.margin < UNSURE_MARGIN) return { ...c, text: { ...c.text, speaker: null, speakerGuess: decision.id } };
          return { ...c, text: { ...c.text, speaker: decision.id, speakerGuess: null, color: colors[decision.id] ?? c.text.color } };
        }),
      }));

      const unsure = [...decided.values()].filter((d) => d.margin < UNSURE_MARGIN).length;
      const skipped = results.length - decided.size;
      setNote(
        `${decided.size - unsure} 行を振り分けました。` +
          (unsure ? `${unsure} 行は決めきれなかったので、色を付けずに下の「要確認」に並べました。` : '') +
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
          onChange={(speaker) => set({ speaker: speaker || null, speakerGuess: null })}
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
      {unsureRows.length > 0 && (
        <div className="review-list" role="group" aria-label="話者の要確認">
          <div className="review-head">
            <strong>要確認 {unsureRows.length} 行</strong>
            <span className="muted small">だれの声か決めきれなかった字幕です。聞いて確かめて、どちらか選んでください。</span>
          </div>
          <ul>
            {unsureRows.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  className="review-row"
                  title="この字幕の所へ飛んで、再生します"
                  onClick={() => {
                    setSelection([row.id]);
                    player.seek(row.start);
                    player.play();
                  }}
                >
                  <span className="review-time">{formatTime(row.start)}</span>
                  <span className="review-text">{previewText(row.text!.content).split('\n')[0]}</span>
                </button>
                <span className="review-pick">
                  {SPEAKERS.map((speaker) => (
                    <button
                      key={speaker}
                      type="button"
                      className={row.text!.speakerGuess === String(speaker) ? 'chip guess' : 'chip'}
                      title={row.text!.speakerGuess === String(speaker) ? 'たぶんこちら（声が少しだけ近い）' : undefined}
                      onClick={() => decide(row.id, String(speaker))}
                    >
                      話者{speaker}
                    </button>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="muted small">
        声の高さと音色で判断します。同じ人でもささやくと外れることがあるので、
        決めきれなかった行には色を付けず、「要確認」に並べます。
      </p>
    </>
  );
}

/** 選んだ中に、「繋ぐ」で 1 本に戻せる 2 本があるか。 */
function joinablePair(sequence: Sequence, clips: Clip[]): boolean {
  const ids = new Set(clips.map((c) => c.id));
  for (const track of sequence.tracks) {
    const run = clipsOnTrack(sequence, track.id).filter((c) => ids.has(c.id));
    for (let i = 1; i < run.length; i += 1) if (canJoin(run[i - 1], run[i])) return true;
  }
  return false;
}

/** テンポを調べるのは、これより短いクリップだけ（音を丸ごと起こすので、長いとメモリを食う）。 */
const TEMPO_LIMIT_SECONDS = 20 * 60;

/**
 * テンポのつまみ。しゃべりの間（無音）を、つまみ 1 本で詰める（model/tempo.ts）。
 * 音を起こして測るのは最初の 1 回だけ。つまみを動かすと、どれだけ詰まるかがすぐ出る。
 */
function TempoSection({ clip }: { clip: Clip }) {
  const { apply, sequence } = useEditor();
  const [amount, setAmount] = useState(0.5);
  const [measured, setMeasured] = useState<{ key: string; track: LoudnessTrack; offset: number; nested?: Sequence } | null>(
    null,
  );
  // まとめたクリップ（3 分割など）は、中身を混ぜた音で測り、中身を丸ごと詰める。
  const isNest = clip.kind === 'nest';
  /** 素材の秒として扱うための形。まとめたクリップは、頭からの秒を素材の秒とみなす。 */
  const asSource = (c: Clip): Clip => (c.kind === 'nest' ? { ...c, sourceIn: 0, speed: 1 } : c);
  const [state, setState] = useState<'idle' | 'measuring' | 'failed' | 'tooLong'>('idle');
  // 詰めたという知らせは、詰めた直後のタイムラインのあいだだけ出す（「戻す」を押したら、またつまみに戻る）。
  const [doneState, setDoneState] = useState<{ text: string; before: Sequence; after: Sequence | null } | null>(null);
  useEffect(() => {
    if (doneState && !doneState.after && sequence !== doneState.before) setDoneState({ ...doneState, after: sequence });
  }, [doneState, sequence]);
  const done = doneState && (doneState.after === null || doneState.after === sequence) ? doneState.text : null;
  const range = isNest ? { from: 0, to: clip.duration } : usedSourceRange(clip);
  const key = `${clip.id}:${clip.mediaId}:${clip.sourceIn.toFixed(3)}:${range.from.toFixed(3)}:${range.to.toFixed(3)}`;
  // 中に入って直したあとは、測り直す（中身が変わると間の位置も変わる）。
  const ready = measured?.key === key && (!isNest || measured.nested === clip.nested) ? measured : null;

  const measure = async () => {
    if (!clip.mediaId && !isNest) return;
    if (range.to - range.from > TEMPO_LIMIT_SECONDS) {
      setState('tooLong');
      return;
    }
    setState('measuring');
    setDoneState(null);
    try {
      if (isNest) {
        // 書き出しと同じ混ぜ方で、このまとめたクリップの中身だけの音を作る。
        const alone = flattenNests({ ...sequence, clips: [{ ...clip, start: 0 }] });
        const mix = await renderAudioMix(alone, clip.duration);
        if (!mix) throw new Error('mix');
        setMeasured({ key, track: analyzeLoudness(mix), offset: 0, nested: clip.nested });
        setState('idle');
        return;
      }
      if (!clip.mediaId) return;
      const decoded = await decodeAssetAudioRange(clip.mediaId, range.from, range.to);
      if (!decoded) throw new Error('decode');
      setMeasured({ key, track: analyzeLoudness(decoded.buffer), offset: decoded.start });
      setState('idle');
    } catch {
      setState('failed');
    }
  };

  /** 残す範囲（素材の秒）。 */
  const keep = useMemo<TimeRange[] | null>(() => {
    if (!ready) return null;
    const plan = planJetCut(ready.track, { mode: 'level', ...tempoOptions(amount) });
    return plan.keep.map((r) => ({ start: r.start + ready.offset, end: r.end + ready.offset }));
  }, [ready, amount]);
  const cuts = useMemo(() => (keep ? cutRanges(asSource(clip), keep) : []), [clip, keep]);
  const removed = cuts.reduce((sum, c) => sum + c.end - c.start, 0);

  const run = () => {
    if (!keep) return;
    const id = clip.id;
    apply((seq) => {
      const current = seq.clips.find((c) => c.id === id);
      if (!current) return seq;
      const ranges = cutRanges(asSource(current), keep);
      return current.kind === 'nest' ? removeRangesInNest(seq, id, ranges).sequence : removeRanges(seq, id, ranges).sequence;
    });
    setDoneState({
      text: `${cuts.length} か所・${removed.toFixed(1)} 秒詰めました。元に戻すなら「戻す」を押してください。`,
      before: sequence,
      after: null,
    });
  };

  return (
    <>
      <ButtonField label="間を詰める（テンポ）" hint="しゃべりの間（音の無い所）を詰めます">
        {done ? (
          <p className="muted small">{done}</p>
        ) : !ready ? (
          <Hint
            title="間を詰める"
            alias="テンポ"
            desc="しゃべっていない所（音の無い間）を探して切り取り、前後を詰めます。まず間を調べ、どれだけ詰めるかはつまみで決めます。"
            demo={() => <TimelineDemo kind="tempo" />}
          >
            <button type="button" className="wide" onClick={measure} disabled={state === 'measuring'}>
              {state === 'measuring' ? '音を調べています…' : '間を調べる'}
            </button>
          </Hint>
        ) : (
          <>
            <Slider
              value={amount}
              min={0}
              max={1}
              step={0.05}
              onChange={setAmount}
              format={(v) => (v < 0.34 ? 'ゆったり' : v < 0.67 ? 'ふつう' : 'きびきび')}
              onReset={() => setAmount(0.5)}
            />
            <p className="muted small">
              {cuts.length === 0
                ? 'この強さでは、詰める間はありません。'
                : `${cuts.length} か所・${removed.toFixed(1)} 秒詰まります（${clip.duration.toFixed(1)} 秒 → ${(clip.duration - removed).toFixed(1)} 秒）`}
            </p>
            <button type="button" className="wide primary" onClick={run} disabled={cuts.length === 0}>
              間を詰める
            </button>
          </>
        )}
      </ButtonField>
      {state === 'failed' && <p className="muted small">音を読めませんでした。</p>}
      {state === 'tooLong' && <p className="muted small">20 分より長いクリップは調べません。分割してからお試しください。</p>}
      {!done && (
        <p className="muted small">
          {isNest
            ? '中の映像（3 分割なら 3 本とも）・音・見出しを、同じ所でまとめて詰めます。まとめたクリップが短くなり、同じトラックの後ろのクリップも寄ります。'
            : 'つないだ音（映像）も一緒に詰まり、後ろのクリップも寄ります。BGM・字幕のトラックは動かさないので、3 分割や字幕より先に使うのがおすすめです。'}
        </p>
      )}
    </>
  );
}

/** 組んである 3 分割を「自分の型」として取っておくボタン。名前は既定で付け、テンプレートのページで直せる。 */
function SaveKitButton({ kit }: { kit: NonNullable<ReturnType<typeof captureKit>> }) {
  const { templates, addTemplate, updateSettings } = useApp();
  const [saved, setSaved] = useState<string | null>(null);
  const save = () => {
    // window.prompt は iPad のアプリ（WKWebView）で出ないことがあるので、名前は決め打ちで付ける。
    const name = `自分の型 ${templates.filter((t) => t.kind === 'kit').length + 1}`;
    const template = addTemplate({ kind: 'kit', name, kit });
    // 作ったばかりの型を、次に組むときの既定にする（そのために作ったはずなので）。
    updateSettings({ threeBandLayout: `kit:${template.id}` });
    setSaved(name);
  };
  return (
    <>
      <button type="button" className="wide" onClick={save}>
        この 3 分割を自分の型にする
      </button>
      <p className="muted small">
        {saved
          ? `「${saved}」として保存しました。名前はテンプレートのページで変えられます。`
          : 'いまの切り抜き位置と見出しの体裁を取っておき、次から「縦 3 段に組む」で同じように組めます。'}
      </p>
    </>
  );
}

/** まとめたクリップ。中身を編集する入口と、まとめを解く。 */
function NestInspector({ clip, tab, setTab }: { clip: Clip; tab: TabKey; setTab: (tab: TabKey) => void }) {
  const { sequence, apply, enterNest, setSelection } = useEditor();
  const easy = useEasy();
  const patch = useClipPatch(clip);
  const inner = clip.nested?.clips ?? [];
  const kit = useMemo(() => captureKit(sequence, inner), [sequence, inner]);
  // 中身を元のトラックへ戻す。戻した中身を選んでおく（すぐ直せるように）。
  const ungroup = () => {
    const before = new Set(sequence.clips.map((c) => c.id));
    const after = unnestClip(sequence, clip.id);
    apply((seq) => unnestClip(seq, clip.id));
    setSelection(after.clips.filter((c) => !before.has(c.id)).map((c) => c.id));
  };
  return (
    <Panel
      title="まとめたクリップ"
      action={
        <div className="panel-actions">
          <button type="button" onClick={() => player.seek(clip.start)}>
            頭出し
          </button>
          <button type="button" className="danger" onClick={() => apply((seq) => removeClips(seq, [clip.id], easy))}>
            削除
          </button>
        </div>
      }
    >
      <Tabs<TabKey>
        value={tab === 'auto' ? 'auto' : 'props'}
        options={[
          { value: 'props', label: 'プロパティ' },
          { value: 'auto', label: '自動' },
        ]}
        onChange={setTab}
      />
      {tab === 'auto' ? (
        <>
          <TempoSection key={clip.id} clip={clip} />
          <hr />
          <NestSceneSplit key={`scene-${clip.id}`} clip={clip} />
          <NestHighlights key={`hl-${clip.id}`} clip={clip} />
        </>
      ) : (
        <>
      <Field label="名前">
        <input type="text" value={clip.name ?? ''} onChange={(e) => patch({ name: e.target.value }, 'nestName')} />
      </Field>
      <p className="muted">
        {formatTime(clip.start)} → {formatTime(clip.start + clip.duration)}（{clip.duration.toFixed(2)} 秒）・中に {inner.length} 本
        （中身の長さ {nestedLength(clip).toFixed(2)} 秒）
      </p>
      <button type="button" className="wide primary" onClick={() => enterNest(clip.id)}>
        中身を編集する
      </button>
      <button type="button" className="wide" onClick={ungroup} title="中身を元のトラックへ戻します。右クリック（長押し）のメニューからもできます">
        まとめを解く
      </button>
      {kit && <RelayoutField mode="nest" nestId={clip.id} />}
      {kit && <SaveKitButton kit={kit} />}
      <p className="muted small">間を詰める・場面で分ける・見どころを探すは「自動」タブにあります。タイムラインでダブルクリックしても中に入れます。</p>
        </>
      )}
    </Panel>
  );
}
