/**
 * Camera-first picking flow.
 *
 * The whole slip view is a full-screen rear-camera stream. The picker walks
 * through lines one at a time:
 *   • A translucent banner across the top shows item, location and progress.
 *   • A translucent panel along the bottom holds picked-qty, optional barcode
 *     and a single shutter/confirm button.
 *   • Tapping the shutter grabs a still frame from the live video, attaches
 *     it as the proof-of-pick photo, confirms the line, and advances.
 *   • Chevrons on the left/right edges move Back / Next without confirming.
 *   • Top-left "Quit" leaves the slip (with confirmation). A "Finish" button
 *     appears once all lines are confirmed.
 *   • A small "Short-pick" action expands a compact reason panel over the
 *     camera view.
 *
 * The screen is locked to portrait while the slip is open.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRoute, useLocation } from "wouter";
import { pickerGet, pickerMutate } from "./lib/api";
import type { PickSlip, PickSlipLine } from "./lib/types";
import { speak } from "./lib/voice";
import { useOfflineQueue } from "./lib/useOfflineQueue";
import { useToast } from "@/hooks/use-toast";

const SHORT_REASONS = [
  { value: "out_of_stock", label: "Out of stock" },
  { value: "wrong_location", label: "Wrong location" },
  { value: "damaged", label: "Damaged" },
  { value: "other", label: "Other" },
] as const;

type ShortReason = typeof SHORT_REASONS[number]["value"];

export default function PickerSlipPage() {
  const [, params] = useRoute<{ id: string }>("/picking/slip/:id");
  const [, setLocation] = useLocation();
  const slipId = Number(params?.id);
  const { toast } = useToast();

  const slipQuery = useQuery({
    queryKey: ["picker", "slip", slipId],
    queryFn: () => pickerGet<PickSlip>(`/sales/pick-slips/${slipId}`),
    enabled: Number.isFinite(slipId),
  });

  const slip = slipQuery.data;
  const lines = useMemo(() => slip?.lines ?? [], [slip]);
  const totalLines = lines.length;
  const confirmedCount = lines.filter(
    (l) => l.confirmStatus === "picked" || l.confirmStatus === "short",
  ).length;
  const allDone = totalLines > 0 && confirmedCount === totalLines;

  // Track the active line index. We move forward automatically after a
  // confirm, but the chevrons let the picker walk Back / Next freely.
  const [activeIdx, setActiveIdx] = useState(0);
  const initialisedRef = useRef(false);
  useEffect(() => {
    if (initialisedRef.current || lines.length === 0) return;
    const firstPending = lines.findIndex(
      (l) => l.confirmStatus !== "picked" && l.confirmStatus !== "short",
    );
    setActiveIdx(firstPending === -1 ? 0 : firstPending);
    initialisedRef.current = true;
  }, [lines]);

  // Auto-start the slip on first view if it's still pending.
  useEffect(() => {
    if (!slip) return;
    if (slip.status === "pending") {
      void pickerMutate({
        path: `/sales/pick-slips/${slip.id}/start`,
        method: "POST",
        body: {},
        label: `Start ${slip.code}`,
      }).then(() => slipQuery.refetch());
    }
  }, [slip, slipQuery]);

  // Lock the screen to portrait for the duration of the slip view. Best
  // effort — most desktop browsers and non-fullscreen tabs will reject this,
  // which is fine.
  useEffect(() => {
    const orientation = (typeof screen !== "undefined" ? screen.orientation : undefined) as
      | (ScreenOrientation & { lock?: (o: string) => Promise<void> })
      | undefined;
    if (orientation && typeof orientation.lock === "function") {
      orientation.lock("portrait").catch(() => undefined);
    }
    return () => {
      if (orientation && typeof orientation.unlock === "function") {
        try {
          orientation.unlock();
        } catch {
          /* ignore */
        }
      }
    };
  }, []);

  // Keep useOfflineQueue mounted so the status bar / sync logic continues to
  // run while the picker is in the camera view.
  useOfflineQueue();

  if (!Number.isFinite(slipId)) {
    return <FullScreenMessage tone="error" message="Invalid slip id." onQuit={() => setLocation("/picking")} />;
  }
  if (slipQuery.isLoading) {
    return <FullScreenMessage tone="info" message="Loading slip…" onQuit={() => setLocation("/picking")} />;
  }
  if (!slip) {
    return <FullScreenMessage tone="error" message="Slip not found." onQuit={() => setLocation("/picking")} />;
  }

  const activeLine = lines[activeIdx];

  return (
    <CameraSlipView
      slip={slip}
      lines={lines}
      activeIdx={activeIdx}
      activeLine={activeLine}
      totalLines={totalLines}
      confirmedCount={confirmedCount}
      allDone={allDone}
      onPrev={() => setActiveIdx((i) => Math.max(0, i - 1))}
      onNext={() => setActiveIdx((i) => Math.min(lines.length - 1, i + 1))}
      onConfirmed={() => {
        toast({ title: "Line confirmed" });
        // Move forward to the next un-confirmed line if there is one.
        const nextPending = lines.findIndex((l, idx) => {
          if (idx <= activeIdx) return false;
          return l.confirmStatus !== "picked" && l.confirmStatus !== "short";
        });
        if (nextPending !== -1) setActiveIdx(nextPending);
        else if (activeIdx < lines.length - 1) setActiveIdx(activeIdx + 1);
        void slipQuery.refetch();
      }}
      onQuit={() => {
        if (window.confirm("Leave this pick slip? Any unsaved input on this line will be lost.")) {
          setLocation("/picking");
        }
      }}
      onFinish={async () => {
        if (!window.confirm("Mark this slip as picked and send it to despatch?")) return;
        const result = await pickerMutate<PickSlip>({
          path: `/sales/pick-slips/${slip.id}/complete`,
          method: "POST",
          body: {},
          label: `Complete ${slip.code}`,
        });
        if (result.offline) {
          toast({ title: "Queued offline", description: `${slip.code} will complete when back online.` });
        } else {
          toast({ title: "Slip completed", description: slip.code });
        }
        setLocation("/picking");
      }}
    />
  );
}

interface CameraSlipViewProps {
  slip: PickSlip;
  lines: PickSlipLine[];
  activeIdx: number;
  activeLine: PickSlipLine | undefined;
  totalLines: number;
  confirmedCount: number;
  allDone: boolean;
  onPrev: () => void;
  onNext: () => void;
  onConfirmed: () => void;
  onQuit: () => void;
  onFinish: () => void;
}

function CameraSlipView({
  slip,
  lines,
  activeIdx,
  activeLine,
  totalLines,
  confirmedCount,
  allDone,
  onPrev,
  onNext,
  onConfirmed,
  onQuit,
  onFinish,
}: CameraSlipViewProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameraReady, setCameraReady] = useState(false);

  // Keep one rear-camera stream alive for the whole slip session.
  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("Camera not available in this browser.");
        }
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          video.muted = true;
          video.playsInline = true;
          await video.play().catch(() => undefined);
          setCameraReady(true);
        }
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setCameraError(message || "Camera unavailable");
      }
    })();
    return () => {
      cancelled = true;
      if (stream) stream.getTracks().forEach((t) => t.stop());
      const video = videoRef.current;
      if (video) video.srcObject = null;
    };
  }, []);

  const captureFrame = useCallback(async (): Promise<Blob | null> => {
    const video = videoRef.current;
    if (!video || !cameraReady) return null;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return null;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, w, h);
    return await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/jpeg", 0.85),
    );
  }, [cameraReady]);

  return (
    <div
      className="fixed inset-0 z-40 flex flex-col bg-black text-white select-none"
      data-testid="picker-camera-shell"
    >
      {/* Live camera feed */}
      <video
        ref={videoRef}
        className="absolute inset-0 h-full w-full object-cover"
        playsInline
        muted
        autoPlay
        data-testid="picker-camera-video"
      />
      {!cameraReady && !cameraError ? (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80 text-sm text-white/70">
          Starting camera…
        </div>
      ) : null}
      {cameraError ? (
        <div
          className="absolute left-1/2 top-1/2 z-10 w-[80%] -translate-x-1/2 -translate-y-1/2 rounded bg-red-900/90 p-4 text-center text-sm"
          data-testid="picker-camera-error"
        >
          {cameraError}
          <div className="mt-2 text-xs text-white/70">
            You can still confirm picks — the photo step will be skipped.
          </div>
        </div>
      ) : null}

      {/* Top translucent banner — item, location, progress */}
      <TopBanner
        slip={slip}
        line={activeLine}
        confirmedCount={confirmedCount}
        totalLines={totalLines}
        activeIdx={activeIdx}
        onQuit={onQuit}
      />

      {/* Side chevrons for non-confirming Back / Next */}
      <SideChevrons
        canPrev={activeIdx > 0}
        canNext={activeIdx < lines.length - 1}
        onPrev={onPrev}
        onNext={onNext}
      />

      {/* Bottom panel — picked qty, barcode, shutter, short-pick, finish */}
      {activeLine ? (
        <BottomPanel
          slipId={slip.id}
          line={activeLine}
          allDone={allDone}
          captureFrame={captureFrame}
          cameraAvailable={cameraReady && !cameraError}
          onConfirmed={onConfirmed}
          onFinish={onFinish}
        />
      ) : (
        <div className="absolute inset-x-0 bottom-0 z-10 bg-black/70 p-4 text-center text-sm">
          No lines on this slip.
          <button
            type="button"
            onClick={onQuit}
            className="ml-3 rounded bg-white/20 px-3 py-1 text-sm"
            data-testid="button-quit-empty"
          >
            Back to queue
          </button>
        </div>
      )}
    </div>
  );
}

function TopBanner({
  slip,
  line,
  confirmedCount,
  totalLines,
  activeIdx,
  onQuit,
}: {
  slip: PickSlip;
  line: PickSlipLine | undefined;
  confirmedCount: number;
  totalLines: number;
  activeIdx: number;
  onQuit: () => void;
}) {
  // Voice readout when the active line changes.
  useEffect(() => {
    if (!line) return;
    const required = Number(line.requiredQty);
    const where = line.locationLabel ? `at ${line.locationLabel}` : "";
    speak(
      `Pick ${required} ${line.uom ?? ""} of ${line.itemName ?? line.itemCode ?? "item"} ${where}`.trim(),
    );
  }, [line?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className="absolute inset-x-0 top-0 z-10 bg-black/60 px-3 pt-[env(safe-area-inset-top)] pb-3 text-white backdrop-blur-sm"
      data-testid="picker-top-banner"
    >
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={onQuit}
          className="rounded bg-white/15 px-3 py-1.5 text-sm font-medium"
          data-testid="button-quit-slip"
        >
          ✕ Quit
        </button>
        <div className="flex flex-col items-center text-center">
          <div className="text-xs uppercase tracking-wide text-white/70" data-testid="text-slip-code">
            {slip.code}
          </div>
          <div className="text-xs text-white/80" data-testid="text-line-progress">
            Line {Math.min(activeIdx + 1, Math.max(totalLines, 1))} of {totalLines} ·{" "}
            {confirmedCount} done
          </div>
        </div>
        <div className="w-[68px] text-right">
          <span
            className="rounded bg-white/15 px-2 py-1 text-xs uppercase tracking-wide"
            data-testid="text-slip-status"
          >
            {slip.status}
          </span>
        </div>
      </div>
      {line ? (
        <div className="mt-2 grid grid-cols-[1fr_auto] gap-2">
          <div>
            <div
              className="truncate text-lg font-semibold leading-tight"
              data-testid="text-line-item-name"
              title={line.itemName ?? line.itemCode ?? ""}
            >
              {line.itemName ?? line.itemCode ?? `#${line.itemId}`}
            </div>
            <div className="text-xs text-white/70" data-testid="text-line-item-code">
              SKU {line.itemCode ?? `#${line.itemId}`}
            </div>
          </div>
          <div className="rounded bg-white/15 px-2 py-1 text-right">
            <div className="text-[10px] uppercase tracking-wide text-white/70">Location</div>
            <div className="text-sm font-semibold" data-testid="text-line-location">
              {line.locationLabel ?? "—"}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SideChevrons({
  canPrev,
  canNext,
  onPrev,
  onNext,
}: {
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  return (
    <>
      <button
        type="button"
        onClick={onPrev}
        disabled={!canPrev}
        aria-label="Previous line"
        className="absolute left-2 top-1/2 z-10 flex h-14 w-14 -translate-y-1/2 items-center justify-center rounded-full bg-white/15 text-3xl text-white backdrop-blur-sm transition disabled:opacity-30"
        data-testid="button-prev-line"
      >
        ‹
      </button>
      <button
        type="button"
        onClick={onNext}
        disabled={!canNext}
        aria-label="Next line"
        className="absolute right-2 top-1/2 z-10 flex h-14 w-14 -translate-y-1/2 items-center justify-center rounded-full bg-white/15 text-3xl text-white backdrop-blur-sm transition disabled:opacity-30"
        data-testid="button-next-line"
      >
        ›
      </button>
    </>
  );
}

interface BottomPanelProps {
  slipId: number;
  line: PickSlipLine;
  allDone: boolean;
  cameraAvailable: boolean;
  captureFrame: () => Promise<Blob | null>;
  onConfirmed: () => void;
  onFinish: () => void;
}

function BottomPanel({
  slipId,
  line,
  allDone,
  cameraAvailable,
  captureFrame,
  onConfirmed,
  onFinish,
}: BottomPanelProps) {
  const { toast } = useToast();
  const required = Number(line.requiredQty);
  const [pickedQty, setPickedQty] = useState<string>(String(required));
  const [barcode, setBarcode] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [shortOpen, setShortOpen] = useState(false);

  // Reset per-line input whenever the active line changes.
  useEffect(() => {
    setPickedQty(String(Number(line.requiredQty)));
    setBarcode("");
    setShortOpen(false);
  }, [line.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleShutter() {
    const qty = Number(pickedQty);
    if (!Number.isFinite(qty) || qty < 0) {
      toast({ title: "Enter a valid picked qty", variant: "destructive" });
      return;
    }
    if (qty > required) {
      toast({ title: "Picked qty cannot exceed required", variant: "destructive" });
      return;
    }
    if (line.barcode && barcode && barcode !== line.barcode) {
      toast({ title: "Scanned barcode does not match", variant: "destructive" });
      return;
    }
    setBusy(true);
    let photoArg: { blob: Blob; name: string } | undefined;
    if (cameraAvailable) {
      const blob = await captureFrame();
      if (blob) photoArg = { blob, name: `pick-slip-${slipId}-line-${line.id}.jpg` };
    }
    const result = await pickerMutate<PickSlipLine>({
      path: `/sales/pick-slips/${slipId}/lines/${line.id}/confirm`,
      method: "POST",
      body: {
        pickedQty: qty,
        scannedBarcode: barcode || undefined,
      },
      label: `Confirm ${line.itemCode ?? line.itemId} on slip ${slipId}`,
      photo: photoArg,
    });
    setBusy(false);
    if (result.offline) {
      const desc = result.photoQueued
        ? "Pick + photo will sync when back online"
        : "Pick will sync when back online";
      toast({ title: "Queued offline", description: desc });
    }
    onConfirmed();
  }

  async function submitShort(reason: ShortReason, note: string) {
    setBusy(true);
    const qty = Number(pickedQty);
    let photoArg: { blob: Blob; name: string } | undefined;
    if (cameraAvailable) {
      const blob = await captureFrame();
      if (blob) photoArg = { blob, name: `pick-slip-${slipId}-line-${line.id}.jpg` };
    }
    const result = await pickerMutate<PickSlipLine>({
      path: `/sales/pick-slips/${slipId}/lines/${line.id}/short-pick`,
      method: "POST",
      body: {
        reason,
        pickedQty: Number.isFinite(qty) ? qty : 0,
        note: note || undefined,
      },
      label: `Short-pick ${line.itemCode ?? line.itemId} on slip ${slipId}`,
      photo: photoArg,
    });
    setBusy(false);
    setShortOpen(false);
    if (result.offline) {
      const desc = result.photoQueued
        ? "Short-pick + photo will sync when back online"
        : "Short-pick will sync when back online";
      toast({ title: "Queued offline", description: desc });
    }
    onConfirmed();
  }

  const lineDone = line.confirmStatus === "picked" || line.confirmStatus === "short";

  return (
    <>
      <div
        className="absolute inset-x-0 bottom-0 z-10 bg-black/60 px-3 pt-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] backdrop-blur-sm"
        data-testid="picker-bottom-panel"
      >
        <div className="grid grid-cols-[1fr_1fr] gap-2">
          <label className="block">
            <span className="text-[10px] font-medium uppercase tracking-wide text-white/70">
              Picked qty (of {required} {line.uom ?? ""})
            </span>
            <input
              type="number"
              inputMode="decimal"
              min={0}
              max={required}
              step="any"
              value={pickedQty}
              onChange={(e) => setPickedQty(e.target.value)}
              className="mt-1 w-full rounded border border-white/30 bg-white/95 px-3 py-3 text-lg font-semibold text-slate-900"
              data-testid="input-picked-qty"
            />
          </label>
          <label className="block">
            <span className="text-[10px] font-medium uppercase tracking-wide text-white/70">
              Barcode (optional)
            </span>
            <input
              type="text"
              value={barcode}
              onChange={(e) => setBarcode(e.target.value)}
              placeholder={line.barcode ?? "—"}
              className="mt-1 w-full rounded border border-white/30 bg-white/95 px-3 py-3 text-base text-slate-900"
              data-testid="input-barcode"
            />
          </label>
        </div>

        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShortOpen(true)}
            disabled={busy}
            className="rounded bg-amber-500/90 px-3 py-3 text-sm font-medium text-white disabled:opacity-50"
            data-testid="button-open-short-pick"
          >
            Short-pick
          </button>
          <button
            type="button"
            onClick={() => void handleShutter()}
            disabled={busy}
            className="flex-1 rounded-full bg-emerald-500 px-4 py-4 text-base font-bold text-white shadow-lg ring-4 ring-white/40 disabled:opacity-50"
            data-testid="button-shutter"
          >
            {busy
              ? "Saving…"
              : lineDone
              ? "Re-capture & confirm"
              : cameraAvailable
              ? "📸 Capture & confirm"
              : "Confirm (no photo)"}
          </button>
          {allDone ? (
            <button
              type="button"
              onClick={onFinish}
              disabled={busy}
              className="rounded bg-blue-600 px-3 py-3 text-sm font-semibold text-white disabled:opacity-50"
              data-testid="button-finish-slip"
            >
              Finish
            </button>
          ) : null}
        </div>
      </div>

      {shortOpen ? (
        <ShortPickOverlay
          line={line}
          busy={busy}
          onCancel={() => setShortOpen(false)}
          onSubmit={(reason, note) => void submitShort(reason, note)}
        />
      ) : null}
    </>
  );
}

function ShortPickOverlay({
  line,
  busy,
  onCancel,
  onSubmit,
}: {
  line: PickSlipLine;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (reason: ShortReason, note: string) => void;
}) {
  const [reason, setReason] = useState<ShortReason | "">("");
  const [note, setNote] = useState("");
  return (
    <div
      className="absolute inset-0 z-20 flex items-end justify-center bg-black/50 backdrop-blur-sm"
      data-testid="overlay-short-pick"
    >
      <div className="w-full max-w-md rounded-t-2xl bg-slate-900/95 p-4 text-white">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-base font-semibold">Short-pick {line.itemCode ?? line.itemName}</h3>
          <button
            type="button"
            onClick={onCancel}
            className="rounded bg-white/15 px-2 py-1 text-sm"
            data-testid="button-close-short-pick"
          >
            Close
          </button>
        </div>
        <select
          value={reason}
          onChange={(e) => setReason(e.target.value as ShortReason | "")}
          className="w-full rounded border border-white/20 bg-white/95 px-3 py-2 text-sm text-slate-900"
          data-testid="select-short-reason"
        >
          <option value="">Pick reason…</option>
          {SHORT_REASONS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note (optional)"
          rows={2}
          className="mt-2 w-full rounded border border-white/20 bg-white/95 px-3 py-2 text-sm text-slate-900"
          data-testid="input-short-note"
        />
        <button
          type="button"
          disabled={busy || !reason}
          onClick={() => reason && onSubmit(reason, note)}
          className="mt-3 w-full rounded bg-amber-500 px-3 py-3 text-base font-semibold text-white disabled:opacity-50"
          data-testid="button-confirm-short-pick"
        >
          {busy ? "Saving…" : "Submit short-pick"}
        </button>
      </div>
    </div>
  );
}

function FullScreenMessage({
  tone,
  message,
  onQuit,
}: {
  tone: "info" | "error";
  message: string;
  onQuit: () => void;
}) {
  return (
    <div className="fixed inset-0 z-40 flex flex-col items-center justify-center gap-3 bg-slate-900 text-white">
      <div className={tone === "error" ? "text-red-300" : "text-white/80"}>{message}</div>
      <button
        type="button"
        onClick={onQuit}
        className="rounded bg-white/15 px-4 py-2 text-sm"
        data-testid="button-quit-message"
      >
        Back to queue
      </button>
    </div>
  );
}
