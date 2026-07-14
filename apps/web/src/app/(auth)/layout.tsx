import Link from "next/link";
import { PenLine } from "lucide-react";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-8 px-6 py-12">
      <Link href="/" className="flex items-center gap-2 font-semibold text-foreground">
        <PenLine className="h-5 w-5 text-primary" />
        SyncFlow
      </Link>
      <div className="w-full max-w-sm">{children}</div>
    </div>
  );
}
