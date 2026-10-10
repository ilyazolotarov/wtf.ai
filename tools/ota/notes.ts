// The notes of a published build (docs/UPDATES-SPEC.md §3): the commit titles since the previous build. Pure.

export const MAX_NOTES = 20;

/** Commit titles as build notes: no merges or empty lines, no CI keywords, no repeats, at most 20. */
export function cleanNotes(subjects: string[]): string[] {
  const notes: string[] = [];
  for (const raw of subjects) {
    const note = raw.replace(/\[(skip ci|ci skip|build(?: ios| android)?)\]/gi, "").replace(/\s+/g, " ").trim();
    if (!note || /^Merge (branch|pull request|remote-tracking)/.test(note) || notes.includes(note)) continue;
    notes.push(note);
    if (notes.length === MAX_NOTES) break;
  }
  return notes;
}
