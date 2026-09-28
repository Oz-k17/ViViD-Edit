/**
 * `import './factory'` のように拡張子を省いた書き方を、Node に解かせるための橋渡し。
 *
 * ブラウザ向けの束ね役（Vite）は拡張子を補ってくれるが、Node は補わない。
 * このせいで「本体のコードを Node からそのまま呼んで確かめる」ができなかった。
 * 解決に失敗したときだけ `.ts` を足して試す、という後追いにしてあるので、
 * 普通に解ける import の邪魔はしない。
 */
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    if (specifier.startsWith('.') && !/\.[a-zA-Z]+$/.test(specifier)) {
      return next(`${specifier}.ts`, context);
    }
    throw error;
  }
}
