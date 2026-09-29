/**
 * 文字起こしを回す側（Worker）。
 *
 * **ここには transformers.js を含めない。** 押されたときに初めて読み込む。
 * 中身を抱え込むと本体が桁違いに重くなるうえ、使わない人にも配ることになる。
 * この駆け出し部分だけを `whisper/worker.js` として置き、
 * 本体（`transformers.min.js`）と onnxruntime の wasm は、その場で取りに行く。
 *
 * メインスレッドでは回さない。1 分の音でも数十秒かかることがあり、
 * その間ずっと画面が固まってしまうため。
 */

/** 呼ぶ側からの指示。 */
export interface LoadMessage {
  type: 'load';
  /** 例 `onnx-community/whisper-large-v3-turbo`。 */
  modelId: string;
  /** 'webgpu' なら GPU、'wasm' なら CPU。 */
  device: 'webgpu' | 'wasm';
  /** transformers.js の置き場所（この Worker からの相対でもよい）。 */
  libraryUrl: string;
  /** モデルを手元に置いてある場合の場所。空なら Hugging Face から取る。 */
  localPath?: string;
  /** onnxruntime の wasm を手元に置いてある場合の場所。空なら既定。 */
  wasmPath?: string;
}

export interface RunMessage {
  type: 'run';
  /** 16kHz・モノラルの波形。 */
  audio: Float32Array;
  language: string;
  /** 単語ごとの時刻も取るか。取れると、行を割る位置が言った所と合う。 */
  words: boolean;
  /** 探す道の数。多いほど丁寧だが遅い。1 で速く、5 で丁寧に。 */
  beams: number;
}

export interface ResultChunk {
  timestamp: [number, number | null];
  text: string;
}

interface TransformersModule {
  pipeline: (task: string, model: string, options: Record<string, unknown>) => Promise<unknown>;
  env: Record<string, unknown> & { backends: { onnx: { wasm: { wasmPaths: string } } } };
}

const ctx = globalThis as unknown as {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', handler: (event: MessageEvent) => void): void;
};

const post = (message: unknown) => ctx.postMessage(message);

type Transcriber = (audio: Float32Array, options: Record<string, unknown>) => Promise<unknown>;

let library: TransformersModule | null = null;
let transcriber: Transcriber | null = null;
/** どの組み合わせで読み込んだか。同じなら読み直さない（毎回モデルを取り直すと遅い）。 */
let loadedKey = '';

async function load(message: LoadMessage): Promise<void> {
  if (!library) {
    post({ type: 'stage', stage: 'library' });
    // 変数での読み込みなので、組み立て時にここへ埋め込まれることはない。
    library = (await import(/* @vite-ignore */ message.libraryUrl)) as TransformersModule;
  }
  const { pipeline, env } = library;

  const key = `${message.modelId}/${message.device}/${message.localPath ?? ''}`;
  if (transcriber && key === loadedKey) {
    post({ type: 'ready', reused: true });
    return;
  }

  if (message.localPath) {
    // 手元（NAS）に置いたモデルだけを見る。外へは取りに行かない。
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = message.localPath;
  }
  if (message.wasmPath) env.backends.onnx.wasm.wasmPaths = message.wasmPath;

  post({ type: 'stage', stage: 'model' });
  transcriber = (await pipeline('automatic-speech-recognition', message.modelId, {
    device: message.device,
    // whisper で勧められている組み合わせ。
    // 符号側（encoder）を軽くしすぎると、日本語の精度が目に見えて落ちる。
    dtype: {
      encoder_model: message.device === 'webgpu' ? 'fp16' : 'fp32',
      decoder_model_merged: 'q4',
    },
    progress_callback: (progress: unknown) => post({ type: 'progress', progress }),
  })) as Transcriber;
  loadedKey = key;
  post({ type: 'ready', reused: false });
}

async function run(message: RunMessage): Promise<void> {
  if (!transcriber) throw new Error('モデルが読み込まれていません');
  post({ type: 'stage', stage: 'run' });

  const output = (await transcriber(message.audio, {
    language: message.language,
    task: 'transcribe',
    // 'word' は単語ごと、true は文ごと。
    return_timestamps: message.words ? 'word' : true,
    // 30 秒ずつに切って回す。継ぎ目で言葉が切れないよう、前後 5 秒を重ねる。
    chunk_length_s: 30,
    stride_length_s: 5,
    // 道を増やすと取り違えが減る。手順書の仕上げも 5 で回している。
    num_beams: Math.max(1, message.beams),
    // 直前の出力を次の手がかりにしない。ここを繋ぐと、いちど言葉を作り始めたとき
    // それを手がかりにして延々と作り続ける（同じ行が何十も並ぶのはこれ）。
    condition_on_previous_text: false,
  })) as { text?: string; chunks?: ResultChunk[] };

  post({ type: 'result', text: output.text ?? '', chunks: output.chunks ?? [] });
}

ctx.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as LoadMessage | RunMessage;
  const work = data.type === 'load' ? load(data) : run(data);
  work.catch((error: unknown) => {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  });
});
