export interface Screenshot {
  image: string;
  mime: 'image/png' | 'image/jpeg';
}

const MAX_BYTES = 8 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Validate in-memory, canonical base64 and the declared image signature only. */
export function validateScreenshot(input: unknown): Screenshot | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const { image, mime } = input as Record<string, unknown>;
  if (typeof image !== 'string' || (mime !== 'image/png' && mime !== 'image/jpeg')) return undefined;
  if (!image.length || image.length > 4 * Math.ceil(MAX_BYTES / 3)
    || image.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image)) return undefined;
  const bytes = Buffer.from(image, 'base64');
  if (bytes.length > MAX_BYTES || bytes.toString('base64') !== image) return undefined;
  if (mime === 'image/png' ? !bytes.subarray(0, 8).equals(PNG_MAGIC)
    : bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return undefined;
  return { image, mime };
}
