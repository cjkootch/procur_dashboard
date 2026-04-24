import { Link, Section, Text } from '@react-email/components';
import { styles } from './layout';

export type OpportunityRowData = {
  id: string;
  title: string;
  url: string;
  agency: string | null;
  jurisdiction: string;
  value: string | null;
  deadline: string | null;
};

export function OpportunityRow({ op }: { op: OpportunityRowData }) {
  return (
    <Section style={{ margin: '0 0 16px 0' }}>
      <Link href={op.url} style={styles.oppTitle}>
        {op.title}
      </Link>
      <Text style={styles.oppMeta}>
        {op.jurisdiction}
        {op.agency ? ` · ${op.agency}` : ''}
      </Text>
      {(op.value || op.deadline) && (
        <Text style={styles.oppMeta}>
          {op.value ? `Value: ${op.value}` : ''}
          {op.value && op.deadline ? ' · ' : ''}
          {op.deadline ? `Closes: ${op.deadline}` : ''}
        </Text>
      )}
    </Section>
  );
}
