#!/usr/bin/env sh
# Renders assets/sounds/lead-in.mp3: a second of silence, played ahead of each announcement while CarPlay is connected
# (ROUTING-SPEC §8.5). The car opens its prompt channel when the audio session activates, which takes it a moment, so
# the first words of a clip started right then were lost; with the silence first they arrive once the channel is open.
# Needs ffmpeg. `npm run voice:lead-in`.
set -e
out="$(dirname "$0")/../../assets/sounds/lead-in.mp3"
ffmpeg -y -v error -f lavfi -i "anullsrc=r=44100:cl=mono" -t 1 -b:a 32k "$out"
ls -l "$out"
