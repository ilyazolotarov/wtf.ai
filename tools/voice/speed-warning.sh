#!/usr/bin/env sh
# Renders assets/sounds/speed-warning.mp3, the chime when the car is too fast for the limit (UI-SPEC §6.4): two falling
# bell notes (A5, E5), at −17 LUFS, 2 LU under the voice clips (render.ts), so it is heard without startling. Needs ffmpeg.
set -e
out="$(dirname "$0")/../../assets/sounds/speed-warning.mp3"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
note() { # frequency, start (s), decay (1/s)
  echo "0.5*gte(t,$2)*(sin(2*PI*$1*(t-$2))+0.25*sin(2*PI*2*$1*(t-$2)))*exp(-$3*(t-$2))*min(1,(t-$2)*200)"
}
ffmpeg -y -v error -f lavfi -i "aevalsrc='$(note 880 0 7)+$(note 659.25 0.17 6)':s=44100:d=0.95" -ac 1 "$tmp/raw.wav"
lufs=$(ffmpeg -hide_banner -nostats -i "$tmp/raw.wav" -af loudnorm=print_format=json -f null - 2>&1 | grep input_i | sed 's/[^-0-9.]//g')
gain=$(awk -v l="$lufs" 'BEGIN { printf "%.2f", -17 - l }')
ffmpeg -y -v error -i "$tmp/raw.wav" -af "volume=${gain}dB,alimiter=limit=0.89" -b:a 64k "$out"
