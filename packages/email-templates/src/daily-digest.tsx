import { Button, Section, Text } from '@react-email/components';
import { EmailLayout, styles } from './components/layout';
import { OpportunityRow, type OpportunityRowData } from './components/opportunity-row';

export type DailyDigestEmailProps = {
  firstName: string | null;
  alertName: string;
  opportunities: OpportunityRowData[];
  discoverUrl: string;
  unsubscribeUrl: string;
};

export default function DailyDigestEmail({
  firstName,
  alertName,
  opportunities,
  discoverUrl,
  unsubscribeUrl,
}: DailyDigestEmailProps) {
  const count = opportunities.length;
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';

  return (
    <EmailLayout
      preview={`${count} new tender${count === 1 ? '' : 's'} matching "${alertName}"`}
      unsubscribeUrl={unsubscribeUrl}
    >
      <Text style={styles.h1}>
        {count} new tender{count === 1 ? '' : 's'} today
      </Text>
      <Text style={styles.lead}>
        {greeting} Matching your alert <strong>{alertName}</strong>.
      </Text>

      <Section>
        {opportunities.map((op) => (
          <OpportunityRow key={op.id} op={op} />
        ))}
      </Section>

      <Section style={{ margin: '24px 0' }}>
        <Button href={`${discoverUrl}/opportunities`} style={styles.button}>
          View all opportunities →
        </Button>
      </Section>
    </EmailLayout>
  );
}
