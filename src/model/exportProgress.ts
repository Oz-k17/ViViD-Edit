/**
 * まとめ書き出しの「どこまで終わったか」の記録。
 *
 * 書き出しの途中でブラウザやアプリが落ちる・再読み込みされると、終わった分まで最初からやり直しになっていた。
 * 1 本保存するたびに記録しておき、次に開いたとき、同じ作品・同じ設定なら残りだけを書き出せるようにする。
 *
 * 1 本の書き出しの途中からは再開できない（途中まで作ったファイルは残らない）。再開は「本」の単位。
 *
 * ここは計算だけ（保存の読み書きは呼ぶ側）。
 */

export interface BatchStepRecord {
  key: string;
  label: string;
  done: boolean;
  /** 保存したファイルの名前（終わったものだけ）。 */
  filename?: string;
}

export interface BatchRecord {
  /** 作品の中身と書き出しの設定から作った印。違えば、別の書き出し。 */
  id: string;
  name: string;
  startedAt: number;
  steps: BatchStepRecord[];
}

/** 文字の列から短い印を作る（中身が同じなら同じ印）。暗号の強さは要らない。 */
export function fingerprint(text: string): string {
  let a = 5381;
  let b = 52711;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = ((a << 5) + a + c) | 0;
    b = ((b << 5) + b) ^ c;
  }
  return `${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}${text.length.toString(36)}`;
}

/** まとめ書き出しの印。作品の中身か設定が変わったら、変わる。 */
export function batchId(sequence: unknown, settings: unknown): string {
  return fingerprint(JSON.stringify([sequence, settings]));
}

export function startBatch(id: string, name: string, steps: { key: string; label: string }[], now: number): BatchRecord {
  return { id, name, startedAt: now, steps: steps.map((s) => ({ ...s, done: false })) };
}

export function markDone(record: BatchRecord, key: string, filename?: string): BatchRecord {
  return { ...record, steps: record.steps.map((s) => (s.key === key ? { ...s, done: true, filename } : s)) };
}

export function remainingSteps(record: BatchRecord): BatchStepRecord[] {
  return record.steps.filter((s) => !s.done);
}

/**
 * 続きから再開できるか。同じ作品・同じ設定で、終わった本と残った本の両方があるとき。
 * 何も終わっていなければ、最初からやるのと同じなので「再開」とは言わない。
 */
export function isResumable(record: BatchRecord | null, id: string): record is BatchRecord {
  return !!record && record.id === id && record.steps.some((s) => s.done) && record.steps.some((s) => !s.done);
}

/** 保存してあったものを読み戻すときの検査。壊れていれば null。 */
export function sanitizeBatch(raw: unknown): BatchRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<BatchRecord>;
  if (typeof r.id !== 'string' || typeof r.name !== 'string' || !Array.isArray(r.steps)) return null;
  const steps = r.steps.filter((s): s is BatchStepRecord => !!s && typeof s.key === 'string' && typeof s.label === 'string' && typeof s.done === 'boolean');
  if (steps.length === 0) return null;
  return { id: r.id, name: r.name, startedAt: typeof r.startedAt === 'number' ? r.startedAt : 0, steps };
}
