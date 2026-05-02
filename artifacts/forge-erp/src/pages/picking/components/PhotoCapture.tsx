/**
 * Capture a confirmation photo. Uses the native `<input type="file" capture>`
 * which:
 *   • opens the rear camera on mobile/tablet
 *   • falls back to the file picker on desktop
 *   • requires no extra permissions plumbing
 */
import { useRef, useState } from "react";

export interface PhotoCaptureProps {
  value: { previewUrl: string; blob: Blob } | null;
  onChange: (value: { previewUrl: string; blob: Blob } | null) => void;
}

export function PhotoCapture({ value, onChange }: PhotoCaptureProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleSelect(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      setError("Photo too large (max 10MB)");
      return;
    }
    setError(null);
    const previewUrl = URL.createObjectURL(file);
    onChange({ previewUrl, blob: file });
  }

  function handleClear() {
    if (value?.previewUrl) URL.revokeObjectURL(value.previewUrl);
    onChange(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <div className="flex flex-col gap-2">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={handleSelect}
        data-testid="input-photo-capture"
      />
      {value ? (
        <div className="flex items-start gap-3">
          <img src={value.previewUrl} alt="Pick photo" className="h-24 w-24 rounded border object-cover" />
          <button
            type="button"
            className="text-sm text-red-600 underline"
            onClick={handleClear}
            data-testid="button-clear-photo"
          >
            Remove photo
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="rounded border border-dashed border-slate-400 px-4 py-3 text-sm text-slate-600"
          onClick={() => inputRef.current?.click()}
          data-testid="button-take-photo"
        >
          Take photo (optional)
        </button>
      )}
      {error ? <div className="text-xs text-red-600">{error}</div> : null}
    </div>
  );
}
