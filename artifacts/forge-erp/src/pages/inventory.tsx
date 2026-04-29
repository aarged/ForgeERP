export default function Inventory() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-bold tracking-tight">Inventory</h2>
        <p className="text-muted-foreground">Manage stock, warehouses, and transfers.</p>
      </div>
      <div className="flex h-[400px] shrink-0 items-center justify-center rounded-md border border-dashed">
        <div className="mx-auto flex max-w-[420px] flex-col items-center justify-center text-center">
          <h3 className="mt-4 text-lg font-semibold">Coming Soon</h3>
          <p className="mb-4 mt-2 text-sm text-muted-foreground">
            The inventory module is currently under development.
          </p>
        </div>
      </div>
    </div>
  );
}
