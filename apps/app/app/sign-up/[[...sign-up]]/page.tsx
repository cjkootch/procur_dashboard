import { SignUp } from '@clerk/nextjs';
import { AuthShell, clerkAppearance } from '../../../components/auth/auth-shell';

export default function SignUpPage() {
  return (
    <AuthShell
      title="Get started with Procur"
      subtitle="Create your account in under a minute. No credit card required."
      altLink={{
        cta: 'Already have an account?',
        href: '/sign-in',
        label: 'Sign in',
      }}
    >
      <SignUp appearance={clerkAppearance} />
    </AuthShell>
  );
}
