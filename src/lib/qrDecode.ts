"use client"

/**
 * QR decoding from camera frames or photos. Uses the browser's built-in
 * BarcodeDetector when available (fast, native), otherwise jsQR (pure JS).
 */
import jsQR from "jsqr"

type Detector = { detect: (src: CanvasImageSource) => Promise<{ rawValue: string }[]> }

let detector: Detector | null | undefined

async function nativeDetector(): Promise<Detector | null> {
  if (detector !== undefined) return detector
  detector = null
  const BD = (globalThis as unknown as {
    BarcodeDetector?: { new (o: { formats: string[] }): Detector; getSupportedFormats?: () => Promise<string[]> }
  }).BarcodeDetector
  if (BD) {
    try {
      const formats = (await BD.getSupportedFormats?.()) ?? ["qr_code"]
      if (formats.includes("qr_code")) detector = new BD({ formats: ["qr_code"] })
    } catch {
      detector = null
    }
  }
  return detector
}

/** Decodes a QR from whatever is currently drawn on the canvas. */
export async function decodeCanvas(canvas: HTMLCanvasElement): Promise<string | null> {
  const nd = await nativeDetector()
  if (nd) {
    try {
      const found = await nd.detect(canvas)
      if (found[0]?.rawValue) return found[0].rawValue
      return null
    } catch {
      // fall through to jsQR
    }
  }
  const ctx = canvas.getContext("2d", { willReadFrequently: true })
  if (!ctx) return null
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
  return jsQR(img.data, img.width, img.height, { inversionAttempts: "attemptBoth" })?.data ?? null
}

/** Decodes a QR from an image file (photo or screenshot). */
export async function decodeImageFile(file: File): Promise<string | null> {
  const bitmap = await createImageBitmap(file)
  // Downscale big photos: decoding is faster and just as reliable.
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement("canvas")
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close?.()
  return decodeCanvas(canvas)
}
