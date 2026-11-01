// Records the route voice's phrases (src/components/route/voice-phrases.ts) with neural voices, a female and a male
// one per language, into assets/voice/<lang>/ (female) and assets/voice/<lang>-male/, and writes the app's clip index
// (src/components/route/voice-clips.ts). Only phrases that are new or whose words changed are recorded again; clips no
// phrase uses any more are deleted.
//
//   npm run voice:render                                                     # every voice, as VOICES has them
//   npm run voice:render -- --lang en --name male                            # one of them
//   npm run voice:render -- --lang uk --name male --voice uk-UA-OstapNeural  # one of them, another voice (try it out)
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
import { recordedPhrases, type VoiceLang, type VoiceName } from "@/components/route/voice-phrases";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LANGS: Record<VoiceLang, { strings: Strings; voices: Record<VoiceName, string> }> = {
  en: { strings: en, voices: { female: "en-GB-SoniaNeural", male: "en-GB-RyanNeural" } },
  uk: { strings: uk, voices: { female: "uk-UA-PolinaNeural", male: "uk-UA-OstapNeural" } },
};
const NAMES: VoiceName[] = ["female", "male"];
/** The female voice's clips are in the language's folder, another's beside it. */
const folder = (lang: VoiceLang, name: VoiceName) => (name === "female" ? lang : `${lang}-${name}`);

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

async function render(lang: VoiceLang, name: VoiceName, strings: Strings, voice: string): Promise<string[]> {
  const dir = path.join(ROOT, "assets", "voice", folder(lang, name));
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
      const raw = path.join(tmpdir(), `voice-${folder(lang, name)}-${p.id}.mp3`);
      // The service turns some requests away when several run at once: a few tries, a moment apart.
      for (let attempt = 1; ; attempt++) {
        try {
          await run("python", ["-m", "edge_tts", "--voice", voice, "--text", p.text, "--write-media", raw]);
          break;
        } catch (e) {
          if (attempt === 5) throw e;
          await new Promise((r) => setTimeout(r, 2000 * attempt));
        }
      }
      const even = path.join(tmpdir(), `voice-${folder(lang, name)}-${p.id}.wav`);
      await run("ffmpeg", ["-y", "-v", "error", "-i", raw, "-af", `${TRIM},${COMPRESS}`, "-ac", "1", even]);
      const gainDb = TARGET_LUFS - (await loudness(even));
      await run("ffmpeg", ["-y", "-v", "error", "-i", even, "-af", `volume=${gainDb.toFixed(2)}dB,${LIMIT}`, "-b:a", "40k", path.join(dir, `${p.id}.mp3`)]);
      rmSync(raw);
      rmSync(even);
      done++;
      if (done % 20 === 0) console.log(`${folder(lang, name)}: ${done} recorded`);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));

  const ids = new Set(phrases.map((p) => p.id));
  for (const file of readdirSync(dir)) {
    if (file.endsWith(".mp3") && !ids.has(file.slice(0, -4))) rmSync(path.join(dir, file));
  }
  writeFileSync(manifestPath, `${JSON.stringify({ voice, processing: PROCESSING, phrases: Object.fromEntries(phrases.map((p) => [p.id, p.text])) }, null, 2)}\n`);
  console.log(`${folder(lang, name)}: ${phrases.length} phrases, ${done} recorded with ${voice}`);
  return phrases.map((p) => p.id).sort();
}

const onlyLang = option("--lang");
const onlyName = option("--name");
const tryVoice = option("--voice");
if (tryVoice && (!onlyLang || !onlyName)) throw new Error("--voice records one voice: give --lang and --name too");
const index: string[] = [];
for (const [lang, { strings, voices }] of Object.entries(LANGS) as [VoiceLang, (typeof LANGS)[VoiceLang]][]) {
  index.push(`  ${lang}: {`);
  for (const name of NAMES) {
    const manifest = path.join(ROOT, "assets", "voice", folder(lang, name), "phrases.json");
    const before: { voice?: string } = existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8")) : {};
    // The others keep the voice they were recorded with.
    const chosen = (!onlyLang || onlyLang === lang) && (!onlyName || onlyName === name);
    const ids = await render(lang, name, strings, chosen ? (tryVoice ?? voices[name]) : (before.voice ?? voices[name]));
    index.push(`    ${name}: {`, ...ids.map((id) => `      "${id}": require("../../../assets/voice/${folder(lang, name)}/${id}.mp3"),`), "    },");
  }
  index.push("  },");
}
writeFileSync(
  path.join(ROOT, "src", "components", "route", "voice-clips.ts"),
  [
    "// Generated by `npm run voice:render` (tools/voice/render.ts): do not edit.",
    "",
    "/** The recorded route-voice phrases, by language, voice and phrase id (voice-phrases.ts). */",
    "export const VOICE_CLIPS: Partial<Record<\"en\" | \"uk\", Partial<Record<\"female\" | \"male\", Record<string, number>>>>> = {",
    ...index,
    "};",
    "",
  ].join("\n"),
);
