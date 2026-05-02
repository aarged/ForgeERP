/**
 * Lightweight wrapper around html5-qrcode for warehouse barcode scanning.
 * Loaded lazily so the QR scanner runtime isn't shipped with the main bundle
 * — the picker is only ~5 % of users for an ERP app.
 */
import { useEffect, useRef, useState } from "react";

export interface BarcodeScannerProps {
  onScan: (text: string) => void;
  onClose?: () => void;
}

export function BarcodeScanner({ onScan, onClose }: BarcodeScannerProps) {
  const containerId = "picker-scanner-container";
  const containerRef = useRef<HTMLDivElement | null>(null);
  const scannerRef = useRef<{ stop: () => Promise<void>; clear: () => void } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let stopFn: (() => Promise<void>) | null = null;
    (async () => {
      try {
        const mod = await import("html5-qrcode");
        const Html5Qrcode = mod.Html5Qrcode;
        if (cancelled || !containerRef.current) return;
        const scanner = new Html5Qrcode(containerId, /* verbose */ false);
        scannerRef.current = scanner as unknown as typeof scannerRef.current;
        const config = { fps: 10, qrbox: { width: 260, height: 180 } };
        await scanner.start(
          { facingMode: "environment" },
          config,
          (decoded) => onScan(decoded),
          () => undefined,
        );
        stopFn = () => scanner.stop().catch(() => undefined);
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(message || "Camera unavailable");
      }
    })();
    return () => {
      cancelled = true;
      if (stopFn) void stopFn();
    };
  }, [onScan]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black" data-testid="picker-scanner">
      <div className="flex items-center justify-between p-3 text-white">
        <span className="text-sm font-medium">Scan barcode</span>
        <button
          type="button"
          className="rounded bg-white/15 px-3 py-1 text-sm"
          onClick={onClose}
          data-testid="button-close-scanner"
        >
          Close
        </button>
      </div>
      <div className="flex-1 flex items-center justify-center">
        <div id={containerId} ref={containerRef} className="w-full max-w-md" />
      </div>
      {error ? (
        <div className="p-4 text-center text-sm text-red-300">
          {error}. You can still type the barcode manually.
        </div>
      ) : (
        <div className="p-3 text-center text-xs text-white/70">
          Aim the camera at the item barcode.
        </div>
      )}
    </div>
  );
}
