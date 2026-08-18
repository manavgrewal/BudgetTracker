import sharp from 'sharp';

/** A solid RGB plane, for building deterministic inputs. */
export function solidRgb(width: number, height: number, rgb: [number, number, number]): Buffer {
  const buf = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    buf[i * 3] = rgb[0];
    buf[i * 3 + 1] = rgb[1];
    buf[i * 3 + 2] = rgb[2];
  }
  return buf;
}

/** 600 by 400 white with eight black horizontal bars, then rotated by `deg`. */
export async function barGridPng(deg: number, width = 600, height = 400): Promise<Buffer> {
  const raw = solidRgb(width, height, [255, 255, 255]);
  for (let bar = 0; bar < 8; bar += 1) {
    const top = Math.round(((bar + 1) * height) / 10);
    for (let y = top; y < top + 6; y += 1) {
      for (let x = Math.round(width * 0.1); x < Math.round(width * 0.9); x += 1) {
        const i = (y * width + x) * 3;
        raw[i] = 0;
        raw[i + 1] = 0;
        raw[i + 2] = 0;
      }
    }
  }
  const base = sharp(raw, { raw: { width, height, channels: 3 } });
  const rotated = deg === 0 ? base : base.rotate(deg, { background: '#ffffff' });
  return rotated.png().toBuffer();
}

/** A tall red-over-blue image written landscape with EXIF orientation 6, so a reader that
 *  honours the tag sees it upright and one that does not sees it on its side. */
export async function exifOrientation6Png(): Promise<Buffer> {
  const wide = 120;
  const tall = 60;
  const raw = Buffer.alloc(wide * tall * 3);
  for (let y = 0; y < tall; y += 1) {
    for (let x = 0; x < wide; x += 1) {
      const i = (y * wide + x) * 3;
      const left = x < wide / 2;
      raw[i] = left ? 255 : 0;
      raw[i + 2] = left ? 0 : 255;
    }
  }
  return sharp(raw, { raw: { width: wide, height: tall, channels: 3 } })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
}

/** A `size` by `size` PNG that is fully transparent over pure black. */
export async function transparentBlackPng(size = 32): Promise<Buffer> {
  const raw = Buffer.alloc(size * size * 4);
  return sharp(raw, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
}
