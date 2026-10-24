import { createHash } from "crypto";
import { readFileSync } from "fs";
import path from "path";

import { withCarSprite } from "@/components/map/car-sprite";
import SPRITE from "@/components/map/map-car-sprite.json";
import { carImage } from "@/components/map/map-features";
import { MAP_CAR } from "@/components/map/puck-style";

describe("the car sprite", () => {
  test("holds every image the map can ask for, at the size the layer expects", () => {
    // Every size from far out to the nearest zoom, on 1x to 3x screens: the suffixes carImage picks.
    const suffixes = new Set<string>();
    for (const ratio of [1, 2, 3]) for (let size = 0.1; size < 40; size *= 1.1) suffixes.add(carImage(size, ratio).suffix);
    expect([...suffixes].sort()).toEqual(["", ...MAP_CAR.near.map((d) => `-x${d}`)].sort());
    const images = SPRITE.images as Record<string, { width: number; height: number; pixelRatio: number }>;
    for (const theme of ["light", "dark"] as const)
      for (const suffix of suffixes) {
        const image = images[`${MAP_CAR.image[theme]}${suffix}`];
        expect(image).toBeDefined();
        // The canvas's points at the car's own size; a near image a pixel a point, `density` times as large.
        const density = suffix ? Number(suffix.slice(2)) : 1;
        expect(image.width / image.pixelRatio).toBe(MAP_CAR.canvas.w * density);
        expect(image.height / image.pixelRatio).toBe(MAP_CAR.canvas.h * density);
      }
  });

  test("its version is the sheet's: a redrawn car is copied again", () => {
    const png = readFileSync(path.join(__dirname, "../../../../assets/images/map-car-sprite.png"));
    const md5 = createHash("md5").update(png).digest("hex");
    expect(SPRITE.version).toBe(md5.slice(0, 8));
  });

  test("sits beside the style's own sprite, whose images stay unprefixed", () => {
    const style = { layers: [], sprite: "file:///common/sprites/ofm" };
    expect(withCarSprite(style, null)).toBe(style);
    expect(withCarSprite(style, "file:///doc/map-car/v/car").sprite).toEqual([
      { id: "default", url: "file:///common/sprites/ofm" },
      { id: MAP_CAR.sprite, url: "file:///doc/map-car/v/car" },
    ]);
  });
});
