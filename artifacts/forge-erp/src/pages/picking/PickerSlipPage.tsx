/**
 * One-task-at-a-time guided picking flow.
 *
 * The slip's lines are walked through in order. For each line the picker:
 *   1. Sees the location, expected item & qty (with optional voice readout).
 *   2. Optionally scans the item barcode (verified against `line.barcode`).
 *   3. Enters lot/serial/batch (if required by the item) and the picked qty.
 *   4. Optionally captures a confirmation photo.
 *   5. Hits CONFIRM (full pick) or SHORT (records reason).
 *
 * On the last line, the slip is auto-completed by the API helper.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRoute } from "wouter";
import { PickerLayout } from "./PickerLayout";
import { BarcodeScanner } from "./components/BarcodeScanner";
import { PhotoCapture } from "./components/PhotoCapture";
import { pickerGet, pickerMutate, pickerUploadPhoto } from "./lib/api";
import type { PickSlip, PickSlipLine } from "./lib/types";
import { speak } from "./lib/voice";
import { useToast } from "@/hooks/use-toast";

const SHORT_REASONS = [
  { value: "out_of_stock", label: "Out of stock" },
  { value: "wrong_location", label: "Wrong location" },
  { value: "damaged", label: "Damaged" },
  { value: "other", label: "Other" },
] as const;

export default function PickerSlipPage() {
  const [, params] = useRoute<{ id: string }>("/picking/slip/:id");
  const slipId = Number(params?.id);
  const { toast } = useToast();

  const slipQuery = useQuery({
    queryKey: ["picker", "slip", slipId],
    queryFn: () => pickerGet<PickSlip>(`/sales/pick-slips/${slipId}`),
    enabled: Number.isFinite(slipId),
  });

  const slip = slipQuery.data;
  const lines = useMemo(() => slip?.lines ?? [], [slip]);

  // Index of the next un-confirmed line. Picker UX: always advance forward.
  const [activeIdx, setActiveIdx] = useState(0);
  useEffect(() => {
    const firstPending = lines.findIndex((l) => l.confirmStatus !== "picked" && l.confirmStatus !== "short");
    setActiveIdx(firstPending === -1 ? Math.max(0, lines.length - 1) : firstPending);
  }, [lines]);

  // Auto-start the slip on first view if it's still pending.
  useEffect(() => {
    if (!slip) return;
    if (slip.status === "pending") {
      void pickerMutate({ path: `/sales/pick-slips/${slip.id}/start`, method: "POST", body: {}, label: `Start ${slip.code}` })
        .then(() => slipQuery.refetch());
    }
  }, [slip, slipQuery]);

  if (!Number.isFinite(slipId)) {
    return (
      <PickerLayout title="Pick slip" back={{ label: "Queue", to: "/picking" }}>
        <div className="p-4 text-sm text-red-600">Invalid slip id.</div>
      </PickerLayout>
    );
  }
  if (slipQuery.isLoading) {
    return (
      <PickerLayout title="Loading…" back={{ label: "Queue", to: "/picking" }}>
        <div className="p-4 text-sm text-slate-500">Loading slip…</div>
      </PickerLayout>
    );
  }
  if (!slip) {
    return (
      <PickerLayout title="Not found" back={{ label: "Queue", to: "/picking" }}>
        <div className="p-4 text-sm text-red-600">Slip not found.</div>
      </PickerLayout>
    );
  }

  const totalLines = lines.length;
  const confirmedCount = lines.filter((l) => l.confirmStatus === "picked" || l.confirmStatus === "short").length;
  const allDone = totalLines > 0 && confirmedCount === totalLines;
  const activeLine = lines[activeIdx];

  return (
    <PickerLayout
      title={`${slip.code} · ${confirmedCount}/${totalLines}`}
      back={{ label: "Queue", to: "/picking" }}
      right={
        <span className="rounded bg-white/20 px-2 py-1 text-xs" data-testid="text-slip-status">
          {slip.status}
        </span>
      }
    >
      <div className="mx-auto w-full max-w-xl p-4 space-y-4">
        <ProgressBar value={confirmedCount} total={totalLines} />

        {allDone ? (
          <CompletePanel slip={slip} onChange={() => slipQuery.refetch()} />
        ) : activeLine ? (
          <LineCard
            key={activeLine.id}
            slipId={slip.id}
            line={activeLine}
            onConfirmed={() => {
              toast({ title: "Line confirmed" });
              void slipQuery.refetch();
            }}
          />
        ) : (
          <p className="text-slate-600">No lines on this slip.</p>
        )}

        <LineList
          lines={lines}
          activeIdx={activeIdx}
          onPick={(idx) => setActiveIdx(idx)}
        />
      </div>
    </PickerLayout>
  );
}

function ProgressBar({ value, total }: { value: number; total: number }) {
  const pct = total === 0 ? 0 : Math.round((value / total) * 100);
  return (
    <div data-testid="progress-bar">
      <div className="mb-1 flex justify-between text-xs text-slate-600">
        <span>Progress</span>
        <span>{pct}%</span>
      </div>
      <div className="h-2 w-full rounded bg-slate-200">
        <div className="h-full rounded bg-emerald-600 transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function CompletePanel({ slip, onChange }: { slip: PickSlip; onChange: () => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const isComplete = slip.status === "picked";

  async function complete() {
    setBusy(true);
    const result = await pickerMutate<PickSlip>({
      path: `/sales/pick-slips/${slip.id}/complete`,
      method: "POST",
      body: {},
      label: `Complete ${slip.code}`,
    });
    setBusy(false);
    if (result.offline) {
      toast({ title: "Queued offline", description: `${slip.code} will complete when back online.` });
    } else {
      toast({ title: "Slip completed", description: slip.code });
    }
    onChange();
  }

  return (
    <div className="rounded-lg border bg-emerald-50 p-4 text-emerald-900" data-testid="panel-complete">
      <h2 className="text-lg font-semibold">All lines confirmed</h2>
      <p className="text-sm">Mark the slip as picked to send it to despatch.</p>
      <button
        type="button"
        className="mt-3 w-full rounded bg-emerald-600 px-3 py-3 text-base font-medium text-white disabled:opacity-50"
        onClick={() => void complete()}
        disabled={busy || isComplete}
        data-testid="button-complete-slip"
      >
        {isComplete ? "Slip completed" : busy ? "Completing…" : "Complete slip"}
      </button>
    </div>
  );
}

function LineList({
  lines,
  activeIdx,
  onPick,
}: {
  lines: PickSlipLine[];
  activeIdx: number;
  onPick: (idx: number) => void;
}) {
  return (
    <details className="rounded-lg border bg-white">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium" data-testid="summary-line-list">
        All lines ({lines.length})
      </summary>
      <ol className="divide-y">
        {lines.map((line, idx) => (
          <li
            key={line.id}
            className={`flex items-center justify-between px-3 py-2 text-sm ${idx === activeIdx ? "bg-blue-50" : ""}`}
          >
            <div>
              <div className="font-medium">{line.itemCode ?? `#${line.itemId}`} — {line.itemName}</div>
              <div className="text-xs text-slate-500">
                {line.locationLabel ?? "—"} · qty {line.requiredQty} {line.uom ?? ""}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <LineStatus status={line.confirmStatus ?? "pending"} />
              <button
                type="button"
                className="text-xs text-blue-600 underline"
                onClick={() => onPick(idx)}
                data-testid={`button-jump-line-${line.id}`}
              >
                Open
              </button>
            </div>
          </li>
        ))}
      </ol>
    </details>
  );
}

function LineStatus({ status }: { status: NonNullable<PickSlipLine["confirmStatus"]> }) {
  const map: Record<NonNullable<PickSlipLine["confirmStatus"]>, string> = {
    pending: "bg-slate-200 text-slate-800",
    picked: "bg-emerald-600 text-white",
    short: "bg-amber-500 text-white",
  };
  return <span className={`rounded px-2 py-0.5 text-xs capitalize ${map[status]}`}>{status}</span>;
}

interface LineCardProps {
  slipId: number;
  line: PickSlipLine;
  onConfirmed: () => void;
}

function LineCard({ slipId, line, onConfirmed }: LineCardProps) {
  const { toast } = useToast();
  const required = Number(line.requiredQty);
  const [pickedQty, setPickedQty] = useState<string>(String(line.pickedQty ?? required));
  const [lot, setLot] = useState(line.lotNumber ?? "");
  const [serial, setSerial] = useState(line.serialNumber ?? "");
  const [batch, setBatch] = useState(line.batchNumber ?? "");
  const [scannedBarcode, setScannedBarcode] = useState<string>("");
  const [scanError, setScanError] = useState<string | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [photo, setPhoto] = useState<{ previewUrl: string; blob: Blob } | null>(null);
  const [shortReason, setShortReason] = useState<typeof SHORT_REASONS[number]["value"] | "">("");
  const [shortNote, setShortNote] = useState("");
  const [busy, setBusy] = useState(false);

  // Voice readout when this line becomes active.
  useEffect(() => {
    const where = line.locationLabel ? `at ${line.locationLabel}` : "";
    speak(`Pick ${required} ${line.uom ?? ""} of ${line.itemName ?? line.itemCode ?? "item"} ${where}`.trim());
  }, [line.id, line.locationLabel, line.itemName, line.itemCode, line.uom, required]);

  function handleScan(decoded: string) {
    setScannedBarcode(decoded);
    setScannerOpen(false);
    if (line.barcode && decoded !== line.barcode) {
      setScanError(`Barcode mismatch: scanned ${decoded}, expected ${line.barcode}`);
    } else {
      setScanError(null);
      toast({ title: "Barcode matched" });
    }
  }

  async function uploadPhotoIfPresent(): Promise<string | null> {
    if (!photo) return null;
    return pickerUploadPhoto(photo.blob, `pick-slip-${slipId}-line-${line.id}.jpg`);
  }

  async function confirmPick() {
    const qty = Number(pickedQty);
    if (!Number.isFinite(qty) || qty < 0) {
      toast({ title: "Enter a valid picked qty", variant: "destructive" });
      return;
    }
    if (qty > required) {
      toast({ title: "Picked qty cannot exceed required", variant: "destructive" });
      return;
    }
    if (line.barcode && scannedBarcode && scannedBarcode !== line.barcode) {
      toast({ title: "Scanned barcode does not match", variant: "destructive" });
      return;
    }
    setBusy(true);
    const photoObjectPath = await uploadPhotoIfPresent();
    const result = await pickerMutate<PickSlipLine>({
      path: `/sales/pick-slips/${slipId}/lines/${line.id}/confirm`,
      method: "POST",
      body: {
        pickedQty: qty,
        lotNumber: lot || undefined,
        serialNumber: serial || undefined,
        batchNumber: batch || undefined,
        photoObjectPath: photoObjectPath ?? undefined,
        scannedBarcode: scannedBarcode || undefined,
      },
      label: `Confirm ${line.itemCode ?? line.itemId} on slip ${slipId}`,
    });
    setBusy(false);
    if (result.offline) {
      toast({ title: "Queued offline", description: "Pick will sync when back online" });
    }
    onConfirmed();
  }

  async function shortPick() {
    if (!shortReason) {
      toast({ title: "Pick a reason for the short", variant: "destructive" });
      return;
    }
    setBusy(true);
    const photoObjectPath = await uploadPhotoIfPresent();
    const qty = Number(pickedQty);
    const result = await pickerMutate<PickSlipLine>({
      path: `/sales/pick-slips/${slipId}/lines/${line.id}/short-pick`,
      method: "POST",
      body: {
        reason: shortReason,
        pickedQty: Number.isFinite(qty) ? qty : 0,
        note: shortNote || undefined,
        photoObjectPath: photoObjectPath ?? undefined,
      },
      label: `Short-pick ${line.itemCode ?? line.itemId} on slip ${slipId}`,
    });
    setBusy(false);
    if (result.offline) {
      toast({ title: "Queued offline", description: "Short-pick will sync when back online" });
    }
    onConfirmed();
  }

  return (
    <div className="rounded-lg border bg-white p-4 shadow-sm" data-testid={`card-line-${line.id}`}>
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Pick this</div>
      <div className="text-2xl font-bold leading-tight" data-testid="text-line-item-name">
        {line.itemName ?? line.itemCode ?? `#${line.itemId}`}
      </div>
      <div className="text-sm text-slate-600">SKU {line.itemCode ?? `#${line.itemId}`}</div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
        <div className="rounded bg-slate-100 p-2">
          <div className="text-xs uppercase text-slate-500">Location</div>
          <div className="text-lg font-semibold" data-testid="text-line-location">
            {line.locationLabel ?? "—"}
          </div>
        </div>
        <div className="rounded bg-slate-100 p-2">
          <div className="text-xs uppercase text-slate-500">Required</div>
          <div className="text-lg font-semibold" data-testid="text-line-required">
            {required} {line.uom ?? ""}
          </div>
        </div>
      </div>

      <div className="mt-4 space-y-3">
        <div>
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium">Picked qty</label>
            <button
              type="button"
              className="text-xs text-blue-700 underline"
              onClick={() => setPickedQty(String(required))}
              data-testid="button-fill-required"
            >
              Use required ({required})
            </button>
          </div>
          <input
            type="number"
            inputMode="decimal"
            min={0}
            max={required}
            step="any"
            value={pickedQty}
            onChange={(e) => setPickedQty(e.target.value)}
            className="mt-1 w-full rounded border border-slate-300 px-3 py-3 text-lg"
            data-testid="input-picked-qty"
          />
        </div>

        <div>
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium">Barcode</label>
            <button
              type="button"
              className="rounded bg-slate-900 px-3 py-1 text-xs text-white"
              onClick={() => setScannerOpen(true)}
              data-testid="button-open-scanner"
            >
              Scan
            </button>
          </div>
          <input
            type="text"
            value={scannedBarcode}
            onChange={(e) => {
              setScannedBarcode(e.target.value);
              setScanError(null);
            }}
            placeholder={line.barcode ?? "(not required)"}
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm"
            data-testid="input-barcode"
          />
          {scanError ? <div className="mt-1 text-xs text-red-600" data-testid="text-scan-error">{scanError}</div> : null}
        </div>

        <div className="grid grid-cols-3 gap-2">
          <FieldText label="Lot #" value={lot} onChange={setLot} testId="input-lot" />
          <FieldText label="Serial #" value={serial} onChange={setSerial} testId="input-serial" />
          <FieldText label="Batch #" value={batch} onChange={setBatch} testId="input-batch" />
        </div>

        <PhotoCapture value={photo} onChange={setPhoto} />

        <div className="grid grid-cols-2 gap-2 pt-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void confirmPick()}
            className="rounded bg-emerald-600 px-3 py-3 text-base font-semibold text-white disabled:opacity-50"
            data-testid="button-confirm-line"
          >
            {busy ? "Saving…" : "Confirm"}
          </button>
          <details className="rounded border border-amber-300 bg-amber-50">
            <summary className="cursor-pointer px-3 py-3 text-center text-sm font-medium text-amber-900" data-testid="summary-short-pick">
              Short-pick
            </summary>
            <div className="space-y-2 p-3">
              <select
                value={shortReason}
                onChange={(e) => setShortReason(e.target.value as typeof shortReason)}
                className="w-full rounded border border-amber-300 px-2 py-2 text-sm"
                data-testid="select-short-reason"
              >
                <option value="">Pick reason…</option>
                {SHORT_REASONS.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
              <textarea
                value={shortNote}
                onChange={(e) => setShortNote(e.target.value)}
                placeholder="Note (optional)"
                rows={2}
                className="w-full rounded border border-amber-300 px-2 py-2 text-sm"
                data-testid="input-short-note"
              />
              <button
                type="button"
                onClick={() => void shortPick()}
                disabled={busy}
                className="w-full rounded bg-amber-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
                data-testid="button-confirm-short-pick"
              >
                {busy ? "Saving…" : "Submit short-pick"}
              </button>
            </div>
          </details>
        </div>
      </div>

      {scannerOpen ? <BarcodeScanner onScan={handleScan} onClose={() => setScannerOpen(false)} /> : null}
    </div>
  );
}

function FieldText({
  label,
  value,
  onChange,
  testId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  testId: string;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-slate-600">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded border border-slate-300 px-2 py-2 text-sm"
        data-testid={testId}
      />
    </label>
  );
}
