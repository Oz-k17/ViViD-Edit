const d = globalThis, a = (t) => d.postMessage(t);
let n = null, r = null, c = "";
async function i(t) {
  n || (a({ type: "stage", stage: "library" }), n = await import(
    /* @vite-ignore */
    t.libraryUrl
  ));
  const { pipeline: e, env: l } = n, o = `${t.modelId}/${t.device}/${t.localPath ?? ""}`;
  if (r && o === c) {
    a({ type: "ready", reused: !0 });
    return;
  }
  t.localPath && (l.allowRemoteModels = !1, l.allowLocalModels = !0, l.localModelPath = t.localPath), t.wasmPath && (l.backends.onnx.wasm.wasmPaths = t.wasmPath), a({ type: "stage", stage: "model" }), r = await e("automatic-speech-recognition", t.modelId, {
    device: t.device,
    // whisper で勧められている組み合わせ。
    // 符号側（encoder）を軽くしすぎると、日本語の精度が目に見えて落ちる。
    dtype: {
      encoder_model: t.device === "webgpu" ? "fp16" : "fp32",
      decoder_model_merged: "q4"
    },
    progress_callback: (s) => a({ type: "progress", progress: s })
  }), c = o, a({ type: "ready", reused: !1 });
}
async function u(t) {
  if (!r) throw new Error("モデルが読み込まれていません");
  a({ type: "stage", stage: "run" });
  const e = await r(t.audio, {
    language: t.language,
    task: "transcribe",
    // 'word' は単語ごと、true は文ごと。
    return_timestamps: t.words ? "word" : !0,
    // 30 秒ずつに切って回す。継ぎ目で言葉が切れないよう、前後 5 秒を重ねる。
    chunk_length_s: 30,
    stride_length_s: 5
  });
  a({ type: "result", text: e.text ?? "", chunks: e.chunks ?? [] });
}
d.addEventListener("message", (t) => {
  const e = t.data;
  (e.type === "load" ? i(e) : u(e)).catch((o) => {
    a({ type: "error", message: o instanceof Error ? o.message : String(o) });
  });
});
