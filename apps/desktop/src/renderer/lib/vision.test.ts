import { describe, expect, it } from "vitest";
import { CHAT_IMAGE_LIMITS } from "@nova/shared";
import { makeModel } from "../test/fake-bridge";
import { acceptsImages, base64Length, imageFilesOf, pickVisionModel, readImageFile } from "./vision";

const priced = (prompt: number, completion: number) => ({ promptPerMTok: prompt, completionPerMTok: completion, variable: false });

describe("acceptsImages", () => {
  it("is true only when the catalog lists « image » as an input", () => {
    expect(acceptsImages(makeModel({ id: "a/v", inputModalities: ["text", "image"] }))).toBe(true);
    expect(acceptsImages(makeModel({ id: "a/t", inputModalities: ["text"] }))).toBe(false);
    expect(acceptsImages(makeModel({ id: "a/u", inputModalities: null }))).toBe(false);
    expect(acceptsImages(null)).toBe(false);
  });
});

describe("pickVisionModel", () => {
  const current = makeModel({ id: "acme/text", author: "acme", inputModalities: ["text"] });

  it("suggests a vision model of the same author first, then the cheapest known price", () => {
    const models = [
      current,
      makeModel({ id: "other/cheap-vision", author: "other", inputModalities: ["text", "image"], pricing: priced(0.1, 0.2) }),
      makeModel({ id: "acme/vision-pro", author: "acme", inputModalities: ["text", "image"], pricing: priced(3, 9) }),
      makeModel({ id: "acme/vision-mini", author: "acme", inputModalities: ["text", "image"], pricing: priced(0.5, 1) }),
    ];
    expect(pickVisionModel(models, current)?.id).toBe("acme/vision-mini");
    expect(pickVisionModel(models, null)?.id).toBe("other/cheap-vision");
  });

  it("never suggests a free, retired, image-output-only or unknown-modality model; none ⇒ null", () => {
    const models = [
      current,
      makeModel({ id: "x/free", inputModalities: ["image"], isFree: true, pricing: priced(0, 0) }),
      makeModel({ id: "x/old", inputModalities: ["image"], expirationDate: "2020-01-01", pricing: priced(1, 1) }),
      makeModel({ id: "x/painter", inputModalities: ["text", "image"], outputModalities: ["image"], pricing: priced(1, 1) }),
      makeModel({ id: "x/unknown", inputModalities: null, pricing: priced(1, 1) }),
    ];
    expect(pickVisionModel(models, current, Date.parse("2026-09-28"))).toBeNull();
    expect(pickVisionModel([], current)).toBeNull();
  });

  it("ranks unknown prices after known ones", () => {
    const models = [
      makeModel({ id: "z/unpriced", inputModalities: ["image", "text"] }),
      makeModel({ id: "z/priced", inputModalities: ["image", "text"], pricing: priced(9, 9) }),
    ];
    expect(pickVisionModel(models, null)?.id).toBe("z/priced");
  });
});

describe("readImageFile", () => {
  it("reads a PNG into base64 (bytes only in memory)", async () => {
    const file = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "capture.png", { type: "image/png" });
    const result = await readImageFile(file);
    expect(result).toEqual({ ok: true, image: { mediaType: "image/png", dataBase64: "iVBORw0KGgo=", name: "capture.png" } });
  });

  it("refuses an SVG or a non-image, and an image over the size limit, before reading it", async () => {
    expect(await readImageFile(new File(["<svg/>"], "a.svg", { type: "image/svg+xml" }))).toEqual({ ok: false, reason: "type", name: "a.svg" });
    expect(await readImageFile(new File(["x"], "a.txt", { type: "text/plain" }))).toMatchObject({ ok: false, reason: "type" });
    const big = new File([new Uint8Array(1)], "big.png", { type: "image/png" });
    Object.defineProperty(big, "size", { value: (CHAT_IMAGE_LIMITS.maxBase64Chars / 4) * 3 + 3 });
    expect(await readImageFile(big)).toMatchObject({ ok: false, reason: "size" });
    expect(base64Length(3)).toBe(4);
    expect(base64Length(4)).toBe(8);
  });

  it("takes only the image files of a paste", () => {
    const png = new File(["p"], "p.png", { type: "image/png" });
    const text = new File(["t"], "t.txt", { type: "text/plain" });
    const transfer = { files: [png, text] } as unknown as DataTransfer;
    expect(imageFilesOf(transfer)).toEqual([png]);
    expect(imageFilesOf(null)).toEqual([]);
  });
});
