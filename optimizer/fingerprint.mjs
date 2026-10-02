// Identify a file by its contents, cheaply.
//
// This lived in duplicates.mjs until the duplicate finder was removed. The
// pool migration still needs it — it is how a planned move proves the copy at
// the destination is the same file as the source before the original is let go
// — so it moved here rather than leaving a 276-line module in place for one
// function.
import fs from 'node:fs';
import crypto from 'node:crypto';

// Hash a slice of the file rather than all of it: the first and last 64 MB plus
// the exact byte length. Two different files never collide on that, and it
// turns a 200 GB read into a few hundred megabytes. A full hash is available
// with { full: true } when certainty matters more than time.
//
// EVERY READ HERE MUST BE ASYNCHRONOUS, and that is not a style preference.
//
// This function used to be `async` in name only: openSync, readSync, closeSync
// all the way down, so the `await` at every call site returned an
// already-settled promise and never yielded. Node is single-threaded, so a
// synchronous 64 MB read off a USB disk freezes the ENTIRE process for as long
// as the platter takes — the HTTP server cannot answer, the encoder cannot
// advance, the window goes blank. Scanning a few hundred candidates froze it
// for minutes at a stretch and looked exactly like a crash. With { full: true }
// on a 50 GB file it was a single unbroken stall.
//
// fs.promises reads run on libuv's threadpool, so the event loop keeps turning
// and the rest of the program stays alive while the disk works. The buffer is
// also 4 MB and reused rather than 64 MB allocated per file: Buffer.alloc
// zero-fills, so the old version memset 64 MB for every file it looked at.
//
// The bytes fed to the hash are unchanged, so fingerprints still match those
// taken by the old code.
const READ_BUF = 4 << 20;

export async function fingerprint(file, { full = false } = {}) {
  const CHUNK = 64 * 1024 * 1024;
  const h = crypto.createHash('sha256');
  const { size } = await fs.promises.stat(file);
  h.update(String(size));

  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(Math.min(READ_BUF, Math.max(1, size)));
    // Hash `bytes` starting at `start`, a bufferful at a time. Each read is an
    // await, which is the yield point that keeps the process responsive.
    const hashRange = async (start, bytes) => {
      let pos = start, left = bytes;
      while (left > 0) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, left), pos);
        if (bytesRead <= 0) break;
        h.update(buf.subarray(0, bytesRead));
        pos += bytesRead;
        left -= bytesRead;
      }
    };

    if (full || size <= CHUNK * 2) {
      await hashRange(0, size);
    } else {
      await hashRange(0, CHUNK);
      await hashRange(size - CHUNK, CHUNK);
    }
  } finally { await fh.close(); }
  return h.digest('hex');
}
