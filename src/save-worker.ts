import * as devalue from 'devalue';
import { compressToUTF16 } from 'lz-string';

// Background half of the autosave pipeline (see saveGameInBackground in
// save.ts). The main thread posts the save envelope over via structured
// clone (Maps/Sets survive intact); this worker does the expensive part —
// devalue serialization + LZ compression, which together block for hundreds
// of milliseconds on a large colony — and posts the compressed string back
// for the (cheap) localStorage write. Workers can't touch localStorage
// themselves, so the final write stays on the main thread.

type SaveRequest = { seq: number; env: unknown };
type SaveResponse = { seq: number; compressed: string; rawChars: number; workMs: number };

self.onmessage = (e: MessageEvent<SaveRequest>) => {
  const { seq, env } = e.data;
  const t0 = performance.now();
  const serialized = devalue.stringify(env);
  const compressed = compressToUTF16(serialized);
  const resp: SaveResponse = {
    seq,
    compressed,
    rawChars: serialized.length,
    workMs: performance.now() - t0,
  };
  (self as unknown as Worker).postMessage(resp);
};
