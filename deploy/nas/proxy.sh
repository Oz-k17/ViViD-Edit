#!/bin/sh
# 共有素材の動画から、プレビュー用の軽い複製（軽量版）を作り続ける。Docker の ffmpeg コンテナで動かす。
#
# 長い・大きい動画（3 時間の 1080p など）は、ブラウザで再生・シークするだけで重い。
# そこで NAS 側で ffmpeg を使って、長辺 640px・1 秒ごとにキーフレームの小さな複製を作っておく。
# ViViD Edit は、素材と同じ場所に複製があれば、プレビューと再生にそちらを使う。
# 書き出しと自動解析は元の動画を使うので、仕上がりの画質は落ちない。
#
# 置き場所の規則（アプリ側の `serverProxyUrl` と揃えてある。変えるなら両方）:
#   /srv/media/a/b.mp4           → /srv/proxy/media/a/b.mp4.proxy.mp4
#   /srv/media-personal/x/y.mov  → /srv/proxy/media-personal/x/y.mov.proxy.mp4
#   （nginx は /proxy/ をそのまま /srv/proxy/ として配る）
#
# 環境変数（すべて省略できる）:
#   ROOTS          見る場所。"URL 上の名前=ディレクトリ" を空白区切りで。
#                  既定: "media=/srv/media media-personal=/srv/media-personal"
#   OUT            複製の置き場。既定: /srv/proxy
#   MIN_SECONDS    これより短くて、かつ小さい動画は作らない。既定: 180
#   MAX_SIDE       長辺の上限。既定: 640
#   SCAN_SECONDS   見回る間隔。既定: 60
#   QUIET_SECONDS  更新から何秒たったら「コピー完了」とみなすか。既定: 30
#   CRF            画質（大きいほど軽くて粗い）。既定: 30
#   THREADS        ffmpeg の糸の数。既定: 2（NAS の他の仕事を邪魔しない）
#   FAIL_RETRY     失敗した動画を、何秒たったらもう一度試すか。既定: 3600（元が更新されたらすぐ試す）
#   CLEAN          1 なら、元が消えた複製を片付ける。既定: 1
#   ONCE           1 なら、1 回見回って終わる（試験用）。既定: 0

ROOTS="${ROOTS:-media=/srv/media media-personal=/srv/media-personal}"
OUT="${OUT:-/srv/proxy}"
MIN_SECONDS="${MIN_SECONDS:-180}"
MAX_SIDE="${MAX_SIDE:-640}"
SCAN_SECONDS="${SCAN_SECONDS:-60}"
QUIET_SECONDS="${QUIET_SECONDS:-30}"
CRF="${CRF:-30}"
THREADS="${THREADS:-2}"
FAIL_RETRY="${FAIL_RETRY:-3600}"
CLEAN="${CLEAN:-1}"
ONCE="${ONCE:-0}"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

# 動画の長さ（秒）、幅、高さ、フレームレートを調べる。読めなければ空。
probe() {
  ffprobe -v error -select_streams v:0 \
    -show_entries stream=width,height,r_frame_rate:format=duration \
    -of default=noprint_wrappers=1 "$1" 2>/dev/null
}

# ファイルの更新から何秒たったか。分からなければ十分古いものとして扱う。
age_of() {
  m=$(stat -c %Y "$1" 2>/dev/null) || { echo 999999; return; }
  echo $(( $(date +%s) - m ))
}

field() { printf '%s\n' "$1" | sed -n "s/^$2=//p" | head -n 1; }

# 作る価値があるか: 長い、または大きい動画だけ。
worth_it() {
  duration_s=$(printf '%.0f' "${1:-0}" 2>/dev/null || echo 0)
  long_side=$(( ${2:-0} > ${3:-0} ? ${2:-0} : ${3:-0} ))
  [ "$duration_s" -ge "$MIN_SECONDS" ] || [ "$long_side" -gt 1280 ]
}

make_proxy() {
  src="$1"
  dst="$2"
  info=$(probe "$src")
  [ -n "$info" ] || { log "読めないので飛ばします: $src"; return 1; }
  duration=$(field "$info" duration)
  width=$(field "$info" width)
  height=$(field "$info" height)
  rate=$(field "$info" r_frame_rate)
  worth_it "$duration" "$width" "$height" || return 2

  # 長辺を MAX_SIDE に収める（拡大はしない）。幅・高さは偶数にする。
  scale="scale='if(gt(iw,ih),min($MAX_SIDE,iw),-2)':'if(gt(iw,ih),-2,min($MAX_SIDE,ih))'"
  filter="$scale"
  # 30fps を超える素材だけ 30fps に落とす（24fps を 30fps に増やして重くしない）。
  fps_num=${rate%/*}
  fps_den=${rate#*/}
  [ "$fps_den" = "$rate" ] && fps_den=1
  if [ -n "$fps_num" ] && [ "$fps_den" -gt 0 ] 2>/dev/null && [ $((fps_num / fps_den)) -gt 30 ]; then
    filter="$filter,fps=30"
  fi

  mkdir -p "$(dirname "$dst")"
  tmp="$dst.part"
  rm -f "$tmp"
  log "作成開始: $src"
  # -force_key_frames: 素材のフレームレートに関わらず、ちょうど 1 秒ごとにキーフレームを入れる。
  #   飛ばし見のシークが、毎回 1 秒ぶんのデコードで済むようになる。
  # +faststart: 先頭に目次を置く。途中から読み始められる。
  if ffmpeg -nostdin -hide_banner -loglevel error -y -threads "$THREADS" -i "$src" \
      -map 0:v:0 -map '0:a:0?' -vf "$filter" \
      -c:v libx264 -preset veryfast -crf "$CRF" -pix_fmt yuv420p \
      -force_key_frames 'expr:gte(t,n_forced*1)' -sc_threshold 0 \
      -c:a aac -b:a 64k -ac 2 \
      -movflags +faststart -f mp4 "$tmp"; then
    mv -f "$tmp" "$dst"
    log "作成完了: $dst"
    return 0
  fi
  rm -f "$tmp"
  log "失敗: $src"
  return 1
}

scan_root() {
  name="${1%%=*}"
  dir="${1#*=}"
  [ -d "$dir" ] || return 0
  find "$dir" -type f \( -iname '*.mp4' -o -iname '*.mov' -o -iname '*.mkv' -o -iname '*.webm' -o -iname '*.m4v' \) \
    2>/dev/null | while IFS= read -r src; do
    # 更新から QUIET_SECONDS 以上たったものだけ（コピー中のファイルを触らない）。
    [ "$(age_of "$src")" -ge "$QUIET_SECONDS" ] || continue
    rel="${src#"$dir"/}"
    dst="$OUT/$name/$rel.proxy.mp4"
    # すでにあって、元より新しいなら何もしない。
    if [ -f "$dst" ] && [ "$dst" -nt "$src" ]; then continue; fi
    # 作る価値が無いと判った素材は、目印を残して毎回調べ直さない。
    skip="$dst.skip"
    if [ -f "$skip" ] && [ "$skip" -nt "$src" ]; then continue; fi
    # 失敗した動画は、毎回やり直さない（3 時間の動画を何度も変換し直すのは無駄）。
    # 元が更新された（目印より新しい）か、FAIL_RETRY 秒たったら、もう一度試す。
    failed="$dst.fail"
    if [ -f "$failed" ] && [ "$failed" -nt "$src" ] && [ "$(age_of "$failed")" -lt "$FAIL_RETRY" ]; then continue; fi
    make_proxy "$src" "$dst"
    case $? in
      0) rm -f "$failed" ;;
      1) mkdir -p "$(dirname "$failed")"; : > "$failed" ;;
      2) mkdir -p "$(dirname "$skip")"; : > "$skip" ;;
    esac
  done
}

# 元が消えた複製を片付ける。
clean_root() {
  name="${1%%=*}"
  dir="${1#*=}"
  [ -d "$OUT/$name" ] || return 0
  # 元のフォルダが見えていないとき（マウントの失敗など）は、全部消してしまわないよう何もしない。
  [ -d "$dir" ] && [ -n "$(ls -A "$dir" 2>/dev/null)" ] || return 0
  find "$OUT/$name" -type f \( -name '*.proxy.mp4' -o -name '*.proxy.mp4.skip' -o -name '*.proxy.mp4.fail' \) 2>/dev/null | while IFS= read -r p; do
    rel="${p#"$OUT/$name"/}"
    rel="${rel%.proxy.mp4.fail}"
    rel="${rel%.proxy.mp4.skip}"
    rel="${rel%.proxy.mp4}"
    [ -f "$dir/$rel" ] || { rm -f "$p"; log "元が無いので片付けました: $p"; }
  done
}

command -v ffmpeg >/dev/null 2>&1 || { log "ffmpeg が見つかりません"; exit 1; }
command -v ffprobe >/dev/null 2>&1 || { log "ffprobe が見つかりません"; exit 1; }

log "軽量版の作成を始めます（見る場所: $ROOTS / 置き場: $OUT / 間隔: ${SCAN_SECONDS}秒）"
while :; do
  for root in $ROOTS; do
    scan_root "$root"
    [ "$CLEAN" = "1" ] && clean_root "$root"
  done
  [ "$ONCE" = "1" ] && break
  sleep "$SCAN_SECONDS"
done
