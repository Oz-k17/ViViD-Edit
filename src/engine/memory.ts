/**
 * メモリが足りなくなったときの手当て。
 *
 * iPad / iPhone のアプリ版（WKWebView）は、使えるメモリの上限が決まっていない。端末の空きしだいで、
 * 超えると表示プロセスごと終了させられ、画面が読み込み直される。終了の前には、たいてい「メモリ警告」が来る。
 * Swift 側がその警告を受けて、Web 側へ `vivid-memory-warning` を送る（`EditorWebView.swift`）。
 * ここで受けて、いま要らないものを手放す。
 *
 * アプリが裏に回ったときも同じ手当てをする。裏に回ったアプリは、メモリを多く使っているほど先に終了させられるため。
 */
import { player } from './player';

const COUNT_KEY = 'vivid-edit.memoryWarnings';

/** 受けたメモリ警告の数（診断の画面に出す。端末で何が起きているかの手がかり）。 */
export function memoryWarningCount(): number {
  try {
    return Number(localStorage.getItem(COUNT_KEY) ?? '0');
  } catch {
    return 0;
  }
}

function countWarning() {
  try {
    localStorage.setItem(COUNT_KEY, String(memoryWarningCount() + 1));
    localStorage.setItem(COUNT_KEY + '.at', new Date().toISOString());
  } catch {
    /* 数えられなくても手当てはする */
  }
}

/** 手放せるものを手放す。手放した動画要素の数を返す。 */
export function releaseMemory(): number {
  return player.trimMemory();
}

let installed = false;

export function installMemoryGuards() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('vivid-memory-warning', () => {
    countWarning();
    releaseMemory();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') releaseMemory();
  });
}
