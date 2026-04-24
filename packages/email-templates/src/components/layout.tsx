import {
  Body,
  Container,
  Head,
  Hr,
  Html,
  Link,
  Preview,
  Section,
  Text,
} from '@react-email/components';
import type { ReactNode } from 'react';

const main = {
  backgroundColor: '#f7f6f3',
  fontFamily:
    "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,Ubuntu,Cantarell,'Open Sans','Helvetica Neue',sans-serif",
  margin: 0,
  padding: 0,
};

const container = {
  margin: '0 auto',
  padding: '24px 16px',
  maxWidth: '600px',
  backgroundColor: '#ffffff',
};

const brandHeader = {
  fontSize: '20px',
  fontWeight: 600 as const,
  color: '#111111',
  margin: '0 0 24px 0',
  letterSpacing: '-0.01em',
};

const footer = {
  fontSize: '12px',
  color: '#666666',
  lineHeight: '18px',
  margin: '8px 0',
};

export type EmailLayoutProps = {
  preview: string;
  children: ReactNode;
  unsubscribeUrl?: string;
};

export function EmailLayout({ preview, children, unsubscribeUrl }: EmailLayoutProps) {
  return (
    <Html>
      <Head />
      <Preview>{preview}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Text style={brandHeader}>Procur</Text>
          {children}
          <Hr style={{ borderColor: '#eaeaea', margin: '32px 0 16px' }} />
          <Section>
            <Text style={footer}>
              Procur aggregates government tenders across the Caribbean, Latin America, and
              Africa. You received this because you have an active Procur account.
            </Text>
            {unsubscribeUrl && (
              <Text style={footer}>
                <Link href={unsubscribeUrl} style={{ color: '#666666' }}>
                  Unsubscribe or manage alerts
                </Link>
              </Text>
            )}
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

export const styles = {
  h1: {
    fontSize: '22px',
    fontWeight: 600 as const,
    color: '#111111',
    margin: '0 0 8px 0',
    letterSpacing: '-0.01em',
  },
  h2: {
    fontSize: '16px',
    fontWeight: 600 as const,
    color: '#111111',
    margin: '24px 0 8px 0',
  },
  lead: {
    fontSize: '15px',
    lineHeight: '22px',
    color: '#333333',
    margin: '0 0 16px 0',
  },
  body: {
    fontSize: '14px',
    lineHeight: '21px',
    color: '#333333',
    margin: '0 0 12px 0',
  },
  muted: {
    fontSize: '13px',
    color: '#666666',
    margin: '0',
  },
  button: {
    display: 'inline-block',
    padding: '10px 18px',
    borderRadius: '6px',
    backgroundColor: '#111111',
    color: '#ffffff',
    fontWeight: 500 as const,
    fontSize: '14px',
    textDecoration: 'none',
  },
  oppTitle: {
    fontSize: '15px',
    fontWeight: 600 as const,
    color: '#0b5fff',
    textDecoration: 'none',
  },
  oppMeta: {
    fontSize: '12px',
    color: '#666666',
    margin: '2px 0 0 0',
  },
} as const;
