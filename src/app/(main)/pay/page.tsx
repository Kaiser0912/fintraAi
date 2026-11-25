"use client"

// FIN-9: Scan to pay — step 1. Reads a UPI QR with the camera (or from a photo,
// or a typed UPI ID) and hands the payee to the next step.

import { useCallback, useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Camera, ImageUp, Keyboard, X } from "lucide-react"
import { decodeCanvas, decodeImageFile } from "@/lib/qrDecode"
import { isUpiId, parseUpiQr, savePayDraft, targetFromUpiId, type UpiTarget } from "@/lib/upiQr"

type CamState = "starting" | "scanning" | "blocked" | "unavailable"

export default function ScanToPayPage() {
  const router = useRouter()
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const doneRef = useRef(false)
  const [cam, setCam] = useState<CamState>("starting")
  const [message, setMessage] = useState<string | null>(null)
  const [manual, setManual] = useState(false)
  const [upiId, setUpiId] = useState("")
  const [name, setName] = useState("")

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }, [])

  const accept = useCallback(
    (target: UpiTarget) => {
      if (doneRef.current) return
      doneRef.current = true
      stopCamera()
      navigator.vibrate?.(40)
      savePayDraft(target)
      router.push("/pay/payee")
    },
    [router, stopCamera]
  )

  const handleText = useCallback(
    (text: string) => {
      const target = parseUpiQr(text)
      if (target) accept(target)
      else setMessage("That QR isn't a UPI payment code. Try the shop's or friend's payment QR.")
    },
    [accept]
  )

  // Camera + scan loop
  useEffect(() => {
    if (manual) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCam("unavailable")
        return
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream
        const video = videoRef.current
        if (!video) return
        video.srcObject = stream
        await video.play().catch(() => {})
        setCam("scanning")
        tick()
      } catch (e) {
        const name = (e as { name?: string })?.name
        setCam(name === "NotAllowedError" || name === "SecurityError" ? "blocked" : "unavailable")
      }
    }

    let lastBad = ""
    async function tick() {
      if (cancelled || doneRef.current) return
      const video = videoRef.current
      const canvas = canvasRef.current
      if (video && canvas && video.readyState >= 2 && video.videoWidth) {
        // Decode the centre square (where the frame is drawn) at a modest size.
        const side = Math.min(video.videoWidth, video.videoHeight)
        const size = Math.min(side, 720)
        canvas.width = size
        canvas.height = size
        canvas
          .getContext("2d", { willReadFrequently: true })
          ?.drawImage(video, (video.videoWidth - side) / 2, (video.videoHeight - side) / 2, side, side, 0, 0, size, size)
        const text = await decodeCanvas(canvas)
        if (text) {
          const target = parseUpiQr(text)
          if (target) return accept(target)
          if (text !== lastBad) {
            lastBad = text
            setMessage("That QR isn't a UPI payment code. Point at a payment QR.")
          }
        }
      }
      timer = setTimeout(tick, 200)
    }

    start()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      stopCamera()
    }
  }, [manual, accept, stopCamera])

  async function onPhoto(file: File | undefined) {
    if (!file) return
    setMessage(null)
    try {
      const text = await decodeImageFile(file)
      if (text) handleText(text)
      else setMessage("Couldn't find a QR in that image. Try a sharper photo or screenshot.")
    } catch {
      setMessage("Couldn't read that image.")
    }
  }

  function onManual(e: React.FormEvent) {
    e.preventDefault()
    const target = targetFromUpiId(upiId, name)
    if (target) accept(target)
  }

  return (
    <div className="mx-auto flex max-w-md flex-col gap-5 px-5 pb-28 pt-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-[var(--ink)]">Scan to pay</h1>
          <p className="text-sm text-[var(--ink-3)]">Point at a shop&apos;s or friend&apos;s UPI QR.</p>
        </div>
        <button
          onClick={() => router.back()}
          aria-label="Close"
          className="flex h-10 w-10 items-center justify-center rounded-full text-[var(--ink-3)] hover:bg-[var(--surface-2)]"
        >
          <X className="h-5 w-5" />
        </button>
      </header>

      {!manual && (
        <div className="relative aspect-square w-full overflow-hidden rounded-2xl bg-black">
          <video ref={videoRef} playsInline muted className="h-full w-full object-cover" />
          {cam === "scanning" && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="h-3/5 w-3/5 rounded-2xl border-[3px] border-white/90 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
            </div>
          )}
          {cam !== "scanning" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center text-white/90">
              <Camera className="h-8 w-8 opacity-80" />
              <p className="text-sm">
                {cam === "starting" && "Starting the camera…"}
                {cam === "blocked" && "Camera access is off for Fintra. Allow it in your phone's settings, or use a photo or the UPI ID below."}
                {cam === "unavailable" && "No camera available here. Use a photo or type the UPI ID."}
              </p>
            </div>
          )}
          <canvas ref={canvasRef} className="hidden" />
        </div>
      )}

      {message && (
        <p role="status" className="rounded-xl bg-[var(--neg-bg)] px-4 py-3 text-sm text-[var(--neg)]">
          {message}
        </p>
      )}

      {manual ? (
        <form onSubmit={onManual} className="space-y-3 rounded-2xl border border-[var(--hairline)] p-4">
          <label className="block space-y-1">
            <span className="text-sm font-medium text-[var(--ink)]">UPI ID</span>
            <input
              value={upiId}
              onChange={(e) => setUpiId(e.target.value)}
              placeholder="name@bank"
              autoCapitalize="none"
              autoCorrect="off"
              autoFocus
              className="w-full rounded-lg border border-[var(--hairline)] bg-transparent px-3 py-2.5 text-sm"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-sm font-medium text-[var(--ink)]">Name (optional)</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Who you're paying"
              className="w-full rounded-lg border border-[var(--hairline)] bg-transparent px-3 py-2.5 text-sm"
            />
          </label>
          {upiId && !isUpiId(upiId) && <p className="text-xs text-[var(--neg)]">A UPI ID looks like name@bank.</p>}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={!isUpiId(upiId)}
              className="flex-1 rounded-xl bg-[var(--brand)] px-4 py-3 text-sm font-semibold text-[var(--primary-foreground)] disabled:opacity-40"
            >
              Continue
            </button>
            <button
              type="button"
              onClick={() => setManual(false)}
              className="rounded-xl border border-[var(--hairline)] px-4 py-3 text-sm"
            >
              Scan instead
            </button>
          </div>
        </form>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <label className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-[var(--hairline)] px-3 py-3 text-sm font-medium text-[var(--ink)]">
            <ImageUp className="h-4 w-4" />
            Scan from a photo
            <input type="file" accept="image/*" className="hidden" onChange={(e) => onPhoto(e.target.files?.[0])} />
          </label>
          <button
            onClick={() => setManual(true)}
            className="flex items-center justify-center gap-2 rounded-xl border border-[var(--hairline)] px-3 py-3 text-sm font-medium text-[var(--ink)]"
          >
            <Keyboard className="h-4 w-4" />
            Enter UPI ID
          </button>
        </div>
      )}
    </div>
  )
}
