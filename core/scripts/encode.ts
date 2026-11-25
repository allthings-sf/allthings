import sharp from "sharp";
import type { Encoder } from "../src/reencode.ts";

/**
 * The most pixels an image may have to be read at all: 200 megapixels, more
 * than phones and cameras take (the largest, 16320 by 12240, is just under).
 * Sharp refuses a larger one from its header, before decoding it, since a
 * small file can say it holds far more pixels than it has bytes.
 */
export const maxInputPixels = 200_000_000;

const input = { limitInputPixels: maxInputPixels } as const;

/**
 * JPEG at quality 88 for an opaque image, WebP for one that is see-through,
 * turned upright by its EXIF orientation and fitted inside `edge` pixels.
 */
export const encode: Encoder = async (bytes, edge) => {
  const { isOpaque } = await sharp(bytes, input).stats();
  const image = sharp(bytes, input).rotate().resize({
    width: edge,
    height: edge,
    fit: "inside",
    withoutEnlargement: true,
  });
  const { data, info } = await (
    isOpaque
      ? image.jpeg({ quality: 88, mozjpeg: true })
      : image.webp({ quality: 88, alphaQuality: 100 })
  ).toBuffer({ resolveWithObject: true });
  return {
    bytes: new Uint8Array(data),
    format: isOpaque ? "jpeg" : "webp",
    width: info.width,
    height: info.height,
  };
};

/** A placeholder's longest side, in pixels: enough for a blur-up (as web/src/sync/bindings.ts makes them). */
const placeholderEdge = 16;

/** A tiny JPEG of the image as a data URL, for `images.placeholder`. */
export const placeholder = async (bytes: Uint8Array): Promise<string> => {
  const data = await sharp(bytes, input)
    .rotate()
    .resize({
      width: placeholderEdge,
      height: placeholderEdge,
      fit: "inside",
    })
    .jpeg({ quality: 50 })
    .toBuffer();
  return `data:image/jpeg;base64,${data.toString("base64")}`;
};
