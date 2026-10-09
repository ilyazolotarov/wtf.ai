// Records the route voice's phrases (src/components/route/voice-phrases.ts) with a neural voice, into
// assets/voice/<lang>/, and writes the app's clip index (src/components/route/voice-clips.ts). Only phrases that are
// new or whose words changed are recorded again; clips no phrase uses any more are deleted.
//
//   npm run voice:render                                       # every language, its default voice
//   npm run voice:render -- --lang uk --voice uk-UA-OstapNeural  # one language, another voice
//
// Needs Python with edge-tts (`pip install edge-tts`), which uses the Microsoft Edge read-aloud service, and ffmpeg
// (silence trimmed to a short tail, so the voice starts at once and two phrases in a row join naturally; then evened
// out and raised to one loudness, heard over music in a car).

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { Strings } from "@/i18n/en";
import { en } from "@/i18n/en";
import { uk } from "@/i18n/uk";
import { recordedPhrases, type VoiceLang } from "@/components/route/voice-phrases";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LANGS: Partial<Record<VoiceLang, { strings: Strings; voice: string }>> = {
  en: { strings: en, voice: "en-GB-SoniaNeural" },
  uk: { strings: uk, voice: "uk-UA-PolinaNeural" },
};

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const force = args.includes("--force");
const silence = (keepS: number) => `silenceremove=start_periods=1:start_threshold=-50dB:start_silence=${keepS}`;
/** 30 ms of silence before the words, 150 ms after. */
const TRIM = [silence(0.03), "areverse", silence(0.15), "areverse"].join(",");
/** Quiet syllables brought up to the loud ones, so the whole phrase carries over music and road noise. */
const COMPRESS = "acompressor=threshold=-26dB:ratio=4:attack=3:release=60";
/**
 * Every clip (mono) at this integrated loudness: the loudest the voice can play (edge-tts gives about −21). The app's
 * default volume, 80 %, plays it 3.9 dB lower, near −19: Google's reference for mono voice, as loud as its assistant's
 * speech (−16 LUFS stereo); −15 itself was too loud in the car, but is there for loud music (use-voice-guidance.ts).
 */
const TARGET_LUFS = -15;
/** Peaks held under −1.5 dBFS after the gain. */
const LIMIT = "alimiter=limit=0.84:level=false";
/** Changed with the processing above: every clip is recorded again. */
const PROCESSING = `trim, compress, ${TARGET_LUFS} LUFS`;

/** Integrated loudness (LUFS) of an audio file. */
async function loudness(file: string): Promise<number> {
  const { stderr } = await run("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-af", "loudnorm=print_format=json", "-f", "null", "-"]);
  const lufs = Number(/"input_i"\s*:\s*"(-?[\d.]+|-inf)"/.exec(stderr)?.[1]);
  if (!Number.isFinite(lufs)) throw new Error(`no loudness measured for ${file}`);
  return lufs;
}

async function render(lang: VoiceLang, strings: Strings, voice: string): Promise<string[]> {
  const dir = path.join(ROOT, "assets", "voice", lang);
  mkdirSync(dir, { recursive: true });
  const manifestPath = path.join(dir, "phrases.json");
  const before: { voice?: string; processing?: string; phrases?: Record<string, string> } = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, "utf8"))
    : {};
  const phrases = recordedPhrases((key) => strings[key], lang);
  const todo = phrases.filter((p) => force || before.voice !== voice || before.processing !== PROCESSING || before.phrases?.[p.id] !== p.text || !existsSync(path.join(dir, `${p.id}.mp3`)));

  let done = 0;
  const worker = async () => {
    for (let p = todo.shift(); p; p = todo.shift()) {
      const raw = path.join(tmpdir(), `voice-${lang}-${p.id}.mp3`);
      await run("python", ["-m", "edge_tts", "--voice", voice, "--text", p.text, "--write-media", raw]);
      const even = path.join(tmpdir(), `voice-${lang}-${p.id}.wav`);
      await run("ffmpeg", ["-y", "-v", "error", "-i", raw, "-af", `${TRIM},${COMPRESS}`, "-ac", "1", even]);
      const gainDb = TARGET_LUFS - (await loudness(even));
      await run("ffmpeg", ["-y", "-v", "error", "-i", even, "-af", `volume=${gainDb.toFixed(2)}dB,${LIMIT}`, "-b:a", "40k", path.join(dir, `${p.id}.mp3`)]);
      rmSync(raw);
      rmSync(even);
      done++;
      if (done % 20 === 0) console.log(`${lang}: ${done} recorded`);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));

  const ids = new Set(phrases.map((p) => p.id));
  for (const file of readdirSync(dir)) {
    if (file.endsWith(".mp3") && !ids.has(file.slice(0, -4))) rmSync(path.join(dir, file));
  }
  writeFileSync(manifestPath, `${JSON.stringify({ voice, processing: PROCESSING, phrases: Object.fromEntries(phrases.map((p) => [p.id, p.text])) }, null, 2)}\n`);
  console.log(`${lang}: ${phrases.length} phrases, ${done} recorded with ${voice}`);
  return phrases.map((p) => p.id).sort();
}

const only = option("--lang");
const index: string[] = [];
for (const [lang, { strings, voice }] of Object.entries(LANGS) as [VoiceLang, { strings: Strings; voice: string }][]) {
  const before: { voice?: string } = existsSync(path.join(ROOT, "assets", "voice", lang, "phrases.json"))
    ? JSON.parse(readFileSync(path.join(ROOT, "assets", "voice", lang, "phrases.json"), "utf8"))
    : {};
  // Another language keeps the voice it was recorded with.
  const ids = await render(lang, strings, only === lang ? (option("--voice") ?? voice) : !only ? voice : (before.voice ?? voice));
  index.push(`  ${lang}: {`, ...ids.map((id) => `    "${id}": require("../../../assets/voice/${lang}/${id}.mp3"),`), "  },");
}
writeFileSync(
  path.join(ROOT, "src", "components", "route", "voice-clips.ts"),
  [
    "// Generated by `npm run voice:render` (tools/voice/render.ts): do not edit.",
    "",
    "/** The recorded route-voice phrases, by language and phrase id (voice-phrases.ts). */",
    "export const VOICE_CLIPS: Partial<Record<\"en\" | \"uk\", Record<string, number>>> = {",
    ...index,
    "};",
    "",
  ].join("\n"),
);
