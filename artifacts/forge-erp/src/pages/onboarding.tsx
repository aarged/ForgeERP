import { useState, useEffect, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetOnboardingSession,
  useUpdateOnboardingSession,
  useValidateTaxId,
  useUploadOnboardingCsv,
  useLoadSampleData,
  useSetupPaymentIntent,
  useCompleteOnboarding,
  getGetCurrentUserQueryKey,
} from "@workspace/api-client-react";
import type {
  OnboardingInvite,
  OnboardingInviteRole,
} from "@workspace/api-client-react";
import { useUser } from "@clerk/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  Building2,
  Check,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Mail,
  Plus,
  Trash2,
  Users,
  Zap,
  Upload,
  Download,
  Package,
  Truck,
  UserCheck,
  Warehouse,
  Layers,
  CreditCard,
  Sparkles,
  CheckCircle2,
  AlertCircle,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { loadStripe } from "@stripe/stripe-js";
import {
  Elements,
  CardElement,
  useStripe,
  useElements,
} from "@stripe/react-stripe-js";

// ── Stripe setup ──────────────────────────────────────────────────────────────

const stripePublicKey = import.meta.env.VITE_STRIPE_PUBLIC_KEY as
  | string
  | undefined;
const stripePromise =
  stripePublicKey ? loadStripe(stripePublicKey) : Promise.resolve(null);

// ── Types ─────────────────────────────────────────────────────────────────────

type StepNum = 1 | 2 | 3 | 4 | 5;

type PlanId = "starter" | "growth" | "enterprise";
type InviteRoleId = OnboardingInviteRole;
type GlTemplate = "simple" | "standard" | "advanced";
type CsvType = "items" | "suppliers" | "customers";

interface WarehouseRow {
  id: string;
  name: string;
  code: string;
  city: string;
  state: string;
  country: string;
  isDefault: boolean;
}

interface DepartmentRow {
  id: string;
  name: string;
  code: string;
}

interface InviteRow {
  id: string;
  email: string;
  role: InviteRoleId;
}

interface WizardData {
  // Step 1
  companyName: string;
  tradingName: string;
  legalName: string;
  taxId: string;
  taxIdCountry: string;
  phone: string;
  email: string;
  website: string;
  addressLine1: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  fiscalYearStart: number;
  currency: string;
  timezone: string;
  industryType: string;
  // Step 2
  warehouses: WarehouseRow[];
  departments: DepartmentRow[];
  glTemplate: GlTemplate;
  // Step 3
  items: Record<string, string>[];
  suppliers: Record<string, string>[];
  customers: Record<string, string>[];
  // Step 4
  planTier: PlanId;
  stripePaymentMethodId?: string;
  // Step 5
  invites: InviteRow[];
}

function uid() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;
}

function defaultData(): WizardData {
  return {
    companyName: "",
    tradingName: "",
    legalName: "",
    taxId: "",
    taxIdCountry: typeof navigator !== "undefined"
      ? (navigator.language?.split("-")[1] ?? "US")
      : "US",
    phone: "",
    email: "",
    website: "",
    addressLine1: "",
    city: "",
    state: "",
    postalCode: "",
    country: "AU",
    fiscalYearStart: 7,
    currency: "AUD",
    timezone: typeof Intl !== "undefined"
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : "UTC",
    industryType: "",
    warehouses: [
      { id: uid(), name: "Main Warehouse", code: "WH01", city: "", state: "", country: "AU", isDefault: true },
    ],
    departments: [
      { id: uid(), name: "Operations", code: "OPS" },
    ],
    glTemplate: "standard",
    items: [],
    suppliers: [],
    customers: [],
    planTier: "growth",
    stripePaymentMethodId: undefined,
    invites: [],
  };
}

// ── Constants ─────────────────────────────────────────────────────────────────

const STEPS: Array<{ id: StepNum; name: string; icon: React.ElementType }> = [
  { id: 1, name: "Company", icon: Building2 },
  { id: 2, name: "Structure", icon: Layers },
  { id: 3, name: "Data", icon: Package },
  { id: 4, name: "Plan", icon: Zap },
  { id: 5, name: "Team", icon: Users },
];

const PLAN_OPTIONS: Array<{
  id: PlanId;
  name: string;
  priceLabel: string;
  description: string;
  highlights: string[];
  recommended?: boolean;
}> = [
  {
    id: "starter",
    name: "Starter",
    priceLabel: "Free",
    description: "Get up and running with the essentials.",
    highlights: ["Up to 5 users", "Procurement & Sales", "Email support"],
  },
  {
    id: "growth",
    name: "Growth",
    priceLabel: "$299/mo",
    description: "For teams ready to scale operations.",
    highlights: ["Up to 25 users", "Inventory + warehouse", "Stripe billing", "Priority support"],
    recommended: true,
  },
  {
    id: "enterprise",
    name: "Enterprise",
    priceLabel: "$999/mo",
    description: "Advanced controls, integrations, and SLA.",
    highlights: ["Unlimited users", "Audit logs & SSO", "Dedicated CSM", "99.9% uptime SLA"],
  },
];

const ROLE_OPTIONS: Array<{ id: InviteRoleId; label: string }> = [
  { id: "tenant_admin", label: "Admin" },
  { id: "purchaser", label: "Purchaser" },
  { id: "warehouse", label: "Warehouse" },
  { id: "approver", label: "Approver" },
  { id: "accountant", label: "Accountant" },
  { id: "viewer", label: "Viewer" },
];

const GL_TEMPLATES: Array<{ id: GlTemplate; name: string; description: string }> = [
  { id: "simple", name: "Simple", description: "Basic chart of accounts for small businesses" },
  { id: "standard", name: "Standard", description: "Full GAAP-compliant chart with expense tracking" },
  { id: "advanced", name: "Advanced", description: "Multi-entity with intercompany accounts" },
];

const CURRENCIES = ["AUD", "USD", "GBP", "EUR", "NZD", "SGD", "CAD"];
const INDUSTRIES = [
  "Manufacturing", "Distribution", "Wholesale", "Retail",
  "Construction", "Healthcare", "Food & Beverage", "Technology", "Services", "Other",
];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const COUNTRIES = ["AU", "US", "GB", "NZ", "SG", "CA"];

// CSV templates
const CSV_TEMPLATES: Record<CsvType, string> = {
  items: "code,name,description,unitOfMeasure,unitCost,category\nITEM001,Sample Item,A sample item,EA,10.00,General",
  suppliers: "code,name,email,phone,contactName,paymentTerms,currency\nSUP001,Sample Supplier,supplier@example.com,+61400000000,John Smith,30 days,AUD",
  customers: "code,name,email,phone,contactName,creditLimit,paymentTerms,currency\nCUST001,Sample Customer,customer@example.com,+61400000001,Jane Doe,10000,30 days,AUD",
};

// ── Progress stepper ──────────────────────────────────────────────────────────

function StepperBar({ current }: { current: StepNum }) {
  return (
    <div className="flex items-center justify-center gap-0 mb-8">
      {STEPS.map((s, i) => {
        const done = s.id < current;
        const active = s.id === current;
        return (
          <div key={s.id} className="flex items-center">
            <div className="flex flex-col items-center gap-1">
              <div
                className={cn(
                  "w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold border-2 transition-all",
                  done && "bg-emerald-600 border-emerald-600 text-white",
                  active && "bg-orange-500 border-orange-500 text-white shadow-md",
                  !done && !active && "bg-white border-slate-200 text-slate-400",
                )}
              >
                {done ? <Check className="w-4 h-4" /> : <s.icon className="w-4 h-4" />}
              </div>
              <span className={cn(
                "text-xs font-medium",
                active ? "text-orange-600" : done ? "text-emerald-600" : "text-slate-400",
              )}>
                {s.name}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div className={cn(
                "w-12 h-0.5 mb-5 mx-1 transition-all",
                done ? "bg-emerald-400" : "bg-slate-200",
              )} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Step 1: Company Details ───────────────────────────────────────────────────

function Step1({
  data,
  onChange,
}: {
  data: WizardData;
  onChange: (patch: Partial<WizardData>) => void;
}) {
  const { toast } = useToast();
  const validateTaxId = useValidateTaxId();
  const [taxIdStatus, setTaxIdStatus] = useState<"idle" | "valid" | "invalid">("idle");

  async function handleValidate() {
    if (!data.taxId.trim()) return;
    try {
      const res = await validateTaxId.mutateAsync({
        data: { taxId: data.taxId.trim(), country: data.taxIdCountry },
      });
      setTaxIdStatus(res.valid ? "valid" : "invalid");
      if (!res.valid) {
        toast({ title: "Invalid tax ID", description: res.message, variant: "destructive" });
      }
    } catch {
      setTaxIdStatus("invalid");
    }
  }

  const field = (label: string, key: keyof WizardData, placeholder?: string, required?: boolean) => (
    <div className="space-y-1.5">
      <Label className="text-sm font-medium text-slate-700">
        {label}{required && <span className="text-red-500 ml-0.5">*</span>}
      </Label>
      <Input
        value={data[key] as string}
        onChange={(e) => onChange({ [key]: e.target.value } as Partial<WizardData>)}
        placeholder={placeholder}
        className="border-slate-200 focus:border-orange-400 focus:ring-orange-400"
      />
    </div>
  );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-slate-800">Company Details</h2>
        <p className="text-sm text-slate-500 mt-1">Tell us about your organisation so we can set up your workspace.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {field("Company Name", "companyName", "Acme Corp Pty Ltd", true)}
        {field("Trading Name", "tradingName", "Acme Corp (optional)")}
        {field("Legal Name", "legalName", "As registered (optional)")}
        <div className="space-y-1.5">
          <Label className="text-sm font-medium text-slate-700">Industry</Label>
          <Select value={data.industryType} onValueChange={(v) => onChange({ industryType: v })}>
            <SelectTrigger className="border-slate-200"><SelectValue placeholder="Select industry" /></SelectTrigger>
            <SelectContent>{INDUSTRIES.map((i) => <SelectItem key={i} value={i}>{i}</SelectItem>)}</SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-sm font-medium text-slate-700">Tax ID / ABN</Label>
        <div className="flex gap-2">
          <Select value={data.taxIdCountry} onValueChange={(v) => { onChange({ taxIdCountry: v }); setTaxIdStatus("idle"); }}>
            <SelectTrigger className="w-20 border-slate-200"><SelectValue /></SelectTrigger>
            <SelectContent>{COUNTRIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
          </Select>
          <div className="relative flex-1">
            <Input
              value={data.taxId}
              onChange={(e) => { onChange({ taxId: e.target.value }); setTaxIdStatus("idle"); }}
              placeholder={data.taxIdCountry === "AU" ? "12 345 678 901" : "Tax ID / EIN / VAT"}
              className={cn(
                "border-slate-200 focus:border-orange-400 pr-8",
                taxIdStatus === "valid" && "border-emerald-400 focus:border-emerald-400",
                taxIdStatus === "invalid" && "border-red-400 focus:border-red-400",
              )}
            />
            {taxIdStatus === "valid" && <CheckCircle2 className="absolute right-2.5 top-2.5 w-4 h-4 text-emerald-500" />}
            {taxIdStatus === "invalid" && <AlertCircle className="absolute right-2.5 top-2.5 w-4 h-4 text-red-500" />}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleValidate}
            disabled={!data.taxId.trim() || validateTaxId.isPending}
            className="shrink-0"
          >
            {validateTaxId.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : "Validate"}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {field("Phone", "phone", "+61 2 1234 5678")}
        {field("Email", "email", "admin@acme.com")}
        {field("Website", "website", "https://acme.com")}
      </div>

      <div className="space-y-1.5">
        <Label className="text-sm font-medium text-slate-700">Address</Label>
        <Input
          value={data.addressLine1}
          onChange={(e) => onChange({ addressLine1: e.target.value })}
          placeholder="123 Business Street"
          className="border-slate-200 focus:border-orange-400"
        />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-2">
          <Input value={data.city} onChange={(e) => onChange({ city: e.target.value })} placeholder="City" className="border-slate-200 focus:border-orange-400" />
          <Input value={data.state} onChange={(e) => onChange({ state: e.target.value })} placeholder="State" className="border-slate-200 focus:border-orange-400" />
          <Input value={data.postalCode} onChange={(e) => onChange({ postalCode: e.target.value })} placeholder="Postcode" className="border-slate-200 focus:border-orange-400" />
          <Select value={data.country} onValueChange={(v) => onChange({ country: v })}>
            <SelectTrigger className="border-slate-200"><SelectValue /></SelectTrigger>
            <SelectContent>{COUNTRIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="space-y-1.5">
          <Label className="text-sm font-medium text-slate-700">Currency</Label>
          <Select value={data.currency} onValueChange={(v) => onChange({ currency: v })}>
            <SelectTrigger className="border-slate-200"><SelectValue /></SelectTrigger>
            <SelectContent>{CURRENCIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-sm font-medium text-slate-700">Fiscal Year Start</Label>
          <Select value={String(data.fiscalYearStart)} onValueChange={(v) => onChange({ fiscalYearStart: Number(v) })}>
            <SelectTrigger className="border-slate-200"><SelectValue /></SelectTrigger>
            <SelectContent>{MONTHS.map((m, i) => <SelectItem key={i + 1} value={String(i + 1)}>{m}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-sm font-medium text-slate-700">Timezone</Label>
          <Input
            value={data.timezone}
            onChange={(e) => onChange({ timezone: e.target.value })}
            placeholder="Australia/Sydney"
            className="border-slate-200 focus:border-orange-400"
          />
        </div>
      </div>
    </div>
  );
}

// ── Step 2: Company Structure ─────────────────────────────────────────────────

function Step2({
  data,
  onChange,
}: {
  data: WizardData;
  onChange: (patch: Partial<WizardData>) => void;
}) {
  function addWarehouse() {
    onChange({
      warehouses: [
        ...data.warehouses,
        { id: uid(), name: "", code: "", city: "", state: "", country: data.country, isDefault: false },
      ],
    });
  }
  function updateWarehouse(id: string, patch: Partial<WarehouseRow>) {
    onChange({ warehouses: data.warehouses.map((w) => (w.id === id ? { ...w, ...patch } : w)) });
  }
  function removeWarehouse(id: string) {
    onChange({ warehouses: data.warehouses.filter((w) => w.id !== id) });
  }
  function addDept() {
    onChange({ departments: [...data.departments, { id: uid(), name: "", code: "" }] });
  }
  function updateDept(id: string, patch: Partial<DepartmentRow>) {
    onChange({ departments: data.departments.map((d) => (d.id === id ? { ...d, ...patch } : d)) });
  }
  function removeDept(id: string) {
    onChange({ departments: data.departments.filter((d) => d.id !== id) });
  }

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-semibold text-slate-800">Company Structure</h2>
        <p className="text-sm text-slate-500 mt-1">Set up your warehouses, departments, and GL template.</p>
      </div>

      {/* Warehouses */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Warehouse className="w-4 h-4 text-orange-500" />
            <h3 className="font-medium text-slate-800">Warehouses / Locations</h3>
          </div>
          <Button variant="outline" size="sm" onClick={addWarehouse} className="gap-1 text-xs">
            <Plus className="w-3 h-3" /> Add
          </Button>
        </div>
        <div className="space-y-2">
          {data.warehouses.map((w) => (
            <div key={w.id} className="p-3 border border-slate-200 rounded-lg bg-slate-50 space-y-2">
              <div className="flex gap-2 items-center">
                <Input
                  value={w.name}
                  onChange={(e) => updateWarehouse(w.id, { name: e.target.value })}
                  placeholder="Warehouse name *"
                  className="flex-1 border-slate-200 bg-white text-sm"
                />
                <Input
                  value={w.code}
                  onChange={(e) => updateWarehouse(w.id, { code: e.target.value })}
                  placeholder="Code"
                  className="w-24 border-slate-200 bg-white text-sm"
                />
                <button
                  onClick={() => updateWarehouse(w.id, { isDefault: true })}
                  title="Set as default"
                  className={cn(
                    "px-2 py-1 text-xs rounded border transition-all",
                    w.isDefault ? "bg-emerald-100 border-emerald-400 text-emerald-700" : "border-slate-200 text-slate-400 hover:border-orange-300",
                  )}
                >
                  {w.isDefault ? "Default" : "Set default"}
                </button>
                {data.warehouses.length > 1 && (
                  <button onClick={() => removeWarehouse(w.id)} className="text-slate-300 hover:text-red-400 transition-colors">
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
              <div className="flex gap-2">
                <Input value={w.city} onChange={(e) => updateWarehouse(w.id, { city: e.target.value })} placeholder="City" className="border-slate-200 bg-white text-sm" />
                <Input value={w.state} onChange={(e) => updateWarehouse(w.id, { state: e.target.value })} placeholder="State" className="w-28 border-slate-200 bg-white text-sm" />
                <Select value={w.country} onValueChange={(v) => updateWarehouse(w.id, { country: v })}>
                  <SelectTrigger className="w-20 border-slate-200 bg-white text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>{COUNTRIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Departments */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4 text-orange-500" />
            <h3 className="font-medium text-slate-800">Departments</h3>
          </div>
          <Button variant="outline" size="sm" onClick={addDept} className="gap-1 text-xs">
            <Plus className="w-3 h-3" /> Add
          </Button>
        </div>
        <div className="space-y-2">
          {data.departments.map((d) => (
            <div key={d.id} className="flex gap-2 items-center">
              <Input
                value={d.name}
                onChange={(e) => updateDept(d.id, { name: e.target.value })}
                placeholder="Department name *"
                className="flex-1 border-slate-200 text-sm"
              />
              <Input
                value={d.code}
                onChange={(e) => updateDept(d.id, { code: e.target.value })}
                placeholder="Code"
                className="w-28 border-slate-200 text-sm"
              />
              {data.departments.length > 1 && (
                <button onClick={() => removeDept(d.id)} className="text-slate-300 hover:text-red-400 transition-colors">
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* GL Template */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <CreditCard className="w-4 h-4 text-orange-500" />
          <h3 className="font-medium text-slate-800">GL Account Template</h3>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {GL_TEMPLATES.map((t) => (
            <button
              key={t.id}
              onClick={() => onChange({ glTemplate: t.id })}
              className={cn(
                "p-4 rounded-xl border-2 text-left transition-all",
                data.glTemplate === t.id
                  ? "border-orange-400 bg-orange-50"
                  : "border-slate-200 hover:border-slate-300",
              )}
            >
              <p className="font-semibold text-slate-800 text-sm">{t.name}</p>
              <p className="text-xs text-slate-500 mt-1">{t.description}</p>
              {data.glTemplate === t.id && (
                <CheckCircle2 className="w-4 h-4 text-orange-500 mt-2" />
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Step 3: Master Data ───────────────────────────────────────────────────────

function DataTable({ rows, type }: { rows: Record<string, string>[]; type: CsvType }) {
  if (rows.length === 0) return null;
  const keys = Object.keys(rows[0]).slice(0, 5);
  return (
    <div className="overflow-auto max-h-48 rounded-lg border border-slate-200">
      <table className="w-full text-xs">
        <thead className="bg-slate-50 sticky top-0">
          <tr>{keys.map((k) => <th key={k} className="px-3 py-2 text-left font-medium text-slate-600">{k}</th>)}</tr>
        </thead>
        <tbody>
          {rows.slice(0, 20).map((row, i) => (
            <tr key={i} className="border-t border-slate-100">
              {keys.map((k) => <td key={k} className="px-3 py-1.5 text-slate-700 truncate max-w-[120px]">{row[k]}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 20 && (
        <p className="text-center py-2 text-xs text-slate-400">…and {rows.length - 20} more rows</p>
      )}
    </div>
  );
}

function DataSection({
  type,
  icon: Icon,
  label,
  rows,
  onRows,
}: {
  type: CsvType;
  icon: React.ElementType;
  label: string;
  rows: Record<string, string>[];
  onRows: (rows: Record<string, string>[]) => void;
}) {
  const { toast } = useToast();
  const uploadCsv = useUploadOnboardingCsv();
  const fileRef = useRef<HTMLInputElement>(null);

  function downloadTemplate() {
    const blob = new Blob([CSV_TEMPLATES[type]], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${type}-template.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const res = await uploadCsv.mutateAsync({
        data: { file, csvType: type },
      });
      if (res.hasErrors) {
        toast({ title: "CSV warnings", description: res.errors.slice(0, 3).join("; "), variant: "destructive" });
      } else {
        toast({ title: `${res.rowCount} ${label.toLowerCase()} imported` });
      }
      onRows(res.rows as Record<string, string>[]);
    } catch {
      toast({ title: "Upload failed", variant: "destructive" });
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function clear() {
    onRows([]);
  }

  return (
    <div className="border border-slate-200 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon className="w-4 h-4 text-orange-500" />
          <span className="font-medium text-slate-800 text-sm">{label}</span>
          {rows.length > 0 && (
            <Badge variant="secondary" className="text-xs">{rows.length} records</Badge>
          )}
        </div>
        <div className="flex gap-1">
          {rows.length > 0 && (
            <Button variant="ghost" size="sm" onClick={clear} className="text-xs text-slate-400 h-7">
              <X className="w-3 h-3 mr-1" /> Clear
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={downloadTemplate} className="text-xs h-7 gap-1">
            <Download className="w-3 h-3" /> Template
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => fileRef.current?.click()}
            disabled={uploadCsv.isPending}
            className="text-xs h-7 gap-1"
          >
            {uploadCsv.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
            Import CSV
          </Button>
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={handleFile} />
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-slate-400 text-center py-4">
          No data yet — import a CSV or load sample data below.
        </p>
      ) : (
        <DataTable rows={rows} type={type} />
      )}
    </div>
  );
}

function Step3({
  data,
  onChange,
}: {
  data: WizardData;
  onChange: (patch: Partial<WizardData>) => void;
}) {
  const { toast } = useToast();
  const loadSample = useLoadSampleData();

  async function handleLoadSample() {
    try {
      const res = await loadSample.mutateAsync();
      onChange({
        items: res.items as unknown as Record<string, string>[],
        suppliers: res.suppliers as unknown as Record<string, string>[],
        customers: res.customers as unknown as Record<string, string>[],
      });
      toast({ title: "Sample data loaded", description: "You can replace it with your own CSV at any time." });
    } catch {
      toast({ title: "Failed to load sample data", variant: "destructive" });
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-semibold text-slate-800">Master Data Import</h2>
          <p className="text-sm text-slate-500 mt-1">Import your items, suppliers, and customers — or start with sample data.</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleLoadSample}
          disabled={loadSample.isPending}
          className="gap-1.5 text-xs shrink-0"
        >
          {loadSample.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
          Load Sample Data
        </Button>
      </div>

      <DataSection
        type="items"
        icon={Package}
        label="Items / Products"
        rows={data.items}
        onRows={(rows) => onChange({ items: rows })}
      />
      <DataSection
        type="suppliers"
        icon={Truck}
        label="Suppliers"
        rows={data.suppliers}
        onRows={(rows) => onChange({ suppliers: rows })}
      />
      <DataSection
        type="customers"
        icon={UserCheck}
        label="Customers"
        rows={data.customers}
        onRows={(rows) => onChange({ customers: rows })}
      />
    </div>
  );
}

// ── Step 4: Plan & Payment ────────────────────────────────────────────────────

function CardPaymentForm({
  clientSecret,
  onSuccess,
}: {
  clientSecret: string;
  onSuccess: (paymentMethodId: string) => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setProcessing(true);
    setError(null);
    const cardEl = elements.getElement(CardElement);
    if (!cardEl) return;
    const { error: stripeError, setupIntent } = await stripe.confirmCardSetup(clientSecret, {
      payment_method: { card: cardEl },
    });
    setProcessing(false);
    if (stripeError) {
      setError(stripeError.message ?? "Payment setup failed");
      return;
    }
    const pmId = typeof setupIntent?.payment_method === "string"
      ? setupIntent.payment_method
      : setupIntent?.payment_method?.id ?? "";
    onSuccess(pmId);
    toast({ title: "Card saved successfully" });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 mt-4 p-4 border border-slate-200 rounded-xl bg-slate-50">
      <Label className="text-sm font-medium text-slate-700">Card Details</Label>
      <div className="p-3 bg-white rounded-lg border border-slate-200">
        <CardElement
          options={{
            style: {
              base: { fontSize: "15px", color: "#1e293b", fontFamily: "inherit" },
            },
          }}
        />
      </div>
      {error && <p className="text-xs text-red-500">{error}</p>}
      <Button type="submit" disabled={!stripe || processing} className="w-full bg-orange-500 hover:bg-orange-600">
        {processing ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <CreditCard className="w-4 h-4 mr-2" />}
        Save Card
      </Button>
    </form>
  );
}

function Step4({
  data,
  onChange,
}: {
  data: WizardData;
  onChange: (patch: Partial<WizardData>) => void;
}) {
  const { toast } = useToast();
  const setupPayment = useSetupPaymentIntent();
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [stripeAvailable, setStripeAvailable] = useState<boolean | null>(null);
  const needsPayment = data.planTier !== "starter";

  useEffect(() => {
    if (!needsPayment) return;
    setStripeAvailable(null);
    setupPayment.mutateAsync().then((res) => {
      if (res.clientSecret) {
        setClientSecret(res.clientSecret);
        setStripeAvailable(true);
      } else {
        setStripeAvailable(false);
      }
    }).catch(() => setStripeAvailable(false));
  }, [data.planTier]);

  function handleCardSaved(pmId: string) {
    onChange({ stripePaymentMethodId: pmId });
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-slate-800">Plan & Payment</h2>
        <p className="text-sm text-slate-500 mt-1">Choose the plan that fits your team.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {PLAN_OPTIONS.map((plan) => (
          <button
            key={plan.id}
            onClick={() => { onChange({ planTier: plan.id, stripePaymentMethodId: undefined }); setClientSecret(null); }}
            className={cn(
              "relative p-5 rounded-2xl border-2 text-left transition-all",
              data.planTier === plan.id
                ? "border-orange-400 bg-orange-50 shadow-md"
                : "border-slate-200 hover:border-slate-300 bg-white",
            )}
          >
            {plan.recommended && (
              <span className="absolute -top-2.5 left-4 text-xs font-semibold px-2 py-0.5 bg-orange-500 text-white rounded-full">
                Recommended
              </span>
            )}
            <p className="font-bold text-slate-800">{plan.name}</p>
            <p className="text-2xl font-bold text-orange-500 mt-1">{plan.priceLabel}</p>
            <p className="text-xs text-slate-500 mt-1 mb-3">{plan.description}</p>
            <ul className="space-y-1">
              {plan.highlights.map((h) => (
                <li key={h} className="flex items-center gap-1.5 text-xs text-slate-600">
                  <Check className="w-3 h-3 text-emerald-500 shrink-0" /> {h}
                </li>
              ))}
            </ul>
            {data.planTier === plan.id && (
              <CheckCircle2 className="absolute top-4 right-4 w-5 h-5 text-orange-500" />
            )}
          </button>
        ))}
      </div>

      {needsPayment && (
        <div>
          {stripeAvailable === null && (
            <div className="flex items-center gap-2 text-sm text-slate-500 p-4">
              <Loader2 className="w-4 h-4 animate-spin" /> Setting up payment…
            </div>
          )}
          {stripeAvailable === false && (
            <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-700">
              Online payment is not configured for this environment. Your card details will be collected at activation.
            </div>
          )}
          {stripeAvailable === true && clientSecret && !data.stripePaymentMethodId && (
            <Elements stripe={stripePromise} options={{ clientSecret }}>
              <CardPaymentForm clientSecret={clientSecret} onSuccess={handleCardSaved} />
            </Elements>
          )}
          {data.stripePaymentMethodId && (
            <div className="flex items-center gap-2 p-4 bg-emerald-50 border border-emerald-200 rounded-xl text-sm text-emerald-700">
              <CheckCircle2 className="w-4 h-4" /> Card saved — you're all set.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Step 5: Team & Review ─────────────────────────────────────────────────────

function ReviewRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between py-2 border-b border-slate-100 last:border-0 text-sm">
      <span className="text-slate-500">{label}</span>
      <span className="font-medium text-slate-800 text-right">{value}</span>
    </div>
  );
}

function Step5({
  data,
  onChange,
}: {
  data: WizardData;
  onChange: (patch: Partial<WizardData>) => void;
}) {
  function addInvite() {
    onChange({ invites: [...data.invites, { id: uid(), email: "", role: "viewer" as InviteRoleId }] });
  }
  function updateInvite(id: string, patch: Partial<InviteRow>) {
    onChange({ invites: data.invites.map((r) => (r.id === id ? { ...r, ...patch } : r)) });
  }
  function removeInvite(id: string) {
    onChange({ invites: data.invites.filter((r) => r.id !== id) });
  }

  const planLabel = PLAN_OPTIONS.find((p) => p.id === data.planTier)?.name ?? data.planTier;
  const defaultWh = data.warehouses.find((w) => w.isDefault) ?? data.warehouses[0];

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-semibold text-slate-800">Team Setup & Review</h2>
        <p className="text-sm text-slate-500 mt-1">Invite teammates and confirm your setup before finishing.</p>
      </div>

      {/* Invite team */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Mail className="w-4 h-4 text-orange-500" />
            <h3 className="font-medium text-slate-800">Invite Team Members <span className="text-slate-400 font-normal">(optional)</span></h3>
          </div>
          <Button variant="outline" size="sm" onClick={addInvite} className="gap-1 text-xs" disabled={data.invites.length >= 25}>
            <Plus className="w-3 h-3" /> Add
          </Button>
        </div>
        {data.invites.length === 0 ? (
          <p className="text-sm text-slate-400 text-center py-4">No invites yet — add team members to get them started.</p>
        ) : (
          <div className="space-y-2">
            {data.invites.map((inv) => (
              <div key={inv.id} className="flex gap-2 items-center">
                <Input
                  type="email"
                  value={inv.email}
                  onChange={(e) => updateInvite(inv.id, { email: e.target.value })}
                  placeholder="colleague@company.com"
                  className="flex-1 border-slate-200 text-sm"
                />
                <Select value={inv.role} onValueChange={(v) => updateInvite(inv.id, { role: v as InviteRoleId })}>
                  <SelectTrigger className="w-32 border-slate-200 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {ROLE_OPTIONS.map((r) => <SelectItem key={r.id} value={r.id}>{r.label}</SelectItem>)}
                  </SelectContent>
                </Select>
                <button onClick={() => removeInvite(inv.id)} className="text-slate-300 hover:text-red-400">
                  <X className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Summary */}
      <div className="bg-slate-50 rounded-xl border border-slate-200 p-4 space-y-1">
        <h3 className="font-semibold text-slate-800 text-sm mb-3">Your Setup Summary</h3>
        <ReviewRow label="Company" value={data.companyName} />
        <ReviewRow label="Industry" value={data.industryType || "—"} />
        <ReviewRow label="Currency" value={data.currency} />
        <ReviewRow label="Fiscal Year Start" value={MONTHS[(data.fiscalYearStart - 1) || 0]} />
        <ReviewRow label="Plan" value={planLabel} />
        <ReviewRow label="GL Template" value={GL_TEMPLATES.find((t) => t.id === data.glTemplate)?.name ?? data.glTemplate} />
        <ReviewRow label="Warehouses" value={data.warehouses.filter((w) => w.name).length} />
        <ReviewRow label="Departments" value={data.departments.filter((d) => d.name).length} />
        <ReviewRow
          label="Master Data"
          value={`${data.items.length} items · ${data.suppliers.length} suppliers · ${data.customers.length} customers`}
        />
        <ReviewRow label="Team Invites" value={data.invites.filter((i) => i.email).length} />
      </div>
    </div>
  );
}

// ── Quick Start Tour ──────────────────────────────────────────────────────────

const TOUR_STEPS = [
  { icon: "📋", title: "Create your first Purchase Order", desc: "Go to Procurement → Purchase Orders and click New PO." },
  { icon: "📦", title: "Receive goods into your warehouse", desc: "After a PO is approved, receive it under Warehouse → Receipts." },
  { icon: "📊", title: "Check your inventory levels", desc: "Navigate to Inventory → Stock Levels for a live view." },
  { icon: "🧾", title: "Issue a Sales Order", desc: "Go to Sales → Orders and create your first customer order." },
  { icon: "💰", title: "Review your financials", desc: "Under Finance → GL you'll find all posted journal entries." },
];

function QuickStartTour({ onClose }: { onClose: () => void }) {
  const [idx, setIdx] = useState(0);
  const step = TOUR_STEPS[idx];
  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-8 relative">
        <div className="text-5xl text-center mb-4">{step.icon}</div>
        <div className="text-center space-y-2 mb-6">
          <p className="text-xs font-semibold text-orange-500 uppercase tracking-wide">Quick Start — Step {idx + 1} of {TOUR_STEPS.length}</p>
          <h3 className="text-xl font-bold text-slate-800">{step.title}</h3>
          <p className="text-sm text-slate-500">{step.desc}</p>
        </div>
        <Progress value={((idx + 1) / TOUR_STEPS.length) * 100} className="mb-6 h-1.5" />
        <div className="flex justify-between items-center">
          <Button variant="ghost" size="sm" onClick={onClose} className="text-slate-400 text-xs">
            Skip Tour
          </Button>
          <div className="flex gap-2">
            {idx > 0 && (
              <Button variant="outline" size="sm" onClick={() => setIdx((i) => i - 1)}>
                <ChevronLeft className="w-4 h-4" />
              </Button>
            )}
            {idx < TOUR_STEPS.length - 1 ? (
              <Button size="sm" onClick={() => setIdx((i) => i + 1)} className="bg-orange-500 hover:bg-orange-600">
                Next <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            ) : (
              <Button size="sm" onClick={onClose} className="bg-emerald-600 hover:bg-emerald-700">
                Get Started <Check className="w-4 h-4 ml-1" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function OnboardingPage() {
  const { user } = useUser();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [step, setStep] = useState<StepNum>(1);
  const [data, setData] = useState<WizardData>(defaultData());
  const [showTour, setShowTour] = useState(false);
  const [sessionLoaded, setSessionLoaded] = useState(false);

  const sessionQuery = useGetOnboardingSession();
  const updateSession = useUpdateOnboardingSession();
  const completeOnboarding = useCompleteOnboarding();

  // Restore session on mount
  useEffect(() => {
    if (sessionQuery.data && !sessionLoaded) {
      const s = sessionQuery.data;
      setStep((s.currentStep as StepNum) || 1);
      if (s.data && typeof s.data === "object") {
        setData((prev) => ({ ...prev, ...(s.data as Partial<WizardData>) }));
      }
      setSessionLoaded(true);
    }
  }, [sessionQuery.data, sessionLoaded]);

  const onChange = useCallback((patch: Partial<WizardData>) => {
    setData((prev) => ({ ...prev, ...patch }));
  }, []);

  async function saveSession(nextStep: StepNum, nextData: WizardData) {
    try {
      await updateSession.mutateAsync({
        data: { currentStep: nextStep, data: nextData as unknown as Record<string, unknown> },
      });
    } catch {
      // non-fatal
    }
  }

  function canProceed(): { ok: boolean; message?: string } {
    if (step === 1) {
      if (!data.companyName.trim()) return { ok: false, message: "Company name is required." };
    }
    if (step === 2) {
      const hasWh = data.warehouses.some((w) => w.name.trim());
      if (!hasWh) return { ok: false, message: "Add at least one warehouse." };
    }
    if (step === 4) {
      if (data.planTier !== "starter" && !data.stripePaymentMethodId) {
        const stripeConfigured = !!stripePublicKey;
        if (stripeConfigured) {
          return { ok: false, message: "Please save your card to continue." };
        }
      }
    }
    return { ok: true };
  }

  async function goNext() {
    const { ok, message } = canProceed();
    if (!ok) {
      toast({ title: "Required", description: message, variant: "destructive" });
      return;
    }
    if (step === 5) {
      await handleComplete();
      return;
    }
    const nextStep = (step + 1) as StepNum;
    setStep(nextStep);
    await saveSession(nextStep, data);
  }

  function goBack() {
    if (step <= 1) return;
    const prevStep = (step - 1) as StepNum;
    setStep(prevStep);
    saveSession(prevStep, data);
  }

  async function handleComplete() {
    const validInvites: OnboardingInvite[] = data.invites
      .map((r) => ({ email: r.email.trim().toLowerCase(), role: r.role }))
      .filter((r) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email));

    try {
      await completeOnboarding.mutateAsync({
        data: {
          step1: {
            companyName: data.companyName.trim(),
            tradingName: data.tradingName || undefined,
            legalName: data.legalName || undefined,
            taxId: data.taxId || undefined,
            phone: data.phone || undefined,
            email: data.email || undefined,
            website: data.website || undefined,
            addressLine1: data.addressLine1 || undefined,
            city: data.city || undefined,
            state: data.state || undefined,
            postalCode: data.postalCode || undefined,
            country: data.country,
            fiscalYearStart: data.fiscalYearStart,
            currency: data.currency,
            timezone: data.timezone,
            industryType: data.industryType || undefined,
          },
          step2: {
            warehouses: data.warehouses
              .filter((w) => w.name.trim())
              .map((w) => ({
                name: w.name,
                code: w.code || undefined,
                city: w.city || undefined,
                state: w.state || undefined,
                country: w.country || undefined,
                isDefault: w.isDefault,
              })),
            departments: data.departments
              .filter((d) => d.name.trim())
              .map((d) => ({ name: d.name, code: d.code || undefined })),
            glTemplate: data.glTemplate,
          },
          step3: {
            items: data.items,
            suppliers: data.suppliers,
            customers: data.customers,
          },
          step4: {
            planTier: data.planTier,
            stripePaymentMethodId: data.stripePaymentMethodId || undefined,
          },
          step5: { invites: validInvites },
        },
      });

      await queryClient.invalidateQueries({ queryKey: getGetCurrentUserQueryKey() });
      setShowTour(true);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Something went wrong.";
      toast({ title: "Onboarding failed", description: msg, variant: "destructive" });
    }
  }

  function handleTourClose() {
    setShowTour(false);
    setLocation("/");
  }

  if (sessionQuery.isPending && !sessionLoaded) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 to-orange-50">
        <Loader2 className="w-8 h-8 animate-spin text-orange-400" />
      </div>
    );
  }

  const isLast = step === 5;

  return (
    <>
      {showTour && <QuickStartTour onClose={handleTourClose} />}

      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-orange-50 flex flex-col">
        {/* Header */}
        <header className="flex items-center gap-3 px-6 py-4 bg-white/80 backdrop-blur border-b border-slate-100">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-orange-500 to-orange-600 flex items-center justify-center">
            <span className="text-white font-bold text-sm">F</span>
          </div>
          <span className="font-bold text-slate-800 text-lg">Forge ERP</span>
          <span className="text-slate-300 mx-1">·</span>
          <span className="text-sm text-slate-500">Workspace Setup</span>
          {user?.primaryEmailAddress?.emailAddress && (
            <span className="ml-auto text-xs text-slate-400">{user.primaryEmailAddress.emailAddress}</span>
          )}
        </header>

        {/* Body */}
        <main className="flex-1 flex items-start justify-center py-10 px-4">
          <div className="w-full max-w-2xl">
            <StepperBar current={step} />

            <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-8 min-h-[400px]">
              {step === 1 && <Step1 data={data} onChange={onChange} />}
              {step === 2 && <Step2 data={data} onChange={onChange} />}
              {step === 3 && <Step3 data={data} onChange={onChange} />}
              {step === 4 && <Step4 data={data} onChange={onChange} />}
              {step === 5 && <Step5 data={data} onChange={onChange} />}
            </div>

            {/* Navigation */}
            <div className="flex items-center justify-between mt-6">
              <Button
                variant="ghost"
                onClick={goBack}
                disabled={step === 1}
                className="gap-2 text-slate-600"
              >
                <ChevronLeft className="w-4 h-4" /> Back
              </Button>

              <div className="flex items-center gap-2 text-xs text-slate-400">
                {updateSession.isPending && <Loader2 className="w-3 h-3 animate-spin" />}
                {updateSession.isSuccess && <Check className="w-3 h-3 text-emerald-400" />}
                <span>Step {step} of {STEPS.length}</span>
              </div>

              <Button
                onClick={goNext}
                disabled={completeOnboarding.isPending}
                className="gap-2 bg-orange-500 hover:bg-orange-600 text-white"
              >
                {completeOnboarding.isPending ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /> Setting up…</>
                ) : isLast ? (
                  <><Check className="w-4 h-4" /> Complete Setup</>
                ) : (
                  <>Next <ChevronRight className="w-4 h-4" /></>
                )}
              </Button>
            </div>
          </div>
        </main>
      </div>
    </>
  );
}
