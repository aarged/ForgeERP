import { ReactNode } from "react";
import { AlertTriangle, Info, Lightbulb, CheckCircle2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

export function DocPage({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: ReactNode;
  children: ReactNode;
}) {
  return (
    <article className="max-w-3xl space-y-8 pb-16" data-testid="docs-article">
      <header className="space-y-3">
        <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
        {intro && (
          <p className="text-base text-muted-foreground leading-relaxed">
            {intro}
          </p>
        )}
      </header>
      {children}
    </article>
  );
}

export function DocSection({
  id,
  title,
  children,
}: {
  id?: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="space-y-3 scroll-mt-20">
      <h2 className="text-xl font-semibold tracking-tight border-b pb-2">
        {title}
      </h2>
      <div className="space-y-3 text-sm leading-relaxed text-foreground/90">
        {children}
      </div>
    </section>
  );
}

export function DocSubsection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2 mt-4">
      <h3 className="text-base font-semibold">{title}</h3>
      <div className="space-y-2 text-sm leading-relaxed text-foreground/90">
        {children}
      </div>
    </div>
  );
}

export function P({ children }: { children: ReactNode }) {
  return <p className="text-sm leading-relaxed">{children}</p>;
}

export function Steps({ children }: { children: ReactNode }) {
  return (
    <ol className="list-decimal pl-6 space-y-1.5 text-sm leading-relaxed">
      {children}
    </ol>
  );
}

export function Bullets({ children }: { children: ReactNode }) {
  return (
    <ul className="list-disc pl-6 space-y-1.5 text-sm leading-relaxed">
      {children}
    </ul>
  );
}

export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="font-mono text-[12px] px-1.5 py-0.5 rounded bg-muted text-foreground/90">
      {children}
    </code>
  );
}

type CalloutKind = "tip" | "info" | "warning" | "success";

const calloutStyles: Record<
  CalloutKind,
  { icon: typeof Info; wrapper: string; iconColor: string }
> = {
  tip: {
    icon: Lightbulb,
    wrapper: "border-amber-200 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-900",
    iconColor: "text-amber-600 dark:text-amber-400",
  },
  info: {
    icon: Info,
    wrapper: "border-blue-200 bg-blue-50 dark:bg-blue-950/30 dark:border-blue-900",
    iconColor: "text-blue-600 dark:text-blue-400",
  },
  warning: {
    icon: AlertTriangle,
    wrapper: "border-rose-200 bg-rose-50 dark:bg-rose-950/30 dark:border-rose-900",
    iconColor: "text-rose-600 dark:text-rose-400",
  },
  success: {
    icon: CheckCircle2,
    wrapper:
      "border-emerald-200 bg-emerald-50 dark:bg-emerald-950/30 dark:border-emerald-900",
    iconColor: "text-emerald-600 dark:text-emerald-400",
  },
};

export function Callout({
  kind = "info",
  title,
  children,
}: {
  kind?: CalloutKind;
  title?: string;
  children: ReactNode;
}) {
  const { icon: Icon, wrapper, iconColor } = calloutStyles[kind];
  return (
    <div
      className={cn(
        "flex gap-3 rounded-md border p-4 my-4",
        wrapper,
      )}
      data-testid={`callout-${kind}`}
    >
      <Icon className={cn("size-5 shrink-0 mt-0.5", iconColor)} />
      <div className="space-y-1 text-sm leading-relaxed">
        {title && <p className="font-semibold">{title}</p>}
        <div>{children}</div>
      </div>
    </div>
  );
}

export type FieldRow = {
  name: string;
  type?: string;
  description: ReactNode;
};

export function FieldTable({
  caption,
  rows,
  nameHeader = "Field",
  typeHeader = "Type / Values",
}: {
  caption?: string;
  rows: FieldRow[];
  nameHeader?: string;
  typeHeader?: string;
}) {
  return (
    <div className="rounded-md border my-3 overflow-hidden">
      {caption && (
        <div className="bg-muted/40 border-b px-3 py-2 text-xs font-medium text-muted-foreground">
          {caption}
        </div>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[180px]">{nameHeader}</TableHead>
            <TableHead className="w-[180px]">{typeHeader}</TableHead>
            <TableHead>Description</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.name}>
              <TableCell className="font-mono text-xs align-top">
                {r.name}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground align-top">
                {r.type ?? "—"}
              </TableCell>
              <TableCell className="text-sm align-top">
                {r.description}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export type StatusRow = {
  status: string;
  variant?: "default" | "secondary" | "outline" | "destructive";
  description: ReactNode;
};

export function StatusTable({
  rows,
}: {
  rows: StatusRow[];
}) {
  return (
    <div className="rounded-md border my-3 overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[200px]">Status</TableHead>
            <TableHead>Meaning</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.status}>
              <TableCell className="align-top">
                <Badge variant={r.variant ?? "secondary"}>{r.status}</Badge>
              </TableCell>
              <TableCell className="text-sm align-top">
                {r.description}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
