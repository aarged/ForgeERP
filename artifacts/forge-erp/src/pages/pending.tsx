import { useClerk, useUser } from "@clerk/react";
import { Button } from "@/components/ui/button";
import { Command, Clock } from "lucide-react";

export default function PendingPage() {
  const { signOut } = useClerk();
  const { user } = useUser();

  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center bg-muted/30 px-4">
      <div className="w-full max-w-[440px] rounded-2xl border border-border bg-white dark:bg-zinc-950 shadow-xl p-8 text-center space-y-6">
        <div className="flex justify-center">
          <div className="flex aspect-square size-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Command className="size-6" />
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-center gap-2 text-amber-600">
            <Clock className="size-4" />
            <span className="text-sm font-medium">Pending Activation</span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Almost there
          </h1>
          <p className="text-sm text-muted-foreground">
            Hi {user?.firstName ?? "there"} — your account has been created but
            hasn't been linked to a company workspace yet.
          </p>
        </div>

        <div className="rounded-lg bg-muted/50 border border-border p-4 text-left space-y-2">
          <p className="text-xs font-medium text-foreground uppercase tracking-wide">
            What happens next
          </p>
          <ul className="text-sm text-muted-foreground space-y-1 list-disc list-inside">
            <li>Your company admin adds you to the workspace</li>
            <li>Or you create a new company workspace</li>
            <li>Then return here to sign in</li>
          </ul>
        </div>

        <Button
          variant="outline"
          className="w-full"
          onClick={() => signOut()}
          data-testid="button-sign-out-pending"
        >
          Sign out
        </Button>
      </div>
    </div>
  );
}
