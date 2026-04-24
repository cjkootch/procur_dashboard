import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  PageBreak,
  PageOrientation,
  Paragraph,
  TextRun,
  Table,
  TableCell,
  TableRow,
  WidthType,
  Footer,
  PageNumber,
  NumberFormat,
} from 'docx';
import { eq, and } from 'drizzle-orm';
import {
  agencies,
  db,
  jurisdictions,
  opportunities,
  proposals,
  pursuits,
} from '@procur/db';
import { requireCompany } from '@procur/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type OutlineSection = {
  id: string;
  number: string;
  title: string;
  description: string;
  evaluationCriteria: string[];
  pageLimit?: number;
  mandatoryContent: string[];
};

type SectionDraft = {
  id: string;
  outlineId: string;
  title: string;
  content: string;
  status: 'empty' | 'ai_drafted' | 'in_review' | 'finalized';
  wordCount: number;
};

type ComplianceRow = {
  requirementId: string;
  requirementText: string;
  addressedInSection?: string;
  status: 'not_addressed' | 'partially_addressed' | 'fully_addressed' | 'confirmed';
};

function paragraphsFromText(content: string): Paragraph[] {
  if (!content.trim()) {
    return [
      new Paragraph({
        children: [
          new TextRun({
            text: '[Section not yet drafted]',
            italics: true,
            color: '777777',
          }),
        ],
      }),
    ];
  }
  return content.split(/\n{2,}/).map(
    (block) =>
      new Paragraph({
        spacing: { after: 160 },
        children: [new TextRun(block.replace(/\n/g, ' '))],
      }),
  );
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ pursuitId: string }> },
): Promise<Response> {
  const { pursuitId } = await params;
  const { company } = await requireCompany();

  const [row] = await db
    .select({
      pursuitId: pursuits.id,
      companyId: pursuits.companyId,
      oppTitle: opportunities.title,
      oppReferenceNumber: opportunities.referenceNumber,
      agencyName: agencies.name,
      jurisdictionName: jurisdictions.name,
      deadlineAt: opportunities.deadlineAt,
    })
    .from(pursuits)
    .innerJoin(opportunities, eq(opportunities.id, pursuits.opportunityId))
    .innerJoin(jurisdictions, eq(jurisdictions.id, opportunities.jurisdictionId))
    .leftJoin(agencies, eq(agencies.id, opportunities.agencyId))
    .where(and(eq(pursuits.id, pursuitId), eq(pursuits.companyId, company.id)))
    .limit(1);

  if (!row) return new Response('not found', { status: 404 });

  const proposal = await db.query.proposals.findFirst({
    where: eq(proposals.pursuitId, pursuitId),
  });
  if (!proposal) return new Response('no proposal yet', { status: 404 });

  const outline = (proposal.outline as OutlineSection[] | null) ?? [];
  const sections = (proposal.sections as SectionDraft[] | null) ?? [];
  const compliance = (proposal.complianceMatrix as ComplianceRow[] | null) ?? [];

  const doc = new Document({
    creator: 'Procur',
    title: `${company.name} — ${row.oppTitle}`,
    description: 'Proposal response generated with Procur',
    styles: {
      default: {
        document: {
          run: { font: 'Calibri', size: 22 },
        },
      },
    },
    sections: [
      // Cover page
      {
        properties: {
          page: {
            size: { orientation: PageOrientation.PORTRAIT },
          },
        },
        footers: {
          default: new Footer({ children: [] }),
        },
        children: [
          new Paragraph({
            spacing: { before: 2000, after: 400 },
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: company.name, bold: true, size: 48 })],
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 400 },
            children: [new TextRun({ text: 'Proposal Response', size: 32 })],
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 800 },
            children: [
              new TextRun({
                text: row.oppTitle,
                italics: true,
                size: 28,
              }),
            ],
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new TextRun({
                text: [
                  row.agencyName ?? row.jurisdictionName,
                  row.oppReferenceNumber ? `Reference: ${row.oppReferenceNumber}` : null,
                  row.deadlineAt ? `Submission: ${row.deadlineAt.toLocaleDateString()}` : null,
                ]
                  .filter(Boolean)
                  .join('  ·  '),
                color: '555555',
              }),
            ],
          }),
          new Paragraph({ children: [new PageBreak()] }),

          // Table of contents (static; Word users can F9 refresh if they add heading styles)
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            children: [new TextRun({ text: 'Table of Contents', bold: true })],
          }),
          ...outline.map(
            (s) =>
              new Paragraph({
                spacing: { after: 80 },
                children: [
                  new TextRun({ text: `${s.number}. ${s.title}` }),
                ],
              }),
          ),
          new Paragraph({ children: [new PageBreak()] }),

          // Sections
          ...outline.flatMap((o) => {
            const draft = sections.find((s) => s.outlineId === o.id);
            const content = draft?.content ?? '';
            return [
              new Paragraph({
                heading: HeadingLevel.HEADING_1,
                spacing: { before: 400, after: 200 },
                children: [
                  new TextRun({ text: `${o.number}. ${o.title}`, bold: true }),
                ],
              }),
              ...(o.description
                ? [
                    new Paragraph({
                      spacing: { after: 200 },
                      children: [
                        new TextRun({
                          text: o.description,
                          italics: true,
                          color: '555555',
                        }),
                      ],
                    }),
                  ]
                : []),
              ...paragraphsFromText(content),
              new Paragraph({ children: [new PageBreak()] }),
            ];
          }),

          // Compliance matrix appendix
          ...(compliance.length > 0
            ? [
                new Paragraph({
                  heading: HeadingLevel.HEADING_1,
                  children: [new TextRun({ text: 'Appendix A: Compliance Matrix', bold: true })],
                  spacing: { before: 400, after: 200 },
                }),
                new Paragraph({
                  spacing: { after: 200 },
                  children: [
                    new TextRun({
                      text: 'Mapping of every tender requirement to the section of this proposal that addresses it.',
                      italics: true,
                      color: '555555',
                    }),
                  ],
                }),
                new Table({
                  width: { size: 100, type: WidthType.PERCENTAGE },
                  rows: [
                    new TableRow({
                      tableHeader: true,
                      children: ['Requirement', 'Addressed In', 'Status'].map(
                        (h) =>
                          new TableCell({
                            shading: { fill: 'EEEEEE' },
                            children: [
                              new Paragraph({
                                children: [new TextRun({ text: h, bold: true })],
                              }),
                            ],
                          }),
                      ),
                    }),
                    ...compliance.map((c) => {
                      const sec = outline.find((o) => o.id === c.addressedInSection);
                      return new TableRow({
                        children: [
                          new TableCell({
                            children: [new Paragraph(c.requirementText)],
                          }),
                          new TableCell({
                            children: [
                              new Paragraph(
                                sec ? `§${sec.number} ${sec.title}` : '—',
                              ),
                            ],
                          }),
                          new TableCell({
                            children: [
                              new Paragraph(
                                {
                                  not_addressed: 'Not addressed',
                                  partially_addressed: 'Partial',
                                  fully_addressed: 'Addressed',
                                  confirmed: 'Confirmed',
                                }[c.status] ?? c.status,
                              ),
                            ],
                          }),
                        ],
                      });
                    }),
                  ],
                }),
              ]
            : []),
        ],
      },
    ],
  });

  // Second section: add footer with page numbers on everything after cover.
  // docx 9.x allows per-section footers; to keep things simple we rebuild
  // via Packer.toBuffer directly on the composed doc.
  const _ = { PageNumber, NumberFormat }; // keep imports referenced for future footer work

  const buffer = await Packer.toBuffer(doc);

  const safeName = `${row.oppTitle}`
    .replace(/[^a-z0-9\- ]/gi, '')
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 60);

  return new Response(buffer as unknown as BodyInit, {
    headers: {
      'content-type':
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'content-disposition': `attachment; filename="procur-${safeName || 'proposal'}.docx"`,
      'cache-control': 'no-store',
    },
  });
}
