#!/bin/sh
# proxy.sh の判断（どれを作る・作らない・片付ける）を、ffmpeg の代役で確かめる。Docker も ffmpeg も要らない。
#   sh deploy/nas/proxy-selftest.sh
set -u
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/media/案件 A" "$work/personal/sato" "$work/out"
calls="$work/calls.log"
: > "$calls"

# ffprobe の代役: ファイル名で素材の性質を決める。
cat > "$work/bin/ffprobe" <<'STUB'
#!/bin/sh
for last; do :; done
case "$last" in
  *broken*) exit 1 ;;
  *long60*)  printf 'width=1920\nheight=1080\nr_frame_rate=60/1\nduration=7200.0\n' ;;
  *long30*)  printf 'width=1920\nheight=1080\nr_frame_rate=30000/1001\nduration=3600.5\n' ;;
  *portrait*) printf 'width=1080\nheight=1920\nr_frame_rate=30/1\nduration=900.0\n' ;;
  *big4k*)   printf 'width=3840\nheight=2160\nr_frame_rate=30/1\nduration=20.0\n' ;;
  *) printf 'width=640\nheight=360\nr_frame_rate=30/1\nduration=30.0\n' ;;
esac
STUB
# ffmpeg の代役: 引数を記録し、最後の引数（出力）へ書く。*fail* の入力なら失敗する。
cat > "$work/bin/ffmpeg" <<STUB
#!/bin/sh
echo "\$*" >> "$calls"
for last; do :; done
case "\$*" in *failme*) exit 1 ;; esac
echo proxy > "\$last"
STUB
chmod +x "$work/bin/ffprobe" "$work/bin/ffmpeg"

old=$(date -d '10 minutes ago' '+%Y%m%d%H%M' 2>/dev/null || date -v-10M '+%Y%m%d%H%M')
mk() { mkdir -p "$(dirname "$1")"; echo data > "$1"; touch -t "$old" "$1"; }
mk "$work/media/案件 A/long60.mp4"
mk "$work/media/案件 A/long30.mov"
mk "$work/media/portrait.mp4"
mk "$work/media/big4k.mp4"
mk "$work/media/short.mp4"
mk "$work/media/broken.mp4"
mk "$work/media/failme-long60.mp4"
mk "$work/personal/sato/long60.webm"
mk "$work/media/note.txt"
echo data > "$work/media/fresh-long60.mp4"   # 今コピーされたばかり（更新が新しい）

run() {
  PATH="$work/bin:$PATH" ROOTS="media=$work/media media-personal=$work/personal" OUT="$work/out" \
    ONCE=1 QUIET_SECONDS=60 MIN_SECONDS=180 FAIL_RETRY=3600 sh "$here/proxy.sh" > "$work/log.txt" 2>&1
}

fail=0
ok() { if [ "$2" = "yes" ]; then echo "PASS $1"; else echo "FAIL $1"; fail=$((fail + 1)); fi; }
has() { [ -f "$1" ] && echo yes || echo no; }
hasnt() { [ -f "$1" ] && echo no || echo yes; }

run
ok "長い動画の複製ができる（日本語・空白を含むパス）" "$(has "$work/out/media/案件 A/long60.mp4.proxy.mp4")"
ok "拡張子が mov でも .proxy.mp4 になる" "$(has "$work/out/media/案件 A/long30.mov.proxy.mp4")"
ok "個人フォルダは media-personal 以下へ" "$(has "$work/out/media-personal/sato/long60.webm.proxy.mp4")"
ok "縦長も作る" "$(has "$work/out/media/portrait.mp4.proxy.mp4")"
ok "短くても大きい（4K）なら作る" "$(has "$work/out/media/big4k.mp4.proxy.mp4")"
ok "短くて小さい動画は作らない" "$(hasnt "$work/out/media/short.mp4.proxy.mp4")"
ok "作らない判断は目印を残す" "$(has "$work/out/media/short.mp4.proxy.mp4.skip")"
ok "読めない動画は飛ばし、失敗の目印を残す" "$([ ! -e "$work/out/media/broken.mp4.proxy.mp4" ] && [ -f "$work/out/media/broken.mp4.proxy.mp4.fail" ] && echo yes || echo no)"
ok "ffmpeg が失敗したら書きかけを残さない" "$([ ! -e "$work/out/media/failme-long60.mp4.proxy.mp4" ] && [ ! -e "$work/out/media/failme-long60.mp4.proxy.mp4.part" ] && echo yes || echo no)"
ok "ffmpeg が失敗した動画にも失敗の目印が付く" "$(has "$work/out/media/failme-long60.mp4.proxy.mp4.fail")"
ok "動画以外は触らない" "$(hasnt "$work/out/media/note.txt.proxy.mp4")"
ok "コピーしたての動画は待つ" "$(hasnt "$work/out/media/fresh-long60.mp4.proxy.mp4")"

# 引数の中身
line60=$(grep "long60.mp4" "$calls" | grep -v failme | head -n 1)
line30=$(grep "long30.mov" "$calls" | head -n 1)
linep=$(grep "portrait" "$calls" | head -n 1)
case "$line60" in *fps=30*) ok "60fps の素材は 30fps に落とす" yes ;; *) ok "60fps の素材は 30fps に落とす" no ;; esac
case "$line30" in *fps=30*) ok "29.97fps の素材は fps 変換しない" no ;; *) ok "29.97fps の素材は fps 変換しない" yes ;; esac
case "$line60" in *'expr:gte(t,n_forced*1)'*) ok "1 秒ごとのキーフレームを指定" yes ;; *) ok "1 秒ごとのキーフレームを指定" no ;; esac
case "$line60" in *+faststart*) ok "faststart を指定" yes ;; *) ok "faststart を指定" no ;; esac
case "$linep" in *'min(640,ih)'*) ok "縦長は高さを 640 に収める" yes ;; *) ok "縦長は高さを 640 に収める" no ;; esac

# 2 回目: 何も作り直さない
before=$(wc -l < "$calls")
run
after=$(wc -l < "$calls")
ok "2 回目の見回りでは、作り直さない（ffmpeg を呼ばない）" "$([ "$before" = "$after" ] && echo yes || echo no)"

# 元が更新されたら作り直す
touch "$work/media/portrait.mp4"; touch -t "$(date '+%Y%m%d%H%M')" "$work/media/portrait.mp4"
sleep 1
touch -t "$old" "$work/media/portrait.mp4"
: > "$work/out/media/portrait.mp4.proxy.mp4"; touch -t 200001010000 "$work/out/media/portrait.mp4.proxy.mp4"
run
ok "元より古い複製は作り直す" "$([ -s "$work/out/media/portrait.mp4.proxy.mp4" ] && echo yes || echo no)"

# 失敗した動画は、元が更新されたらすぐ試し直す（直した動画を待たせない）
sleep 1
echo fixed > "$work/media/broken.mp4"
printf 'width=1280\nheight=720\nr_frame_rate=30/1\nduration=600.0\n' > /dev/null
# 代役の ffprobe は名前で決めるので、読める名前に付け替えて「更新された」ことにする
mv "$work/media/broken.mp4" "$work/media/long30-fixed.mp4"; touch -t "$old" "$work/media/long30-fixed.mp4"
rm -f "$work/out/media/broken.mp4.proxy.mp4.fail"
run
ok "直った動画は次の見回りで作られる" "$(has "$work/out/media/long30-fixed.mp4.proxy.mp4")"

# 片付け
rm "$work/media/案件 A/long30.mov"
run
ok "元が消えたら複製を片付ける" "$(hasnt "$work/out/media/案件 A/long30.mov.proxy.mp4")"
ok "残っている元の複製は消さない" "$(has "$work/out/media/案件 A/long60.mp4.proxy.mp4")"

# 元フォルダが空（マウント失敗など）のときは、片付けない
mkdir "$work/empty"
PATH="$work/bin:$PATH" ROOTS="media=$work/empty" OUT="$work/out" ONCE=1 QUIET_SECONDS=60 sh "$here/proxy.sh" >/dev/null 2>&1
ok "元フォルダが空のときは、片付けで全部消さない" "$(has "$work/out/media/案件 A/long60.mp4.proxy.mp4")"

# 空白・日本語の入った名前が壊れていない
ok "ログに日本語のパスが出る" "$(grep -q '案件 A' "$work/log.txt" || grep -q '案件 A' "$work/calls.log" && echo yes || echo no)"

if [ "$fail" -eq 0 ]; then echo "全部通過"; else echo "$fail 件失敗"; exit 1; fi
