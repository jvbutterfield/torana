// Magic-byte MIME detection for the gateway's attachment allowlist. Used by:
//   - the CLI (when a user attaches a file to `torana ask` / `torana send`),
//   - the Agent-API multipart handler (to validate that a declared MIME on a
//     multipart part actually matches the file's magic bytes),
//   - the Telegram download path (to validate files arriving from Telegram
//     before we hand their on-disk paths to a runner).
//
// Returning `undefined` means "I don't recognise these bytes as one of the
// allowlisted types". Callers decide how to treat that — the CLI falls back
// to extension-based guessing for user convenience; the Agent-API /
// Telegram paths refuse anything they can't recognise so a declared-PNG
// that is actually a shell script cannot be written with a `.png`
// extension and handed to a runner.

/** Inspect the first bytes of a buffer to guess its MIME type. */
export function detectMimeFromMagic(bytes: Uint8Array): string | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  if (
    bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  ) {
    return "application/pdf";
  }
  return undefined;
}
