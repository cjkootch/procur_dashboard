import { Button, Section, Text } from '@react-email/components';
import { EmailLayout, styles } from './components/layout';

export type MatchQueueDigestRow = {
  id: string;
  signalType: 'distress_event' | 'velocity_drop' | 'new_award' | string;
  signalKind: string;
  score: number;
  entityName: string;
  entityCountry: string | null;
  rationale: string;
  observedAt: string;
  entityProfileUrl: string | null;
};

export type MatchQueueDigestEmailProps = {
  firstName: string | null;
  rows: MatchQueueDigestRow[];
  totalOpenCount: number;
  matchQueueUrl: string;
  unsubscribeUrl: string;
};

const SIGNAL_LABEL: Record<string, string> = {
  distress_event: 'Distress',
  velocity_drop: 'Velocity drop',
  new_award: 'New award',
};

const SIGNAL_COLOR: Record<string, string> = {
  distress_event: '#b42318',
  velocity_drop: '#b54708',
  new_award: '#067647',
};

export default function MatchQueueDigestEmail({
  firstName,
  rows,
  totalOpenCount,
  matchQueueUrl,
  unsubscribeUrl,
}: MatchQueueDigestEmailProps) {
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';
  const headline =
    rows.length === totalOpenCount
      ? `${rows.length} open lead${rows.length === 1 ? '' : 's'} today`
      : `Top ${rows.length} of ${totalOpenCount} open leads today`;

  return (
    <EmailLayout
      preview={`${rows.length} match-queue lead${rows.length === 1 ? '' : 's'} ranked for today`}
      unsubscribeUrl={unsubscribeUrl}
    >
      <Text style={styles.h1}>{headline}</Text>
      <Text style={styles.lead}>
        {greeting} Here are today&apos;s ranked deal-origination signals from your match queue.
      </Text>

      <Section>
        {rows.map((row) => (
          <Section key={row.id} style={rowWrap}>
            <Text style={rowTop}>
              <span style={scoreChip}>{row.score.toFixed(1)}</span>
              <span
                style={{
                  ...badgeChip,
                  color: SIGNAL_COLOR[row.signalType] ?? '#444',
                }}
              >
                {SIGNAL_LABEL[row.signalType] ?? row.signalType}
              </span>
              <strong style={entityName}>
                {row.entityProfileUrl ? (
                  <a href={row.entityProfileUrl} style={entityLink}>
                    {row.entityName}
                  </a>
                ) : (
                  row.entityName
                )}
              </strong>
              {row.entityCountry && (
                <span style={countryTag}> ({row.entityCountry})</span>
              )}
            </Text>
            <Text style={rationale}>{row.rationale}</Text>
            <Text style={metaLine}>
              {row.signalKind} · observed {row.observedAt}
            </Text>
          </Section>
        ))}
      </Section>

      <Section style={{ margin: '24px 0' }}>
        <Button href={matchQueueUrl} style={styles.button}>
          Open match queue →
        </Button>
      </Section>
    </EmailLayout>
  );
}

const rowWrap = {
  borderTop: '1px solid #eaeaea',
  padding: '12px 0',
};

const rowTop = {
  fontSize: '14px',
  margin: '0',
  lineHeight: '20px',
};

const scoreChip = {
  display: 'inline-block',
  border: '1px solid #d0d0d0',
  borderRadius: '4px',
  padding: '1px 6px',
  fontSize: '11px',
  fontWeight: 600 as const,
  fontVariantNumeric: 'tabular-nums' as const,
  marginRight: '8px',
  color: '#222',
};

const badgeChip = {
  display: 'inline-block',
  border: '1px solid currentColor',
  borderRadius: '999px',
  padding: '1px 8px',
  fontSize: '10px',
  fontWeight: 600 as const,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.04em',
  marginRight: '8px',
};

const entityName = {
  fontSize: '14px',
  color: '#111',
};

const entityLink = {
  color: '#0b5fff',
  textDecoration: 'none',
};

const countryTag = {
  fontSize: '12px',
  color: '#666',
  marginLeft: '4px',
};

const rationale = {
  fontSize: '13px',
  color: '#333',
  margin: '4px 0 0 0',
  lineHeight: '19px',
};

const metaLine = {
  fontSize: '11px',
  color: '#888',
  margin: '2px 0 0 0',
};
