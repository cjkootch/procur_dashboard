import { SignIn } from '@clerk/nextjs';

export default function SignInPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="w-full max-w-sm">
        <h1 className="mb-4 text-center text-lg font-semibold">Procur Admin</h1>
        <p className="mb-6 text-center text-xs text-[color:var(--color-muted-foreground)]">
          Internal tooling. Sign in with your Procur staff account.
        </p>
        <SignIn />
      </div>
    </main>
  );
}
