import { useEffect, useMemo, useRef, useState } from "react";
import { lookupItem } from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";

export type ItemSearchOption = {
  id: number;
  code: string;
  name: string;
  description?: string | null;
  salesPrice?: string | null;
  unitCost?: string | null;
};

/**
 * Type-to-search item field. The user types an item code or name and picks
 * from matching results in a dropdown. Typing an exact code and pressing
 * Enter (or blurring) resolves the item even when it is not in the preloaded
 * list, via an exact-code server lookup. Unknown codes show a "not found"
 * error and clear the selection so the caller can block submission.
 */
export function ItemSearchInput({
  value,
  items,
  onSelect,
  placeholder = "Type item code or name",
}: {
  value?: number;
  items: ItemSearchOption[];
  onSelect: (item: ItemSearchOption | null) => void;
  placeholder?: string;
}) {
  const labelForId = (id?: number) => {
    const it = items.find((i) => i.id === id);
    return it ? `${it.code} — ${it.name}` : "";
  };
  const [text, setText] = useState(() => labelForId(value));
  const [open, setOpen] = useState(false);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const commitToken = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // Reflect the canonical "CODE — Name" label when the resolved id changes.
  useEffect(() => {
    if (value != null) {
      const label = labelForId(value);
      if (label) {
        setText(label);
        setError(false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, items]);

  const matches = useMemo(() => {
    const q = text.trim().toLowerCase();
    if (!q) return items.slice(0, 20);
    return items
      .filter(
        (i) =>
          (i.code ?? "").toLowerCase().includes(q) ||
          (i.name ?? "").toLowerCase().includes(q),
      )
      .slice(0, 20);
  }, [text, items]);

  const pick = (item: ItemSearchOption) => {
    commitToken.current++;
    setText(`${item.code} — ${item.name}`);
    setError(false);
    setLoading(false);
    setOpen(false);
    onSelect(item);
  };

  const commit = async () => {
    const token = ++commitToken.current;
    setOpen(false);
    const t = text.trim();
    if (!t) {
      setError(false);
      onSelect(null);
      return;
    }
    // Already showing a resolved label — keep the selection.
    if (value != null && t === labelForId(value)) return;
    const lower = t.toLowerCase();
    const local =
      items.find((i) => (i.code ?? "").toLowerCase() === lower) ??
      (matches.length === 1 ? matches[0] : undefined);
    if (local) {
      pick(local);
      return;
    }
    // Not in the preloaded page — resolve against the live catalog by exact code.
    setLoading(true);
    onSelect(null);
    try {
      const found = await lookupItem({ code: t });
      if (token !== commitToken.current) return;
      pick({
        id: found.id ?? 0,
        code: found.code ?? t,
        name: found.name ?? "",
        description: found.description,
        salesPrice: found.salesPrice,
        unitCost: found.unitCost,
      });
    } catch {
      if (token !== commitToken.current) return;
      setError(true);
      onSelect(null);
    } finally {
      if (token === commitToken.current) setLoading(false);
    }
  };

  return (
    <div className="relative" ref={containerRef}>
      <Input
        value={text}
        placeholder={placeholder}
        onChange={(e) => {
          setText(e.target.value);
          setError(false);
          setOpen(true);
          // Text no longer matches the selection — clear it until re-resolved.
          if (value != null) onSelect(null);
        }}
        onFocus={() => setOpen(true)}
        onBlur={(e) => {
          // Ignore blur caused by clicking an option inside the dropdown.
          if (containerRef.current?.contains(e.relatedTarget as Node)) return;
          void commit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void commit();
          }
          if (e.key === "Escape") setOpen(false);
        }}
        className={error ? "border-red-500 focus-visible:ring-red-500" : ""}
        data-testid="input-item-search"
      />
      {open && matches.length > 0 && (
        <div className="absolute z-50 mt-1 w-full max-h-56 overflow-auto rounded-md border bg-popover text-popover-foreground shadow-md">
          {matches.map((it) => (
            <button
              key={it.id}
              type="button"
              className="w-full text-left px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(it)}
              data-testid={`option-item-${it.id}`}
            >
              <span className="font-mono text-xs mr-2">{it.code}</span>
              {it.name}
            </button>
          ))}
        </div>
      )}
      {loading && <p className="text-xs text-muted-foreground mt-0.5">Checking…</p>}
      {error && !loading && (
        <p className="text-xs text-red-600 mt-0.5" data-testid="text-item-not-found">
          Item not found
        </p>
      )}
    </div>
  );
}
