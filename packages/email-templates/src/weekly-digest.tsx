import { Button, Section, Text } from '@react-email/components';
import { EmailLayout, styles } from './components/layout';
import { OpportunityRow, type OpportunityRowData } from './components/opportunity-row';

export type WeeklyDigestEmailProps = {
  firstName: string | null;
  alertName: string;
  opportunities: OpportunityRowData[];
  totalValueUsd: string | null;
  discoverUrl: string;
  unsubscribeUrl: string;
};

export default function WeeklyDigestEmail({
  firstName,
  alertName,
  opportunities,
  totalValueUsd,
  discoverUrl,
  unsubscribeUrl,
}: WeeklyDigestEmailProps) {
  const count = opportunities.length;
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';

  return (
    <EmailLayout
      preview={`Your week in tenders: ${count} new matching "${alertName}"`}
      unsubscribeUrl={unsubscribeUrl}
    >
      <Text style={styles.h1}>Your week in tenders</Text>
      <Text style={styles.lead}>
        {greeting} {count} new tender{count === 1 ? '' : 's'} matched{' '}
        <strong>{alertName}</strong> this week
        {totalValueUsd ? ` — combined estimated value ${totalValueUsd}` : ''}.
      </Text>

      <Text style={styles.h2}>Highlights</Text>
      <Section>
        {opportunities.slice(0, 10).map((op) => (
          <OpportunityRow key={op.id} op={op} />
        ))}
      </Section>

      {opportunities.length > 10 && (
        <Text style={styles.muted}>
          …and {opportunities.length - 10} more. View the full list on Discover.
        </Text>
      )}

      <Section style={{ margin: '24px 0' }}>
        <Button href={`${discoverUrl}/opportunities`} style={styles.button}>
          Browse all →
        </Button>
      </Section>
    </EmailLayout>
  );
}
