/** Shapes returned by the picker endpoints in api-server/src/routes/sales.ts. */

export interface PickSlipLine {
  id: number;
  pickSlipId: number;
  itemId: number;
  itemCode: string | null;
  itemName: string | null;
  requiredQty: string | number;
  pickedQty: string | number | null;
  uom: string | null;
  locationLabel?: string | null;
  barcode?: string | null;
  lotNumber?: string | null;
  serialNumber?: string | null;
  batchNumber?: string | null;
  notes?: string | null;
  confirmStatus?: "pending" | "picked" | "short" | null;
  confirmedByClerkId?: string | null;
  confirmedByName?: string | null;
  confirmedAt?: string | null;
  photoObjectPath?: string | null;
  shortReason?: string | null;
  shortNote?: string | null;
}

export interface PickSlip {
  id: number;
  code: string;
  soId: number;
  warehouseId: number;
  status: "pending" | "picking" | "picked" | "cancelled";
  priority?: number | null;
  dueAt?: string | null;
  assignedToClerkId?: string | null;
  assignedToName?: string | null;
  assignedToEmail?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
  lines?: PickSlipLine[];
}

export interface PickSlipListResponse {
  data: PickSlip[];
  hasMore: boolean;
  page: number;
}

export interface PickProgressSlip {
  id: number;
  code: string;
  soId: number;
  status: PickSlip["status"];
  priority: number | null;
  assignedToName: string | null;
  startedAt: string | null;
  completedAt: string | null;
  dueAt: string | null;
  totalLines: number;
  confirmedLines: number;
  shortLines: number;
  pendingLines: number;
  progressPct: number;
  createdAt: string;
}

export interface PickProgressResponse {
  unassigned: number;
  inProgress: number;
  completedToday: number;
  shortPickedToday: number;
  slips: PickProgressSlip[];
}
