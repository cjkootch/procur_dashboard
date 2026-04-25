import { SignIn } from '@clerk/nextjs';
import { AuthShell, clerkAppearance } from '../../../components/auth/auth-shell';

export default function SignInPage() {
  return (
    <AuthShell
      title="Sign in to Procur"
      subtitle="Welcome back. Pick up where you left off."
      altLink={{
        cta: 'New to Procur?',
        href: '/sign-up',
        label: 'Create an account',
      }}
    >
      <SignIn appearance={clerkAppearance} />
    </AuthShell>
  );
}
