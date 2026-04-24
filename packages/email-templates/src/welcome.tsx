import { Button, Section, Text } from '@react-email/components';
import { EmailLayout, styles } from './components/layout';

export type WelcomeEmailProps = {
  firstName: string | null;
  appUrl: string;
  discoverUrl: string;
};

export default function WelcomeEmail({ firstName, appUrl, discoverUrl }: WelcomeEmailProps) {
  const name = firstName ?? 'there';
  return (
    <EmailLayout preview={`Welcome to Procur, ${name}`}>
      <Text style={styles.h1}>Welcome to Procur, {name}.</Text>
      <Text style={styles.lead}>
        You now have access to live government tenders from 15+ jurisdictions across the
        Caribbean, Latin America, and Africa. Here&rsquo;s how to get started.
      </Text>

      <Text style={styles.h2}>1. Browse opportunities</Text>
      <Text style={styles.body}>
        Every active tender we&rsquo;ve scraped is searchable and filterable on Discover — free.
      </Text>

      <Text style={styles.h2}>2. Set up an alert profile</Text>
      <Text style={styles.body}>
        Tell us the jurisdictions, categories, and value range you care about and we&rsquo;ll email
        matching new tenders daily or weekly. You can have multiple profiles.
      </Text>

      <Text style={styles.h2}>3. Track your pursuits</Text>
      <Text style={styles.body}>
        Procur Pro turns interesting tenders into a tracked pipeline: capture questions, task
        assignment, win-probability scoring, and AI-drafted proposals.
      </Text>

      <Section style={{ margin: '24px 0' }}>
        <Button href={`${appUrl}/onboarding`} style={styles.button}>
          Finish setup →
        </Button>
      </Section>

      <Text style={styles.muted}>
        Or start browsing at{' '}
        <a href={discoverUrl} style={{ color: '#0b5fff' }}>
          {discoverUrl.replace(/^https?:\/\//, '')}
        </a>
        .
      </Text>
    </EmailLayout>
  );
}
