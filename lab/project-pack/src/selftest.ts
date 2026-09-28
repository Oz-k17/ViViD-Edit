/**
 * 持ち出し／取り込みの検算。
 *
 * ブラウザも素材も要らない（合成したバイト列だけ）。
 * 見ているのは 3 つ——**何を運ぶかの決め方**（`plan.ts`）、
 * **並べ方と読み方**（`container.ts`）、**比べる相手**（`json-pack.ts`）。
 *
 * 意地悪な側を先に置いてある。壊れたファイル・嘘をつく見出し・日本語の名前・
 * 0 バイトの素材。これが無いと「うまくいった」が
 * 「自分に都合のいい素材で試しただけ」になる。
 */

import {
  locateBody,
  layoutPack,
  openPack,
  PACK_PREAMBLE,
  readBody,
  readerFromBytes,
  realizePack,
  type PackHeader,
} from './container.ts';
import { base64Length, buildJsonPack, jsonPackBody, parseJsonPack } from './json-pack.ts';
import { planPack } from './plan.ts';
import { assetMap, clip, makeProject, memoryBodies, meta, pseudoBytes } from './scenarios.ts';
import { PackError, type PackAssetMeta, type PackReader } from './types.ts';

export interface Result {
  ok: boolean;
  name: string;
  detail?: string;
}

// ---------- 検算だけで使う道具 ----------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** 検算用の base64（小さい入力にしか使わない。速さは測る側が Buffer でやる）。 */
function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : '=';
    out += i + 2 < bytes.length ? B64[c & 63] : '=';
  }
  return out;
}

function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let at = 0;
  for (const ch of clean) {
    acc = (acc << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at] = (acc >> bits) & 0xff;
      at += 1;
    }
  }
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** 読んだバイト数を数える口。「要る所しか読まない」を測るために要る。 */
function countingReader(bytes: Uint8Array): PackReader & { bytesRead: number; calls: number } {
  const inner = readerFromBytes(bytes);
  const wrapper = {
    size: inner.size,
    bytesRead: 0,
    calls: 0,
    read: async (start: number, end: number) => {
      wrapper.bytesRead += Math.max(0, end - start);
      wrapper.calls += 1;
      return inner.read(start, end);
    },
  };
  return wrapper;
}

/** 見出しを差し替えたファイルを組む（嘘をつく見出しを作るため）。 */
function packWith(header: unknown, bodyBytes: Uint8Array, magic = 'VIVIDPK1'): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const prefix = new Uint8Array(PACK_PREAMBLE + json.length);
  for (let i = 0; i < 8; i += 1) prefix[i] = magic.charCodeAt(i);
  new DataView(prefix.buffer).setUint32(8, json.length, true);
  prefix.set(json, PACK_PREAMBLE);
  return concat([prefix, bodyBytes]);
}

function baseHeader(over: Partial<PackHeader> = {}): PackHeader {
  return {
    app: 'vivid-edit',
    pack: 1,
    savedAt: 0,
    project: makeProject([clip('a0')]),
    assets: [],
    bodies: [],
    localOnly: [],
    ...over,
  };
}

async function threw(work: () => Promise<unknown>): Promise<string | null> {
  try {
    await work();
    return null;
  } catch (error) {
    return error instanceof PackError ? error.message : `PackError ではない: ${String(error)}`;
  }
}

// ---------- 検算 ----------

export async function runSelfTest(): Promise<Result[]> {
  const out: Result[] = [];
  const add = (ok: boolean, name: string, detail?: string) => out.push({ ok, name, detail });

  // ===== 何を運ぶかの決め方 =====

  {
    const used = meta({ id: 'u' });
    const idle = meta({ id: 'x' });
    const bodies = memoryBodies(new Map([['u', pseudoBytes(100)], ['x', pseudoBytes(9999)]]));
    const plan = planPack(makeProject([clip('u')]), assetMap([used, idle]), bodies);
    add(
      plan.entries.length === 1 && plan.embedBytes === 100,
      '使っていない素材は運ばない（本体の usedMediaIds と同じ）',
      `${plan.entries.length} 個 / ${plan.embedBytes} バイト`,
    );
    add(bodies.reads.length === 0, '詰める計画は実体を 1 バイトも読まない（大きさだけ聞く）');
  }

  {
    const a = meta({ id: 'a' });
    const bodies = memoryBodies(new Map([['a', pseudoBytes(1000)]]));
    const plan = planPack(makeProject([clip('a'), clip('a'), clip('a')]), assetMap([a]), bodies);
    add(
      plan.entries.length === 1 && plan.embedBytes === 1000,
      '同じ素材を 3 クリップで使っても実体は 1 つだけ入る',
      `${plan.embedBytes} バイト（3 つなら 3000）`,
    );
  }

  {
    const pic = meta({ id: 'e1', kind: 'image', name: '絵文字.png' });
    const bodies = memoryBodies(new Map([['e1', pseudoBytes(64)]]));
    const plan = planPack(makeProject([clip(null, 'やった{{emoji:e1}}ね')]), assetMap([pic]), bodies);
    add(plan.embedBytes === 64, 'テロップに差し込んだ絵文字の素材も運ぶ', `${plan.embedBytes} バイト`);
  }

  {
    // 参照素材は相手にも見えているので、実体を持っていても入れない。
    const ref = meta({ id: 'r', src: 'media/a.mp4' });
    const bodies = memoryBodies(new Map([['r', pseudoBytes(5_000_000)]]));
    const plan = planPack(makeProject([clip('r')]), assetMap([ref]), bodies);
    add(
      plan.entries[0].disposition === 'ref' && plan.embedBytes === 0,
      '参照素材は、実体が手元にあっても埋めない（二重に運ばない）',
      `${plan.entries[0].disposition} / ${plan.embedBytes} バイト`,
    );
  }

  {
    const gone = meta({ id: 'g', name: '手元だけ.mov' });
    const plan = planPack(makeProject([clip('g')]), assetMap([gone]), memoryBodies(new Map()));
    add(
      plan.dropped.length === 1 && plan.dropped[0] === '手元だけ.mov',
      '実体が無い取り込み素材は、黙って落とさず名前を控える',
      plan.dropped.join('・'),
    );
  }

  {
    const big = meta({ id: 'b1', name: '大.mp4' });
    const small = meta({ id: 'b2', name: '小.wav', kind: 'audio' });
    const bodies = memoryBodies(new Map([['b1', pseudoBytes(1000)], ['b2', pseudoBytes(10)]]));
    const plan = planPack(makeProject([clip('b1'), clip('b2')]), assetMap([big, small]), bodies, {
      embedLimit: 500,
    });
    add(
      plan.embedBytes === 10 && plan.dropped[0] === '大.mp4',
      '上限を超える素材は落とし、入る素材は入れる（全部やめない）',
      `${plan.embedBytes} バイト / 落ち: ${plan.dropped.join('・')}`,
    );
  }

  {
    // 素材ごと消してしまった場合。相手の側でも同じく欠けるので、蒸し返さない。
    const plan = planPack(makeProject([clip('nope')]), assetMap([]), memoryBodies(new Map()));
    add(
      plan.entries.length === 0 && plan.dropped.length === 0,
      'もう手元に無い素材は、名前も出さない（本体と同じ扱い）',
    );
  }

  {
    // クリップの並びを変えても実体の位置が動かない＝2 回書き出したら同じファイル。
    const metas = [meta({ id: 'z' }), meta({ id: 'a' }), meta({ id: 'm' })];
    const bodies = memoryBodies(
      new Map([['z', pseudoBytes(300, 1)], ['a', pseudoBytes(100, 2)], ['m', pseudoBytes(200, 3)]]),
    );
    const one = layoutPack(makeProject([clip('z'), clip('a'), clip('m')]), assetMap(metas), bodies);
    const two = layoutPack(makeProject([clip('m'), clip('z'), clip('a')]), assetMap(metas), bodies);
    const order = (l: typeof one) => l.order.map((o) => `${o.id}@${o.offset}`).join(' ');
    add(
      order(one) === order(two),
      'クリップを並べ替えても実体の位置が動かない（id 順に詰める）',
      order(one),
    );
  }

  // ===== 並べ方と読み方 =====

  {
    const metas = [meta({ id: 'v' }), meta({ id: 'w', kind: 'audio', name: '音.wav' })];
    const raw = new Map([['v', pseudoBytes(4096, 7)], ['w', pseudoBytes(1234, 8)]]);
    const bodies = memoryBodies(raw);
    const project = makeProject([clip('v'), clip('w')]);
    const layout = layoutPack(project, assetMap(metas), bodies);
    const file = concat(await realizePack(layout, bodies));

    add(
      file.length === layout.totalBytes,
      '書き出す前に出した「何バイトになるか」が実際と合う',
      `${layout.totalBytes} バイト`,
    );

    const reader = readerFromBytes(file);
    const opened = await openPack(reader);
    const gotV = await readBody(reader, opened, 'v');
    const gotW = await readBody(reader, opened, 'w');
    add(
      !!gotV && !!gotW && same(gotV, raw.get('v')!) && same(gotW, raw.get('w')!),
      '往復して実体が 1 バイトも変わらない',
      `${gotV?.length} / ${gotW?.length} バイト`,
    );
    add(
      opened.header.project.name === project.name && opened.outOfRange.length === 0,
      'プロジェクトも一緒に戻る（はみ出した実体は無し）',
    );
  }

  {
    // 日本語の素材名。JSON の文字数と UTF-8 のバイト数がずれるので、
    // 見出しの長さを文字数で書いていると実体の頭が食われる。
    const metas = [meta({ id: 'jp', name: '打ち合わせ_本編_最終版.mp4', folder: '素材／撮影' })];
    const raw = new Map([['jp', pseudoBytes(777, 9)]]);
    const bodies = memoryBodies(raw);
    const layout = layoutPack(makeProject([clip('jp')]), assetMap(metas), bodies);
    const json = JSON.stringify(layout.header);
    const charLen = json.length;
    const byteLen = new TextEncoder().encode(json).length;
    const file = concat(await realizePack(layout, bodies));
    const reader = readerFromBytes(file);
    const opened = await openPack(reader);
    const got = await readBody(reader, opened, 'jp');
    add(
      byteLen > charLen && !!got && same(got, raw.get('jp')!),
      '日本語の素材名でも実体の頭がずれない（長さをバイトで書いている）',
      `見出し ${charLen} 文字 = ${byteLen} バイト（差 ${byteLen - charLen}）`,
    );
  }

  {
    // 0 バイトの素材。length 0 は「無い」と区別しないと、空のファイルが消える。
    const metas = [meta({ id: 'z0', name: '空.wav', kind: 'audio' }), meta({ id: 'z1' })];
    const raw = new Map([['z0', new Uint8Array(0)], ['z1', pseudoBytes(16, 4)]]);
    const bodies = memoryBodies(raw);
    const layout = layoutPack(makeProject([clip('z0'), clip('z1')]), assetMap(metas), bodies);
    const file = concat(await realizePack(layout, bodies));
    const reader = readerFromBytes(file);
    const opened = await openPack(reader);
    const got = await readBody(reader, opened, 'z0');
    add(
      got !== null && got.length === 0 && opened.header.bodies.length === 2,
      '0 バイトの素材も「入っている」扱いで戻る（null と区別する）',
      `${opened.header.bodies.length} 個 / 先頭 ${got?.length} バイト`,
    );
  }

  {
    // 要る 1 つだけを読む。ここが JSON に埋める形との決定的な差。
    const metas = Array.from({ length: 8 }, (_, i) => meta({ id: `c${i}` }));
    const raw = new Map(metas.map((m, i) => [m.id, pseudoBytes(256 * 1024, i + 1)]));
    const bodies = memoryBodies(raw);
    const layout = layoutPack(makeProject(metas.map((m) => clip(m.id))), assetMap(metas), bodies);
    const file = concat(await realizePack(layout, bodies));
    const reader = countingReader(file);
    const opened = await openPack(reader);
    const before = reader.bytesRead;
    await readBody(reader, opened, 'c5');
    const forOne = reader.bytesRead - before;
    add(
      forOne === 256 * 1024 && before < 4096,
      '実体 1 つを取り出すのに、その 1 つぶんしか読まない',
      `見出しに ${before} バイト / 実体に ${forOne} バイト（ファイルは ${file.length} バイト）`,
    );
  }

  {
    // 切って渡された口。DataView に byteOffset を渡していないと、ここで見出しの長さを読み違える。
    const metas = [meta({ id: 'off' })];
    const raw = new Map([['off', pseudoBytes(333, 11)]]);
    const bodies = memoryBodies(raw);
    const layout = layoutPack(makeProject([clip('off')]), assetMap(metas), bodies);
    const file = concat(await realizePack(layout, bodies));
    const padded = new Uint8Array(64 + file.length);
    padded.set(file, 64);
    const reader = readerFromBytes(padded.subarray(64));
    const opened = await openPack(reader);
    const got = await readBody(reader, opened, 'off');
    add(!!got && same(got, raw.get('off')!), '切って渡された口（subarray）でも見出しの長さを読み違えない');
  }

  // ===== 壊れたファイル =====

  add(
    (await threw(() => openPack(readerFromBytes(new Uint8Array(4))))) !== null,
    '短すぎるファイルは断る',
    (await threw(() => openPack(readerFromBytes(new Uint8Array(4))))) ?? '',
  );

  {
    const msg = await threw(() => openPack(readerFromBytes(packWith(baseHeader(), new Uint8Array(0), 'NOTAPACK'))));
    add(msg !== null && msg.includes('ではないようです'), '目印が違うファイルは断る', msg ?? '');
  }

  {
    // 見出しの長さが実際より大きい＝途中で切れたファイル。
    const good = packWith(baseHeader(), pseudoBytes(100));
    const cut = good.subarray(0, PACK_PREAMBLE + 4);
    const msg = await threw(() => openPack(readerFromBytes(cut)));
    add(msg !== null && msg.includes('はみ出し'), '途中で切れたファイルは断る（見出しが読み切れない）', msg ?? '');
  }

  {
    const broken = new Uint8Array(PACK_PREAMBLE + 5);
    for (let i = 0; i < 8; i += 1) broken[i] = 'VIVIDPK1'.charCodeAt(i);
    new DataView(broken.buffer).setUint32(8, 5, true);
    broken.set(new TextEncoder().encode('{"a":'), PACK_PREAMBLE);
    const msg = await threw(() => openPack(readerFromBytes(broken)));
    add(msg !== null && msg.includes('見出し'), '見出しが JSON でなければ断る', msg ?? '');
  }

  {
    const msg = await threw(() => openPack(readerFromBytes(packWith(baseHeader({ pack: 99 }), new Uint8Array(0)))));
    add(msg !== null && msg.includes('新しい版'), '新しい版のファイルは「新しい版だ」と言って断る', msg ?? '');
  }

  {
    const bad = { ...baseHeader(), project: { name: 'x', sequence: { clips: [] } } };
    const msg = await threw(() => openPack(readerFromBytes(packWith(bad, new Uint8Array(0)))));
    add(msg !== null && msg.includes('トラック'), 'プロジェクトの形が壊れていれば断る', msg ?? '');
  }

  {
    // 嘘をつく見出し。1 つが範囲外でも、残りは開ける。
    const assets: PackAssetMeta[] = [
      meta({ id: 'ok', name: '入っている.mp4' }),
      meta({ id: 'liar', name: 'はみ出し.mp4' }),
      meta({ id: 'neg', name: '負の位置.mp4' }),
      meta({ id: 'frac', name: '小数.mp4' }),
    ];
    const body = pseudoBytes(50, 12);
    const header = baseHeader({
      assets,
      bodies: [
        { id: 'ok', offset: 0, length: 50 },
        { id: 'liar', offset: 40, length: 999 },
        { id: 'neg', offset: -8, length: 4 },
        { id: 'frac', offset: 0.5, length: 4 },
      ],
    });
    const reader = readerFromBytes(packWith(header, body));
    const opened = await openPack(reader);
    const got = await readBody(reader, opened, 'ok');
    add(
      opened.header.bodies.length === 1 &&
        opened.outOfRange.length === 3 &&
        !!got &&
        same(got, body) &&
        locateBody(opened, 'liar') === null,
      '嘘をつく見出しは、その素材だけ落として名前を出す（残りは開ける）',
      `落ち: ${opened.outOfRange.join('・')}`,
    );
  }

  {
    // 境界値。実体域の末尾ぴったりは通す（1 バイトでも越えたら落とす）。
    const body = pseudoBytes(40, 13);
    const fit = baseHeader({ assets: [meta({ id: 'fit' })], bodies: [{ id: 'fit', offset: 10, length: 30 }] });
    const over = baseHeader({ assets: [meta({ id: 'over' })], bodies: [{ id: 'over', offset: 10, length: 31 }] });
    const a = await openPack(readerFromBytes(packWith(fit, body)));
    const b = await openPack(readerFromBytes(packWith(over, body)));
    add(
      a.header.bodies.length === 1 && b.header.bodies.length === 0,
      '実体域の末尾ぴったりは通し、1 バイト越えたら落とす',
      `ぴったり ${a.header.bodies.length} 個 / 1 バイト越え ${b.header.bodies.length} 個`,
    );
  }

  // ===== 比べる相手（JSON に base64） =====

  {
    const metas = [meta({ id: 'j1' }), meta({ id: 'j2', src: 'media/ref.mp4' })];
    const raw = new Map([['j1', pseudoBytes(999, 14)], ['j2', pseudoBytes(10, 15)]]);
    const bodies = memoryBodies(raw);
    const built = await buildJsonPack(makeProject([clip('j1'), clip('j2')]), assetMap(metas), bodies, toBase64);
    const parsed = parseJsonPack(built.text);
    const got = jsonPackBody(parsed, 'j1', fromBase64);
    add(
      !!got && same(got, raw.get('j1')!) && jsonPackBody(parsed, 'j2', fromBase64) === null,
      'JSON に base64 で埋める形も往復する（参照素材には実体を入れない）',
      `${got?.length} バイト`,
    );
  }

  {
    for (const n of [0, 1, 2, 3, 4, 100, 3001]) {
      const got = toBase64(pseudoBytes(n, 3)).length;
      if (got !== base64Length(n)) {
        add(false, 'base64 の長さを、変換せずに数えられる', `${n} バイト → 数え ${base64Length(n)} / 実際 ${got}`);
        break;
      }
      if (n === 3001) add(true, 'base64 の長さを、変換せずに数えられる（0〜3001 バイトで一致）');
    }
  }

  {
    // 壁に当たる構成は、実体を base64 に直す**前に**断る。
    // 上限を小さく渡して、同じ道を短い素材で通す（400MB 積まずに確かめられる）。
    const metas = [meta({ id: 'huge', name: '長い.mp4' })];
    const bodies = memoryBodies(new Map([['huge', pseudoBytes(900, 16)]]));
    const msg = await threw(() =>
      buildJsonPack(makeProject([clip('huge')]), assetMap(metas), bodies, toBase64, {}, 1000),
    );
    add(
      msg !== null && msg.includes('大きすぎて'),
      '上限を越える構成は、base64 に直す前に断る（落ちる瞬間がいちばん重いので）',
      msg ?? '',
    );
    add(bodies.reads.length === 0, '断ったときは実体を 1 バイトも読んでいない');
  }

  {
    // 壁の場所。V8 の文字列の上限は環境の定数なので、ここでは比だけを確かめる。
    const perMb = base64Length(1024 * 1024) / (1024 * 1024);
    const wallMb = Math.floor((536_870_888 / perMb) / (1024 * 1024));
    add(
      // 端数（= の詰め物）で 4/3 をわずかに上回るので、ぴったりは見ない。
      Math.abs(perMb - 4 / 3) < 1e-5 && wallMb > 380 && wallMb < 390,
      'base64 は 1.3333 倍。V8 の文字列の上限から天井は 384MB あたり',
      `1 バイトあたり ${perMb.toFixed(4)} 文字 / 天井 ${wallMb}MB`,
    );
  }

  return out;
}
