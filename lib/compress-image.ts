/* Shrink a photo in the browser before uploading it.

   A modern phone camera produces 3–12 MB JPEGs. Sending that raw meant a slow
   upload on campus wifi and the whole file sitting in serverless memory on the
   other end — which is where the "low memory" failures came from. Photos here
   are evidence of a stain or a tear, so 1600px at quality 0.75 is far more
   detail than the job needs, and lands around 200–400 KB.

   Runs on the device, so the network never carries the original.

   Falls back to the untouched file if anything goes wrong: a slightly slow
   upload is better than a student unable to report damage at all. */

export const MAX_DIMENSION = 1600;
export const QUALITY = 0.75;
/** Anything already smaller than this is sent as-is. */
export const SKIP_BELOW_BYTES = 300 * 1024;

export type CompressResult = {
  file: File;
  originalBytes: number;
  bytes: number;
  compressed: boolean;
};

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("could not decode image"));
    img.src = url;
  });
}

export async function compressImage(file: File): Promise<CompressResult> {
  const originalBytes = file.size;
  const asIs: CompressResult = { file, originalBytes, bytes: originalBytes, compressed: false };

  if (typeof document === "undefined") return asIs; // server: nothing to do
  if (!file.type.startsWith("image/")) return asIs;
  if (file.size <= SKIP_BELOW_BYTES) return asIs;

  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const scale = Math.min(1, MAX_DIMENSION / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return asIs;
    ctx.drawImage(img, 0, 0, w, h);

    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", QUALITY));
    if (!blob) return asIs;

    // Re-encoding can occasionally grow a small or already-optimised image.
    // Only keep the result when it actually helps.
    if (blob.size >= originalBytes) return asIs;

    const name = file.name.replace(/\.[^.]+$/, "") + ".jpg";
    return {
      file: new File([blob], name, { type: "image/jpeg", lastModified: Date.now() }),
      originalBytes,
      bytes: blob.size,
      compressed: true,
    };
  } catch {
    return asIs; // never block the upload on a compression failure
  } finally {
    URL.revokeObjectURL(url); // otherwise every photo leaks its blob for the session
  }
}

/** "4.2 MB → 310 KB" for user-facing progress text. */
export function describeCompression(r: CompressResult) {
  const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
  return r.compressed ? `${kb(r.originalBytes)} → ${kb(r.bytes)}` : kb(r.bytes);
}
