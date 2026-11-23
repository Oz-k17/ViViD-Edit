/**
 * スマートレンダーの実際の手（`model/smartRender.ts` が決めた計画を、動画データとして組む）。
 *
 * openreel-video（MIT, Augustus Otu and Contributors）の `export/smart-render-scan.ts`・
 * `export/avc-config.ts`・`export/webcodecs-backend.ts`（copyRun と、SPS/PPS を流れの中に入れる所）に倣った。
 *
 * 映像の出口は 1 本の `EncodedVideoPacketSource`。そこへ、
 *   - 写す区間: 素材の H.264 のデータ（パケット）を、時刻だけずらしてそのまま
 *   - 書き直す区間: こちらの VideoEncoder が作ったデータ
 * を交互に流す。区間ごとに H.264 の設定（SPS/PPS）が違いうるので、違う区間は
 * キーフレームの頭に設定を入れておく（途中から再生しても読めるように）。
 */
import { BlobSource, EncodedPacket, EncodedPacketSink, EncodedVideoPacketSource, Input, UrlSource } from 'mediabunny';
import { VIDEO_INPUT_FORMATS } from './formats';
import { mediaRegistry } from './media';
import type { SmartSourceInfo } from '../model/smartRender';

// ---------- H.264 の設定（avcC）----------

interface AvcParameterSets {
  nalLengthSize: number;
  sps: Uint8Array[];
  pps: Uint8Array[];
}

/** AVCDecoderConfigurationRecord を読む。壊れていれば null。 */
function parseAvcC(avcC: Uint8Array): AvcParameterSets | null {
  if (avcC.length < 7 || avcC[0] !== 1) return null;
  const nalLengthSize = (avcC[4] & 0x03) + 1;
  let pos = 5;
  const spsCount = avcC[pos++] & 0x1f;
  const sps: Uint8Array[] = [];
  for (let i = 0; i < spsCount; i += 1) {
    if (pos + 2 > avcC.length) return null;
    const len = (avcC[pos] << 8) | avcC[pos + 1];
    pos += 2;
    if (pos + len > avcC.length) return null;
    sps.push(avcC.slice(pos, pos + len));
    pos += len;
  }
  if (pos >= avcC.length) return null;
  const ppsCount = avcC[pos++];
  const pps: Uint8Array[] = [];
  for (let i = 0; i < ppsCount; i += 1) {
    if (pos + 2 > avcC.length) return null;
    const len = (avcC[pos] << 8) | avcC[pos + 1];
    pos += 2;
    if (pos + len > avcC.length) return null;
    pps.push(avcC.slice(pos, pos + len));
    pos += len;
  }
  return { nalLengthSize, sps, pps };
}

const hex = (n: Uint8Array) => Array.from(n, (b) => b.toString(16).padStart(2, '0')).join('');
const parameterSetKey = (sets: AvcParameterSets) => `${sets.sps.map(hex).join('+')}|${sets.pps.map(hex).join('+')}`;

/** パケットの頭に SPS/PPS を、長さ付きの NAL として足す。 */
function prependParameterSets(packet: Uint8Array, sets: AvcParameterSets): Uint8Array {
  const nals = [...sets.sps, ...sets.pps];
  const size = sets.nalLengthSize;
  const extra = nals.reduce((sum, nal) => sum + size + nal.length, 0);
  const out = new Uint8Array(extra + packet.length);
  let pos = 0;
  for (const nal of nals) {
    for (let shift = size - 1; shift >= 0; shift -= 1) out[pos++] = (nal.length >>> (8 * shift)) & 0xff;
    out.set(nal, pos);
    pos += nal.length;
  }
  out.set(packet, pos);
  return out;
}

function descriptionBytes(description: AllowSharedBufferSource): Uint8Array {
  if (ArrayBuffer.isView(description)) return new Uint8Array(description.buffer as ArrayBuffer, description.byteOffset, description.byteLength);
  return new Uint8Array(description as ArrayBuffer);
}

// ---------- 素材を調べる ----------

async function openInput(mediaId: string): Promise<Input | null> {
  const asset = mediaRegistry.get(mediaId);
  if (!asset) return null;
  if (asset.src) return new Input({ source: new UrlSource(asset.url), formats: VIDEO_INPUT_FORMATS });
  const blob = await fetch(asset.url).then((r) => r.blob()).catch(() => null);
  return blob ? new Input({ source: new BlobSource(blob), formats: VIDEO_INPUT_FORMATS }) : null;
}

const NTSC = [24000 / 1001, 24, 25, 30000 / 1001, 30, 50, 60000 / 1001, 60];
const snapFrameRate = (fps: number) => NTSC.find((c) => Math.abs(c - fps) < 0.02) ?? fps;

const scans = new Map<string, Promise<SmartSourceInfo | null>>();

/**
 * 素材の目次（絵のデータは読まない）から、写せる形かを調べる。H.264 でなければ null。素材ごとに覚えておく。
 */
export function scanSmartSource(mediaId: string): Promise<SmartSourceInfo | null> {
  let found = scans.get(mediaId);
  if (!found) {
    found = scan(mediaId).catch(() => null);
    scans.set(mediaId, found);
  }
  return found;
}

async function scan(mediaId: string): Promise<SmartSourceInfo | null> {
  const input = await openInput(mediaId);
  if (!input) return null;
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || track.codec !== 'avc') return null;
    const config = await track.getDecoderConfig();
    if (!config?.description) return null;
    const params = parseAvcC(descriptionBytes(config.description));
    if (!params) return null;
    const sink = new EncodedPacketSink(track);
    const times: number[] = [];
    const isKey: boolean[] = [];
    for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
      times.push(packet.timestamp);
      isKey.push(packet.type === 'key');
    }
    if (times.length < 2) return null;
    // 閉じた GOP: 読む順で、キーフレームより前のコマはそれより前に映り、そこから後のコマは後に映る。
    const n = times.length;
    const suffixMin = new Array<number>(n + 1).fill(Infinity);
    for (let i = n - 1; i >= 0; i -= 1) suffixMin[i] = Math.min(suffixMin[i + 1], times[i]);
    let prefixMax = -Infinity;
    let closedGops = true;
    for (let i = 0; i < n; i += 1) {
      if (isKey[i] && (prefixMax >= times[i] - 1e-6 || suffixMin[i] < times[i] - 1e-6)) closedGops = false;
      prefixMax = Math.max(prefixMax, times[i]);
    }
    const sorted = [...times].sort((a, b) => a - b);
    const diffs = sorted.slice(1).map((t, i) => t - sorted[i]).sort((a, b) => a - b);
    const frameDuration = diffs[Math.floor(diffs.length / 2)];
    if (!(frameDuration > 0)) return null;
    const frameRate = snapFrameRate(1 / frameDuration);
    const grid = 1 / frameRate;
    const firstPts = sorted[0];
    const constantFrameRate =
      sorted.every((t) => {
        const k = (t - firstPts) / grid;
        return Math.abs(k - Math.round(k)) < 0.02;
      }) && new Set(sorted.map((t) => Math.round((t - firstPts) / grid))).size === sorted.length;
    const colorSpace = await track.getColorSpace();
    return {
      mediaId,
      codec: 'avc',
      width: track.codedWidth,
      height: track.codedHeight,
      frameRate,
      firstPts,
      endTime: sorted[sorted.length - 1] + grid,
      keyframeTimes: times.filter((_, i) => isKey[i]).sort((a, b) => a - b),
      closedGops,
      constantFrameRate,
      nalLengthSize: params.nalLengthSize,
      rotation: track.rotation,
      color: { matrix: colorSpace.matrix, transfer: colorSpace.transfer, fullRange: colorSpace.fullRange },
    };
  } finally {
    input.dispose();
  }
}

// ---------- 写す区間と書き直す区間を 1 本につなぐ ----------

/** H.264 の段（level）を、出力の大きさから選ぶ。 */
function avcCodecs(width: number, height: number): string[] {
  const area = width * height;
  const level = area <= 414_720 ? '1e' : area <= 921_600 ? '1f' : area <= 2_097_152 ? '28' : area <= 8_912_896 ? '33' : '34';
  return [`avc1.6400${level}`, `avc1.4d00${level}`, `avc1.4200${level}`];
}

export class SmartMuxer {
  readonly source = new EncodedVideoPacketSource('avc');
  private encoder: VideoEncoder | null = null;
  private config: VideoEncoderConfig | null = null;
  private chain: Promise<void> = Promise.resolve();
  private error: unknown = null;
  private metaSent = false;
  private activeKey: string | null = null;
  private fileKey: string | null = null;
  private runSets: AvcParameterSets | null = null;
  private runKey: string | null = null;
  private runNeedsParams = false;
  private forceKey = false;
  private sinceKey = 0;
  private runFrames = 0;
  private runPackets = 0;

  private readonly width: number;
  private readonly height: number;
  private readonly fps: number;
  private readonly bitrate: number;

  // Node が .ts をそのまま読めるよう、引数で中身を持つ書き方（parameter property）は使わない。
  constructor(width: number, height: number, fps: number, bitrate: number) {
    this.width = width;
    this.height = height;
    this.fps = fps;
    this.bitrate = bitrate;
  }

  /** この環境で、出力の大きさの H.264 を書けるか（書けなければ、ふつうの書き出しに戻す）。 */
  static async supported(width: number, height: number, fps: number, bitrate: number): Promise<VideoEncoderConfig | null> {
    if (typeof VideoEncoder === 'undefined') return null;
    for (const codec of avcCodecs(width, height)) {
      const config: VideoEncoderConfig = { codec, width, height, bitrate, framerate: fps, latencyMode: 'quality', avc: { format: 'avc' } };
      try {
        const support = await VideoEncoder.isConfigSupported(config);
        if (support.supported) return support.config ?? config;
      } catch {
        /* 次の候補へ */
      }
    }
    return null;
  }

  private enqueue(packet: EncodedPacket, sets: AvcParameterSets | null, meta: EncodedVideoChunkMetadata | undefined): Promise<void> {
    this.chain = this.chain
      .then(async () => {
        if (this.error) return;
        let out = packet;
        let prepended = false;
        if (sets && this.runNeedsParams) {
          this.runNeedsParams = false;
          const key = parameterSetKey(sets);
          if (this.activeKey === null) this.activeKey = key;
          else if (key !== this.activeKey) {
            out = new EncodedPacket(prependParameterSets(packet.data, sets), packet.type, packet.timestamp, packet.duration);
            this.activeKey = key;
            prepended = true;
          }
        }
        if (sets) {
          this.runSets = sets;
          this.runKey = parameterSetKey(sets);
          this.fileKey ??= this.runKey;
        }
        // **どの区間も**、キーフレームごとに自分の設定を入れる。
        // openreel は「入れ物の設定と違う区間だけ」にしていたが、それだと、設定の違う区間を読んだあとに
        // 前の区間へ戻ると、ブラウザ（Chromium）の読み手が古い設定のまま読もうとして止まった（ViViD で測った）。
        // 1 つのキーフレームに数十バイト足すだけなので、全部に入れる。
        if (!prepended && packet.type === 'key' && this.runSets) {
          out = new EncodedPacket(prependParameterSets(packet.data, this.runSets), packet.type, packet.timestamp, packet.duration);
        }
        let sendMeta: EncodedVideoChunkMetadata | undefined;
        if (!this.metaSent) {
          if (!meta?.decoderConfig) throw new Error('最初の映像データに設定が付いていませんでした');
          sendMeta = meta;
          this.metaSent = true;
        }
        await this.source.add(out, sendMeta);
      })
      .catch((error: unknown) => {
        this.error ??= error;
      });
    return this.chain;
  }

  private async openEncoder() {
    this.config ??= await SmartMuxer.supported(this.width, this.height, this.fps, this.bitrate);
    if (!this.config) throw new Error('この環境では H.264 を書けません');
    this.runNeedsParams = true;
    this.runSets = null;
    this.runKey = null;
    this.runFrames = 0;
    this.runPackets = 0;
    this.forceKey = true;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        const packet = new EncodedPacket(data, chunk.type === 'key' ? 'key' : 'delta', chunk.timestamp / 1e6, (chunk.duration ?? 0) / 1e6);
        const description = meta?.decoderConfig?.description;
        const sets = description ? parseAvcC(descriptionBytes(description)) : null;
        this.runPackets += 1;
        void this.enqueue(packet, sets, meta);
      },
      error: (error) => {
        this.error ??= error;
      },
    });
    encoder.configure(this.config);
    this.encoder = encoder;
  }

  /** 書き直す区間に 1 コマ足す。区間の最初のコマはキーフレームにし、あとは 2 秒ごと。 */
  async encode(canvas: HTMLCanvasElement, frameIndex: number) {
    if (this.error) throw this.error;
    if (!this.encoder) await this.openEncoder();
    const encoder = this.encoder as VideoEncoder;
    while (encoder.encodeQueueSize > 8) await new Promise((resolve) => setTimeout(resolve, 1));
    const frame = new VideoFrame(canvas, { timestamp: Math.round((frameIndex / this.fps) * 1e6), duration: Math.round(1e6 / this.fps) });
    const key = this.forceKey || this.sinceKey >= this.fps * 2;
    try {
      encoder.encode(frame, { keyFrame: key });
    } finally {
      frame.close();
    }
    this.forceKey = false;
    this.sinceKey = key ? 1 : this.sinceKey + 1;
    this.runFrames += 1;
  }

  /** 書き直す区間を閉じる（次に写す区間を流す前に、全部を流し切る）。 */
  async endEncodeRun() {
    const encoder = this.encoder;
    if (!encoder) return;
    this.encoder = null;
    try {
      await encoder.flush();
    } finally {
      if (encoder.state !== 'closed') encoder.close();
    }
    await this.chain;
    if (this.error) throw this.error;
    if (this.runPackets !== this.runFrames) throw new Error(`書き直した ${this.runFrames} コマのうち ${this.runPackets} コマしか出てきませんでした`);
  }

  /**
   * 素材の [sourceStart, sourceEnd) のデータを、出力の outputStart 秒から写す（sourceStart はキーフレーム）。
   * 写したコマの数を返す。
   */
  async copyRun(mediaId: string, sourceStart: number, sourceEnd: number, outputStart: number): Promise<number> {
    await this.endEncodeRun();
    const input = await openInput(mediaId);
    if (!input) throw new Error('素材を開けませんでした');
    try {
      const track = await input.getPrimaryVideoTrack();
      const config = track ? await track.getDecoderConfig() : null;
      if (!track || !config?.description) throw new Error('素材の H.264 の設定を読めませんでした');
      const sets = parseAvcC(descriptionBytes(config.description));
      if (!sets) throw new Error('素材の H.264 の設定を読めませんでした');
      const sink = new EncodedPacketSink(track);
      const first = await sink.getKeyPacket(sourceStart + 1e-4);
      if (!first || Math.abs(first.timestamp - sourceStart) > 1e-3) throw new Error('写す頭にキーフレームがありませんでした');
      const shift = outputStart - first.timestamp;
      this.runNeedsParams = true;
      this.runSets = null;
      this.runKey = null;
      let copied = 0;
      for await (const packet of sink.packets(first)) {
        if (packet.timestamp >= sourceEnd - 1e-4) break;
        const out = new EncodedPacket(packet.data, packet.type, packet.timestamp + shift, packet.duration);
        copied += 1;
        await this.enqueue(out, copied === 1 ? sets : null, copied === 1 ? { decoderConfig: config } : undefined);
        if (this.error) throw this.error;
      }
      // 写した区間のあとは、書き直す区間がキーフレームから始まる（openEncoder が強制する）。
      this.sinceKey = 0;
      return copied;
    } finally {
      input.dispose();
    }
  }

  async finish() {
    await this.endEncodeRun();
    await this.chain;
    if (this.error) throw this.error;
  }

  /** 失敗したとき、開いたままの部品を閉じる。 */
  dispose() {
    try {
      if (this.encoder && this.encoder.state !== 'closed') this.encoder.close();
    } catch {
      /* 閉じている */
    }
    this.encoder = null;
  }
}
