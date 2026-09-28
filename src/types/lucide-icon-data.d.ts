/**
 * lucide-react の個別アイコンの形データに、型を付けておく。
 *
 * lucide-react は React 部品だけを型付きで出していて、絵の形そのもの
 * （`__iconData`）には型が無い。canvas へ引くほうはこれが要るので、
 * ここで最小限だけ宣言する。lucide 側の名前が変わればここで落ちる。
 */
declare module 'lucide-react/dist/esm/icons/*.mjs' {
  export const __iconData: {
    name: string;
    size: number;
    node: [string, Record<string, string | number>][];
  };
  const component: unknown;
  export default component;
}
