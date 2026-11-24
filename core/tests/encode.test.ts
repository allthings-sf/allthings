import { describe, expect, test } from "bun:test";
import { crc32, deflateSync } from "node:zlib";
import sharp from "sharp";
import { encode, maxInputPixels, placeholder } from "../scripts/encode.ts";

/** The re-encoder the script uses (scripts/encode.ts), on images Sharp draws. */

const png = (width: number, height: number, alpha: number) =>
  sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 200, g: 80, b: 40, alpha },
    },
  })
    .png()
    .toBuffer()
    .then((buffer) => new Uint8Array(buffer));

/** A PNG chunk: its length, type, data and CRC. */
const chunk = (type: string, data: Uint8Array) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  out.set(data, 8);
  out.writeUInt32BE(
    crc32(out.subarray(4, 8 + data.length)) >>> 0,
    8 + data.length,
  );
  return out;
};

/** A PNG of a few bytes whose header says it is `width` by `height`. */
const claiming = (width: number, height: number) => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 1; // one bit a pixel, grey
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(Buffer.alloc(0))),
      chunk("IEND", new Uint8Array()),
    ]),
  );
};

describe("encode", () => {
  test("refuses an image with more pixels than it reads, from its header", async () => {
    const huge = claiming(20000, Math.floor(maxInputPixels / 20000) + 1);
    await expect(encode(huge, 4096)).rejects.toThrow(
      "Input image exceeds pixel limit",
    );
    await expect(placeholder(huge)).rejects.toThrow(
      "Input image exceeds pixel limit",
    );
  });

  test("makes an opaque photo a JPEG fitted inside the edge", async () => {
    const made = await encode(await png(5712, 4284, 1), 4096);
    expect(made.format).toBe("jpeg");
    expect([made.width, made.height]).toEqual([4096, 3072]);
    const metadata = await sharp(made.bytes).metadata();
    expect([metadata.format, metadata.width, metadata.height]).toEqual([
      "jpeg",
      4096,
      3072,
    ]);
  });

  test("never enlarges a smaller one", async () => {
    const made = await encode(await png(1200, 800, 1), 4096);
    expect([made.width, made.height]).toEqual([1200, 800]);
  });

  test("keeps a see-through image see-through, as WebP", async () => {
    const made = await encode(await png(800, 800, 0.5), 4096);
    expect(made.format).toBe("webp");
    expect((await sharp(made.bytes).metadata()).hasAlpha).toBe(true);
  });
});
