/**
 * Picker home — shows two queues:
 *   • "My tasks": pick slips already assigned to the signed-in picker.
 *   • "Available": unassigned slips the picker can claim with one tap.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { PickerLayout } from "./PickerLayout";
import { pickerGet, pickerMutate } from "./lib/api";
import type { PickSlip, PickSlipListResponse } from "./lib/types";
import { useToast } from "@/hooks/use-toast";

function priorityLabel(p: number | null | undefined): { label: string; className: string } {
  if (p == null) return { label: "Normal", className: "bg-slate-200 text-slate-700" };
  if (p >= 90) return { label: "Urgent", className: "bg-red-600 text-white" };
  if (p >= 60) return { label: "High", className: "bg-amber-500 text-white" };
  if (p <= 20) return { label: "Low", className: "bg-slate-200 text-slate-700" };
  return { label: "Normal", className: "bg-slate-200 text-slate-700" };
}

export default function PickerHomePage() {
  const { toast } = useToast();

  const myQuery = useQuery({
    queryKey: ["picker", "mine"],
    queryFn: () => pickerGet<PickSlipListResponse>("/sales/pick-slips/mine"),
    refetchInterval: 30_000,
  });
  const queueQuery = useQuery({
    queryKey: ["picker", "queue"],
    queryFn: () => pickerGet<PickSlipListResponse>("/sales/pick-slips/queue"),
    refetchInterval: 30_000,
  });

  const claim = async (slip: PickSlip) => {
    const result = await pickerMutate<PickSlip>({
      path: `/sales/pick-slips/${slip.id}/assign`,
      method: "POST",
      body: {},
      label: `Claim ${slip.code}`,
    });
    if (result.offline) {
      toast({ title: "Queued offline", description: `${slip.code} will be claimed when you're back online.` });
    } else {
      toast({ title: "Slip claimed", description: slip.code });
      void myQuery.refetch();
      void queueQuery.refetch();
    }
  };

  const myItems = myQuery.data?.data ?? [];
  const queueItems = (queueQuery.data?.data ?? []).filter((s) => !myItems.find((m) => m.id === s.id));

  return (
    <PickerLayout title="Pick queue">
      <div className="mx-auto w-full max-w-2xl space-y-6 p-4">
        <section data-testid="section-my-tasks">
          <h2 className="mb-2 text-sm font-semibold uppercase text-slate-600">My tasks</h2>
          {myQuery.isLoading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : myItems.length === 0 ? (
            <p className="text-sm text-slate-500">Nothing assigned yet — claim a slip from the queue below.</p>
          ) : (
            <ul className="space-y-2">
              {myItems.map((slip) => (
                <li key={slip.id}>
                  <Link
                    to={`/picking/slip/${slip.id}`}
                    className="block rounded-lg border bg-white p-3 shadow-sm active:bg-slate-100"
                    data-testid={`link-my-slip-${slip.id}`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="font-semibold">{slip.code}</div>
                      <SlipStatusBadge status={slip.status} />
                    </div>
                    <div className="mt-1 text-xs text-slate-600">
                      Order #{slip.soId} · Warehouse {slip.warehouseId}
                      {slip.dueAt ? ` · Due ${new Date(slip.dueAt).toLocaleString()}` : ""}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section data-testid="section-available">
          <h2 className="mb-2 text-sm font-semibold uppercase text-slate-600">Available to claim</h2>
          {queueQuery.isLoading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : queueItems.length === 0 ? (
            <p className="text-sm text-slate-500">No unassigned slips.</p>
          ) : (
            <ul className="space-y-2">
              {queueItems.map((slip) => {
                const pri = priorityLabel(slip.priority);
                return (
                  <li
                    key={slip.id}
                    className="rounded-lg border bg-white p-3 shadow-sm"
                    data-testid={`item-queue-slip-${slip.id}`}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="font-semibold">{slip.code}</div>
                        <div className="text-xs text-slate-600">
                          Order #{slip.soId} · Warehouse {slip.warehouseId}
                        </div>
                      </div>
                      <span className={`rounded px-2 py-0.5 text-xs ${pri.className}`}>{pri.label}</span>
                    </div>
                    <button
                      type="button"
                      className="mt-3 w-full rounded bg-slate-900 px-3 py-2 text-sm font-medium text-white"
                      onClick={() => void claim(slip)}
                      data-testid={`button-claim-slip-${slip.id}`}
                    >
                      Claim slip
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </PickerLayout>
  );
}

function SlipStatusBadge({ status }: { status: PickSlip["status"] }) {
  const map: Record<PickSlip["status"], string> = {
    pending: "bg-slate-200 text-slate-800",
    picking: "bg-blue-600 text-white",
    picked: "bg-emerald-600 text-white",
    cancelled: "bg-red-600 text-white",
  };
  return <span className={`rounded px-2 py-0.5 text-xs capitalize ${map[status]}`}>{status}</span>;
}
