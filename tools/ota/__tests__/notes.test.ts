import { cleanNotes } from "../notes";

describe("cleanNotes", () => {
  it("keeps commit titles without merges, CI keywords, blanks or repeats", () => {
    expect(
      cleanNotes([
        "Map update in the background [build]",
        "Merge branch 'main' into feature",
        "",
        "  Faster   start [skip ci] ",
        "Map update in the background",
        "Android installs its update [build android]",
      ]),
    ).toEqual(["Map update in the background", "Faster start", "Android installs its update"]);
  });

  it("stops at 20", () => {
    expect(cleanNotes(Array.from({ length: 30 }, (_, i) => `change ${i}`))).toHaveLength(20);
  });
});
