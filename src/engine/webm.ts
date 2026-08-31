/**
 * MediaRecorder の WebM には尺（Segment > Info > Duration）が書かれない。
 * そのままだとプレイヤーで長さが不明になり、シークできず、投稿先によっては弾かれる。
 * ここでは EBML を最小限だけ読み書きして Duration を埋める。
 * 少しでも想定と違う構造なら、何もせず元の Blob を返す（壊すくらいなら直さない）。
 */

const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_TIMECODE_SCALE = 0x2ad7b1;
const ID_DURATION = 0x4489;

interface Head {
  id: number;
  size: number;
  unknownSize: boolean;
  /** 要素の先頭（ID の 1 バイト目）。 */
  start: number;
  /** サイズ vint の先頭。 */
  sizeStart: number;
  sizeLength: number;
  /** 中身の先頭。 */
  dataStart: number;
}

function readId(bytes: Uint8Array, pos: number): { id: number; length: number } | null {
  const first = bytes[pos];
  if (first === undefined || first === 0) return null;
  let length = 1;
  for (let mask = 0x80; !(first & mask); mask >>= 1) {
    length += 1;
    if (length > 4) return null;
  }
  if (pos + length > bytes.length) return null;
  let id = 0;
  for (let i = 0; i < length; i += 1) id = id * 256 + bytes[pos + i];
  return { id, length };
}

function readSize(bytes: Uint8Array, pos: number): { size: number; length: number; unknown: boolean } | null {
  const first = bytes[pos];
  if (first === undefined || first === 0) return null;
  let length = 1;
  let mask = 0x80;
  while (!(first & mask)) {
    mask >>= 1;
    length += 1;
    if (length > 8) return null;
  }
  if (pos + length > bytes.length) return null;
  let size = first & (mask - 1);
  let allOnes = size === mask - 1;
  for (let i = 1; i < length; i += 1) {
    const byte = bytes[pos + i];
    if (byte !== 0xff) allOnes = false;
    size = size * 256 + byte;
  }
  return { size, length, unknown: allOnes };
}

function readHead(bytes: Uint8Array, pos: number): Head | null {
  const id = readId(bytes, pos);
  if (!id) return null;
  const size = readSize(bytes, pos + id.length);
  if (!size) return null;
  return {
    id: id.id,
    size: size.size,
    unknownSize: size.unknown,
    start: pos,
    sizeStart: pos + id.length,
    sizeLength: size.length,
    dataStart: pos + id.length + size.length,
  };
}

/** vint を指定バイト数で書く（EBML は非最小エンコードを許す）。 */
function encodeSize(value: number, length: number): Uint8Array | null {
  const capacity = Math.pow(2, 7 * length) - 2;
  if (value > capacity) return null;
  const out = new Uint8Array(length);
  let rest = value;
  for (let i = length - 1; i >= 0; i -= 1) {
    out[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  out[0] |= 0x80 >> (length - 1);
  return out;
}

function minimalSizeLength(value: number): number {
  for (let length = 1; length <= 8; length += 1) {
    if (value <= Math.pow(2, 7 * length) - 2) return length;
  }
  return 8;
}

function float64Bytes(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, value, false);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

interface InfoLocation {
  info: Head;
  segment: Head;
  duration: Head | null;
  timecodeScale: number;
}

function locateInfo(bytes: Uint8Array): InfoLocation | null {
  const header = readHead(bytes, 0);
  if (!header || header.id !== ID_EBML) return null;

  const segment = readHead(bytes, header.dataStart + header.size);
  if (!segment || segment.id !== ID_SEGMENT) return null;

  const segmentEnd = segment.unknownSize ? bytes.length : segment.dataStart + segment.size;
  let pos = segment.dataStart;
  while (pos < segmentEnd) {
    const child = readHead(bytes, pos);
    if (!child || child.unknownSize) return null;
    if (child.id === ID_INFO) {
      let timecodeScale = 1_000_000;
      let duration: Head | null = null;
      let inner = child.dataStart;
      const infoEnd = child.dataStart + child.size;
      while (inner < infoEnd) {
        const field = readHead(bytes, inner);
        if (!field || field.unknownSize) return null;
        if (field.id === ID_DURATION) duration = field;
        if (field.id === ID_TIMECODE_SCALE) {
          let value = 0;
          for (let i = 0; i < field.size; i += 1) value = value * 256 + bytes[field.dataStart + i];
          if (value > 0) timecodeScale = value;
        }
        inner = field.dataStart + field.size;
      }
      return { info: child, segment, duration, timecodeScale };
    }
    pos = child.dataStart + child.size;
  }
  return null;
}

/** 尺（秒）を書き込んだ WebM を返す。直せなければ元の Blob をそのまま返す。 */
export async function withWebmDuration(blob: Blob, seconds: number): Promise<Blob> {
  if (!(seconds > 0)) return blob;
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const found = locateInfo(bytes);
    if (!found) return blob;

    const scaled = (seconds * 1_000_000_000) / found.timecodeScale;

    // 既に Duration がある場合はその場で上書きするだけでよい。
    if (found.duration) {
      if (found.duration.size !== 8 && found.duration.size !== 4) return blob;
      const patched = bytes.slice();
      const view = new DataView(patched.buffer, patched.byteOffset, patched.byteLength);
      if (found.duration.size === 8) view.setFloat64(found.duration.dataStart, scaled, false);
      else view.setFloat32(found.duration.dataStart, scaled, false);
      return new Blob([patched], { type: blob.type });
    }

    // 無い場合は Info の末尾に 11 バイト差し込み、Info（と必要なら Segment）のサイズを書き直す。
    const element = concat([new Uint8Array([0x44, 0x89, 0x88]), float64Bytes(scaled)]);
    const infoSize = found.info.size + element.length;
    const infoSizeLength = Math.max(found.info.sizeLength, minimalSizeLength(infoSize));
    const encodedInfoSize = encodeSize(infoSize, infoSizeLength);
    if (!encodedInfoSize) return blob;
    const grew = element.length + (infoSizeLength - found.info.sizeLength);

    let head: Uint8Array;
    if (found.segment.unknownSize) {
      head = bytes.subarray(0, found.info.sizeStart);
    } else {
      const segmentSize = found.segment.size + grew;
      const encodedSegmentSize = encodeSize(segmentSize, found.segment.sizeLength);
      // Segment のサイズ幅を変えると SeekHead のオフセットまで狂うので、収まらなければ諦める。
      if (!encodedSegmentSize) return blob;
      head = concat([
        bytes.subarray(0, found.segment.sizeStart),
        encodedSegmentSize,
        bytes.subarray(found.segment.dataStart, found.info.sizeStart),
      ]);
    }

    const infoDataEnd = found.info.dataStart + found.info.size;
    return new Blob(
      [
        concat([
          head,
          encodedInfoSize,
          bytes.subarray(found.info.dataStart, infoDataEnd),
          element,
          bytes.subarray(infoDataEnd),
        ]),
      ],
      { type: blob.type },
    );
  } catch {
    return blob;
  }
}
