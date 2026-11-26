/**
 * 色調整を描く所。`model/color.ts` が焼いた 3D LUT を、WebGL で 1 コマに 1 回引く。
 *
 * Canvas 2D のフィルタ（`ctx.filter`）では、暗部だけ青く・明部だけ橙に、のような色の分け方や
 * 読み込んだ LUT は作れないので、ここだけ WebGL を使う。WebGL が無い・失われた端末では
 * null を返し、描く側は色を変えずに描く（インスペクタで知らせる）。
 *
 * 絵は「描く大きさ」まで縮めてから色を変える。4K の素材でも、プレビューは画面の大きさ、
 * 書き出しは出力の大きさまでしか手間をかけない（iPad で 4K をそのまま GPU に載せると重い）。
 */
import { BAKE_SIZE, bakeLut, gradeKey, isNeutralGrade, type ColorGrade } from '../model/color';

const VERT = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

// LUT は「横に青の段を並べた」2D の絵（幅 = size*size、高さ = size）。赤と緑は絵の中で線形に補間され、
// 青は隣り合う 2 段を引いて混ぜる。
const FRAG = `
precision highp float;
uniform sampler2D u_img;
uniform sampler2D u_lut;
uniform float u_size;
varying vec2 v_uv;
vec3 lut(vec3 c) {
  float s = u_size;
  float b = c.b * (s - 1.0);
  float b0 = floor(b);
  float b1 = min(b0 + 1.0, s - 1.0);
  float f = b - b0;
  float x = (c.r * (s - 1.0) + 0.5) / (s * s);
  float y = (c.g * (s - 1.0) + 0.5) / s;
  vec3 lo = texture2D(u_lut, vec2(x + b0 / s, y)).rgb;
  vec3 hi = texture2D(u_lut, vec2(x + b1 / s, y)).rgb;
  return mix(lo, hi, f);
}
void main() {
  vec4 px = texture2D(u_img, v_uv);
  gl_FragColor = vec4(lut(clamp(px.rgb, 0.0, 1.0)), px.a);
}`;

interface Gl {
  canvas: HTMLCanvasElement;
  gl: WebGLRenderingContext;
  program: WebGLProgram;
  image: WebGLTexture;
  uSize: WebGLUniformLocation | null;
}

let state: Gl | null = null;
let failed = false;
/** 焼いた表の置き場。設定ごとに 1 枚。多くのクリップで別々の色を使っても膨らみすぎないよう、古いものから捨てる。 */
const luts = new Map<string, WebGLTexture>();
const LUT_LIMIT = 12;

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
}

function setup(): Gl | null {
  if (state && !state.gl.isContextLost()) return state;
  if (state) {
    // 文脈が失われた（裏に回った iPad など）。焼いた表も一緒に失われているので作り直す。
    state = null;
    luts.clear();
  }
  if (failed || typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false });
  if (!gl) {
    failed = true;
    return null;
  }
  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
  const program = gl.createProgram();
  if (!vs || !fs || !program) {
    failed = true;
    return null;
  }
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    failed = true;
    return null;
  }
  gl.useProgram(program);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const pos = gl.getAttribLocation(program, 'a_pos');
  gl.enableVertexAttribArray(pos);
  gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
  gl.uniform1i(gl.getUniformLocation(program, 'u_img'), 0);
  gl.uniform1i(gl.getUniformLocation(program, 'u_lut'), 1);
  const image = gl.createTexture();
  if (!image) {
    failed = true;
    return null;
  }
  gl.bindTexture(gl.TEXTURE_2D, image);
  // 絵は 2 の累乗でないことが多い。WebGL 1 ではこの 3 つを決めないと黒く出る。
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  state = { canvas, gl, program, image, uSize: gl.getUniformLocation(program, 'u_size') };
  return state;
}

function lutTexture(s: Gl, grade: ColorGrade): WebGLTexture | null {
  const key = gradeKey(grade);
  const found = luts.get(key);
  if (found) {
    luts.delete(key);
    luts.set(key, found);
    return found;
  }
  const { gl } = s;
  const size = BAKE_SIZE;
  const baked = bakeLut(grade, size);
  // .cube の並び（r → g → b）を、横に青の段を並べた絵の並び（行 = g、列 = b*size + r）へ。
  const atlas = new Uint8Array(baked.length);
  for (let b = 0; b < size; b += 1) {
    for (let g = 0; g < size; g += 1) {
      for (let r = 0; r < size; r += 1) {
        const from = (r + g * size + b * size * size) * 3;
        const to = (g * size * size + b * size + r) * 3;
        atlas[to] = baked[from];
        atlas[to + 1] = baked[from + 1];
        atlas[to + 2] = baked[from + 2];
      }
    }
  }
  const tex = gl.createTexture();
  if (!tex) return null;
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, size * size, size, 0, gl.RGB, gl.UNSIGNED_BYTE, atlas);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.activeTexture(gl.TEXTURE0);
  luts.set(key, tex);
  while (luts.size > LUT_LIMIT) {
    const oldest = luts.keys().next().value as string;
    gl.deleteTexture(luts.get(oldest) ?? null);
    luts.delete(oldest);
  }
  return tex;
}

/** 色調整が使える端末か（インスペクタで「この端末では効きません」を出すため）。 */
export function colorGradingSupported(): boolean {
  return setup() !== null;
}

/**
 * 色を変えた絵を返す。変える物が無い・WebGL が使えないときは null（描く側は元の絵を使う）。
 * 返す canvas は使い回しなので、**受け取ったらすぐ描くこと**（次に呼ぶと中身が替わる）。
 */
export function gradeFrame(
  frame: CanvasImageSource,
  size: { width: number; height: number },
  grade: ColorGrade | null | undefined,
  maxEdge: number,
): { canvas: HTMLCanvasElement; width: number; height: number } | null {
  if (!grade || isNeutralGrade(grade)) return null;
  const s = setup();
  if (!s) return null;
  const k = Math.min(1, Math.max(16, maxEdge) / Math.max(size.width, size.height));
  const width = Math.max(1, Math.round(size.width * k));
  const height = Math.max(1, Math.round(size.height * k));
  const { gl, canvas } = s;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const lut = lutTexture(s, grade);
  if (!lut) return null;
  try {
    gl.viewport(0, 0, width, height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, s.image);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame as TexImageSource);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, lut);
    gl.uniform1f(s.uSize, BAKE_SIZE);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.activeTexture(gl.TEXTURE0);
  } catch {
    // 読み込み前の動画など。次のコマで描ければよい。
    return null;
  }
  return { canvas, width, height };
}
