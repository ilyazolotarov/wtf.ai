// Trip log upload (TRIP-LOGGER-SPEC §7.1): the parts the app, the upload Worker (workers/triplog-upload) and the PC
// tools (tools/triplog) must agree on. Pure TS, no platform APIs: callers bring their own random bytes and SHA-256.

/**
 * Upload codes read like words, as iOS's suggested passwords do: three groups of consonant-vowel-consonant-vowel-
 * consonant (`bakim-tuvod-segap`). Lowercase letters only, so no keyboard switch on a phone; no `l` (read as `i`),
 * and no `q`, `x`, `y`. 17³·5² per group, about 51 bits in all: far beyond guessing over HTTP.
 */
export const CONSONANTS = "bcdfghjkmnprstvwz";
export const VOWELS = "aeiou";
const GROUP = "cvcvc";
const GROUPS = 3;
export const CODE_LENGTH = GROUP.length * GROUPS;
const PATTERN = GROUP.repeat(GROUPS);

/** A random code from random bytes (rejection sampling, so every letter of a slot is equally likely). */
export function generateCode(randomBytes: (n: number) => Uint8Array): string {
  let code = "";
  let pool: Uint8Array = new Uint8Array(0);
  let at = 0;
  while (code.length < CODE_LENGTH) {
    const letters = PATTERN[code.length] === "c" ? CONSONANTS : VOWELS;
    if (at >= pool.length) {
      pool = randomBytes(CODE_LENGTH * 2);
      at = 0;
    }
    const b = pool[at++];
    if (b < 256 - (256 % letters.length)) code += letters[b % letters.length];
  }
  return code;
}

/** `bakimtuvodsegap` → `bakim-tuvod-segap`, as it is handed to a tester. */
export const formatCode = (code: string) => code.match(new RegExp(`.{1,${GROUP.length}}`, "g"))?.join("-") ?? code;

/** A typed code as stored and sent: case, spaces and dashes ignored. Null when it can't be a code. */
export function normalizeCode(typed: string): string | null {
  const code = typed.toLowerCase().replace(/[\s\-_.]/g, "");
  if (code.length !== CODE_LENGTH) return null;
  for (let i = 0; i < code.length; i++) if (!(PATTERN[i] === "c" ? CONSONANTS : VOWELS).includes(code[i])) return null;
  return code;
}

/** Trip log names as the recorder writes them (trip-recorder.ts): `20261003-100247_ng2n9z[_manual].ulg`. */
export const TRIP_FILE_RE = /^\d{8}-\d{6}_[a-z0-9]+(?:_manual)?\.ulg$/;
/** Tester names: they become a folder in the bucket and on the PC. */
export const TESTER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** What the bucket keeps for one code, under `testers/<sha256 of the code>.json`; the code itself is never stored. */
export interface TesterRecord {
  name: string;
  /** The project's own phone: its logs go to `logs/`, next to the existing ones. */
  owner?: boolean;
  created: string;
}

export const testerKey = (codeSha256Hex: string) => `testers/${codeSha256Hex}.json`;

/** Where an uploaded log lands: the owner's next to the existing logs, a tester's in their own folder. */
export const uploadKey = (tester: TesterRecord, file: string) =>
  tester.owner ? `logs/${file}` : `logs/testers/${tester.name}/${file}`;

/** The largest log the Worker takes (Workers accept 100 MB bodies on the free plan; logs are 3–25 MB). */
export const MAX_UPLOAD_BYTES = 95_000_000;
