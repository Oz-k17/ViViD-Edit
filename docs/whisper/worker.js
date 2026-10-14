const c = globalThis, a = (e) => c.postMessage(e);
let l = null, n = null, s = "";
async function i(e) {
  l || (a({ type: "stage", stage: "library" }), l = await import(
    /* @vite-ignore */
    e.libraryUrl
  ));
  const { pipeline: t, env: r } = l, o = `${e.modelId}/${e.device}/${e.localPath ?? ""}`;
  if (n && o === s) {
    a({ type: "ready", reused: !0 });
    return;
  }
  e.localPath && (r.allowRemoteModels = !1, r.allowLocalModels = !0, r.localModelPath = e.localPath), e.wasmPath && (r.backends.onnx.wasm.wasmPaths = e.wasmPath), a({ type: "stage", stage: "model" }), n = await t("automatic-speech-recognition", e.modelId, {
    device: e.device,
    // whisper で勧められている組み合わせ。
    // 符号側（encoder）を軽くしすぎると、日本語の精度が目に見えて落ちる。
    dtype: {
      encoder_model: e.device === "webgpu" ? "fp16" : "fp32",
      decoder_model_merged: "q4"
    },
    progress_callback: (d) => a({ type: "progress", progress: d })
  }), s = o, a({ type: "ready", reused: !1 });
}
async function u(e) {
  if (!n) throw new Error("モデルが読み込まれていません");
  a({ type: "stage", stage: "run" });
  const t = await n(e.audio, {
    language: e.language,
    task: "transcribe",
    // 'word' は単語ごと、true は文ごと。
    return_timestamps: e.words ? "word" : !0,
    // 30 秒ずつに切って回す。継ぎ目で言葉が切れないよう、前後 5 秒を重ねる。
    chunk_length_s: 30,
    stride_length_s: 5,
    // 道を増やすと取り違えが減る。手順書の仕上げも 5 で回している。
    num_beams: Math.max(1, e.beams),
    // 直前の出力を次の手がかりにしない。ここを繋ぐと、いちど言葉を作り始めたとき
    // それを手がかりにして延々と作り続ける（同じ行が何十も並ぶのはこれ）。
    condition_on_previous_text: !1
  });
  a({ type: "result", text: t.text ?? "", chunks: t.chunks ?? [] });
}
globalThis.addEventListener(
  "unhandledrejection",
  (e) => {
    const t = e.reason;
    a({ type: "error", message: t instanceof Error ? t.message : String(t) });
  }
);
c.addEventListener("message", (e) => {
  const t = e.data;
  (t.type === "load" ? i(t) : u(t)).catch((o) => {
    a({ type: "error", message: o instanceof Error ? o.message : String(o) });
  });
});
