import { useClerk, useUser } from "@clerk/react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { ArrowRight, Building2, Command } from "lucide-react";

export default function PendingPage() {
  const { signOut } = useClerk();
  const { user } = useUser();

  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center bg-muted/30 px-4">
      <div className="w-full max-w-[480px] rounded-2xl border border-border bg-white dark:bg-zinc-950 shadow-xl p-8 text-center space-y-6">
        <div className="flex justify-center">
          <div className="flex aspect-square size-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Command className="size-6" />
          </div>
        </div>

        <div className="space-y-2">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Welcome{user?.firstName ? `, ${user.firstName}` : ""}
          </h1>
          <p className="text-sm text-muted-foreground">
            Your account is ready. Let's set up your company workspace so you
            can start using Forge ERP.
          </p>
        </div>

        <Link href="/onboarding">
          <Button
            className="w-full"
            size="lg"
            data-testid="button-start-onboarding"
          >
            <Building2 className="mr-2 size-4" />
            Create your company
            <ArrowRight className="ml-2 size-4" />
          </Button>
        </Link>

        <div className="rounded-lg bg-muted/50 border border-border p-4 text-left space-y-2">
          <p className="text-xs font-medium text-foreground uppercase tracking-wide">
            Already part of a team?
          </p>
          <p className="text-sm text-muted-foreground">
            Ask your company admin to invite{" "}
            <span className="font-medium text-foreground">
              {user?.primaryEmailAddress?.emailAddress ?? "your email"}
            </span>{" "}
            from their workspace settings, then sign back in.
          </p>
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
