import { Button, Section, Text } from '@react-email/components';
import { EmailLayout, styles } from './components/layout';
import { OpportunityRow, type OpportunityRowData } from './components/opportunity-row';

export type OpportunityAlertEmailProps = {
  firstName: string | null;
  alertName: string;
  opportunity: OpportunityRowData;
  reason: string;
  unsubscribeUrl: string;
};

export default function OpportunityAlertEmail({
  firstName,
  alertName,
  opportunity,
  reason,
  unsubscribeUrl,
}: OpportunityAlertEmailProps) {
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';
  return (
    <EmailLayout
      preview={`New tender: ${opportunity.title}`}
      unsubscribeUrl={unsubscribeUrl}
    >
      <Text style={styles.h1}>New tender matches {alertName}</Text>
      <Text style={styles.lead}>
        {greeting} {reason}
      </Text>

      <Section style={{ margin: '16px 0' }}>
        <OpportunityRow op={opportunity} />
      </Section>

      <Section style={{ margin: '24px 0' }}>
        <Button href={opportunity.url} style={styles.button}>
          View the tender →
        </Button>
      </Section>
    </EmailLayout>
  );
}
