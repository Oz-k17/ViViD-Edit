/**
 * 持ち出しファイルに出てくる形。
 *
 * 本体（`src/engine/media.ts` / `src/engine/project-file.ts`）の形を、
 * **運ぶのに要るところだけ**写してある。写した理由は 2 つ。
 *
 *  - 本体の `MediaAsset` は `url`（Blob URL）を持つので、そのままでは Node で扱えない。
 *  - 実体は `Blob` で持たれていて、**大きさを聞くのはタダだが中身を読むのは高い**。
 *    この差が今回いちばん効くところなので、型のうえでも分けておく（`BodySource`）。
 *
 * プロジェクト側（`Project`）は本体の型をそのまま使いたいが、
 * ここで要るのは「どの素材を使っているか」を数えられる最小限だけなので、
 * 構造だけ合わせた軽い形にしてある（本体の `Project` はこれを満たす）。
 */

export type MediaKind = 'video' | 'image' | 'audio';

/** 本体の `Clip` のうち、素材を数えるのに要る所だけ。 */
export interface PackClip {
  mediaId: string | null;
  text?: { content: string } | null;
}

/** 本体の `Project` のうち、運ぶのに要る所だけ。 */
export interface PackProject {
  name: string;
  sequence: {
    tracks: unknown[];
    clips: PackClip[];
  };
}

/**
 * 素材の覚え書き。実体は持たない。
 *
 * `src` があるものが**参照素材**（NAS などを指しているだけ）、
 * 無いものが**取り込み素材**（実体がその人のブラウザの中にしか無い）。
 * 本体と同じ区別で、運べるかどうかがここで決まる。
 */
export interface PackAssetMeta {
  id: string;
  name: string;
  kind: MediaKind;
  duration: number;
  width: number;
  height: number;
  thumbnail: string;
  size: number;
  folder: string;
  createdAt: number;
  src?: string;
  /** 実体の種類（`video/mp4` など）。埋めた実体を開き直すときに要る。 */
  mime?: string;
}

/**
 * 実体の持ち主。
 *
 * ブラウザでは `Blob`、ここでは生バイト。**`size` はタダ、`bytes` は高い**という
 * 差をそのまま型にしてある。詰める計画（`plan.ts`）は `size` しか呼ばない。
 */
export interface BodySource {
  /** バイト数。実体が無ければ undefined。 */
  size(id: string): number | undefined;
  /** 実体。実際に書き出すときだけ呼ぶ。 */
  bytes(id: string): Promise<Uint8Array>;
}

/** ファイルの中から、要る所だけを拾って読む口。ブラウザでは `Blob.slice`。 */
export interface PackReader {
  /** ファイル全体のバイト数。 */
  size: number;
  /** `[start, end)` を読む。 */
  read(start: number, end: number): Promise<Uint8Array>;
}

/** 読み書きで形が合わなかったときに投げる。本体の `ProjectFileError` と同じ役。 */
export class PackError extends Error {}
