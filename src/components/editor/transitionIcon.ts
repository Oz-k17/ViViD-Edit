/**
 * トランジションとアイコンの対応。
 *
 * `model/types.ts` は import を 1 つも持たない純粋なデータ層なので、
 * そこに UI のアイコン名を持ち込まない。表示の都合はこちら側で持つ。
 */
import type { IconName } from '../Icon';
import type { TransitionType } from '../../model/types';

export const TRANSITION_ICON: Record<TransitionType, IconName> = {
  none: 'tr-none',
  dissolve: 'tr-dissolve',
  fade: 'tr-fade',
  slide: 'tr-slide',
  wipe: 'tr-wipe',
  flash: 'tr-flash',
};
