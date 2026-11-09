import { FACE_POSITIONS, faceSource, type FacePosition, type Kit, type KitBands } from '../../model/kit';
import { useApp } from '../../store/app';

/**
 * 3 分割のレイアウトの選び方。録画によって顔（カメラ）の位置が違うので、
 * 「中心から」「顔は右下・左下・右上・左上」と、保存した「自分の型」から選ぶ。
 * 値は 'center' / 'face:<位置>' / 'kit:<型の id>'。最後に選んだものを覚えて、次の既定にする。
 */
export interface ResolvedLayout {
  sources?: Partial<KitBands>;
  /** 自分の型の見出しの体裁（型でなければ無し）。 */
  title?: Kit['title'];
  label: string;
}

export function useThreeBandLayouts() {
  const { templates, settings, updateSettings } = useApp();
  const kits = templates.filter((t) => t.kind === 'kit');
  const options: { value: string; label: string }[] = [
    { value: 'center', label: '中心から切り抜く' },
    ...FACE_POSITIONS.filter((f) => f.key !== 'center').map((f) => ({ value: `face:${f.key}`, label: f.label })),
    ...kits.map((t) => ({ value: `kit:${t.id}`, label: `自分の型: ${t.name}` })),
  ];
  const valid = (value: string | undefined) => !!value && options.some((o) => o.value === value);
  // 前に選んだもの → いちばん新しい自分の型 → 中心から、の順で既定にする。
  const lastKit = kits[kits.length - 1];
  const defaultValue = valid(settings.threeBandLayout)
    ? settings.threeBandLayout!
    : lastKit
      ? `kit:${lastKit.id}`
      : 'center';

  const resolve = (value: string): ResolvedLayout => {
    const label = options.find((o) => o.value === value)?.label ?? '中心から切り抜く';
    if (value.startsWith('face:')) {
      return { sources: { bottom: faceSource(value.slice(5) as FacePosition) }, label };
    }
    if (value.startsWith('kit:')) {
      const t = kits.find((k) => k.id === value.slice(4));
      if (t?.kind === 'kit') return { sources: t.kit.bands, title: t.kit.title, label };
    }
    return { label };
  };

  const remember = (value: string) => updateSettings({ threeBandLayout: value });
  return { options, defaultValue, resolve, remember };
}
