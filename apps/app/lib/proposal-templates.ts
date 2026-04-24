/**
 * Pre-built proposal outlines tailored to specific Caribbean / LatAm procurement portals.
 *
 * When a pursuit's opportunity is from one of these jurisdictions, we seed the
 * proposal with the portal's preferred section structure + nomenclature
 * rather than the generic 5-section default.
 */

export type TemplateSection = {
  number: string;
  title: string;
  description: string;
  mandatoryContent: string[];
  pageLimit?: number;
};

export type ProposalTemplate = {
  id: string;
  name: string;
  jurisdictions: string[]; // jurisdictions.slug values this template applies to
  description: string;
  sections: TemplateSection[];
};

const GENERIC_SECTIONS: TemplateSection[] = [
  {
    number: '1',
    title: 'Executive Summary',
    description: 'High-level win themes, company fit, and commitment to the buyer.',
    mandatoryContent: ['Win themes', 'Company overview', 'Commitment statement'],
  },
  {
    number: '2',
    title: 'Technical Approach',
    description: 'How we will deliver against the technical requirements.',
    mandatoryContent: [],
  },
  {
    number: '3',
    title: 'Past Performance',
    description: 'Relevant prior contracts demonstrating capacity to deliver.',
    mandatoryContent: [],
  },
  {
    number: '4',
    title: 'Management Plan',
    description: 'Team, governance, compliance with legal and regulatory requirements.',
    mandatoryContent: [],
  },
  {
    number: '5',
    title: 'Pricing',
    description: 'Firm fixed price, labor rates, or schedule of values per solicitation.',
    mandatoryContent: [],
  },
];

export const GENERIC_TEMPLATE: ProposalTemplate = {
  id: 'generic',
  name: 'Generic 5-section',
  jurisdictions: [],
  description: 'Works for any tender. Start here if nothing else fits.',
  sections: GENERIC_SECTIONS,
};

export const JAMAICA_GOJEP_TEMPLATE: ProposalTemplate = {
  id: 'jamaica-gojep',
  name: 'Jamaica GOJEP',
  jurisdictions: ['jamaica'],
  description:
    'Standard Jamaica Government of Jamaica Electronic Procurement (GOJEP) response format.',
  sections: [
    {
      number: '1',
      title: 'Form of Tender',
      description:
        'Bidder declaration of offer, signed by authorized representative. Must match GOJEP-provided form exactly.',
      mandatoryContent: [
        'Bid validity period',
        'Bid price in JMD (and USD equivalent if applicable)',
        'Authorized signature',
      ],
      pageLimit: 2,
    },
    {
      number: '2',
      title: 'Bid Bond / Security',
      description: 'Evidence of the required bid security per Tender Document.',
      mandatoryContent: ['Bid bond from approved institution', 'Amount as specified in ITT'],
      pageLimit: 2,
    },
    {
      number: '3',
      title: 'Company Profile',
      description: 'Legal status, registration, ownership, and general capabilities.',
      mandatoryContent: [
        'Certificate of Incorporation',
        'Tax Compliance Certificate (TCC)',
        'National Insurance Scheme (NIS) compliance',
        'Ownership disclosure',
      ],
    },
    {
      number: '4',
      title: 'Technical Proposal',
      description:
        'Scope understanding, methodology, work plan, and approach to each requirement.',
      mandatoryContent: [],
    },
    {
      number: '5',
      title: 'Experience and Past Performance',
      description:
        'Similar contracts completed. Include client references with contact details.',
      mandatoryContent: [
        'Three relevant prior contracts',
        'Client references with verified contact details',
      ],
    },
    {
      number: '6',
      title: 'Key Personnel',
      description: 'CVs and proposed roles for all key personnel named in the ITT.',
      mandatoryContent: [],
    },
    {
      number: '7',
      title: 'Financial Proposal',
      description:
        'Priced Bill of Quantities or Schedule of Rates per ITT. Separate sealed envelope if instructed.',
      mandatoryContent: ['Priced BoQ / SoR', 'Breakdown by line item', 'Currency: JMD unless specified'],
    },
  ],
};

export const GUYANA_NPTAB_TEMPLATE: ProposalTemplate = {
  id: 'guyana-nptab',
  name: 'Guyana NPTAB',
  jurisdictions: ['guyana'],
  description: 'National Procurement and Tender Administration Board (Guyana) format.',
  sections: [
    {
      number: '1',
      title: 'Bid Form',
      description: 'Signed offer per NPTAB-provided bid form.',
      mandatoryContent: ['Bid validity', 'Bid price in GYD', 'Authorized signature'],
      pageLimit: 2,
    },
    {
      number: '2',
      title: 'Bid Security',
      description: 'Bid bond or equivalent as specified.',
      mandatoryContent: [],
      pageLimit: 2,
    },
    {
      number: '3',
      title: 'Eligibility and Qualification',
      description: 'Company registration, VAT, PAYE compliance, ownership disclosure.',
      mandatoryContent: [
        'Certificate of Registration / Incorporation',
        'VAT Compliance Certificate',
        'NIS Compliance Certificate',
        'PAYE Compliance',
        'Beneficial ownership declaration',
      ],
    },
    {
      number: '4',
      title: 'Technical Response',
      description: 'Methodology, work plan, and compliance statement against specifications.',
      mandatoryContent: [],
    },
    {
      number: '5',
      title: 'Past Performance',
      description: 'Completed similar contracts in Guyana or the Caribbean region.',
      mandatoryContent: [],
    },
    {
      number: '6',
      title: 'Key Personnel CVs',
      description: 'CVs for the project manager and other key personnel.',
      mandatoryContent: [],
    },
    {
      number: '7',
      title: 'Priced Schedule',
      description: 'Line-item pricing per the tender schedule. GYD unless otherwise required.',
      mandatoryContent: ['Line-item pricing in GYD'],
    },
  ],
};

export const TRINIDAD_EGP_TEMPLATE: ProposalTemplate = {
  id: 'trinidad-egp',
  name: 'Trinidad eGP',
  jurisdictions: ['trinidad-and-tobago'],
  description: 'Trinidad and Tobago Electronic Government Procurement format.',
  sections: [
    {
      number: '1',
      title: 'Letter of Tender',
      description: 'Signed cover letter confirming the offer.',
      mandatoryContent: [],
      pageLimit: 2,
    },
    {
      number: '2',
      title: 'Bid Security',
      description: 'Per section of the eGP Tender Documents.',
      mandatoryContent: [],
      pageLimit: 2,
    },
    {
      number: '3',
      title: 'Corporate Information',
      description:
        'Business registration, ownership structure, BIR compliance, NIS compliance.',
      mandatoryContent: [
        'Certificate of Incorporation / Registration',
        'BIR Tax Clearance',
        'NIS Clearance',
      ],
    },
    {
      number: '4',
      title: 'Technical Submission',
      description: 'Scope understanding, methodology, delivery schedule.',
      mandatoryContent: [],
    },
    {
      number: '5',
      title: 'Experience and Reference Projects',
      description: 'Similar work performed, with verifiable contact references.',
      mandatoryContent: [],
    },
    {
      number: '6',
      title: 'Team Composition',
      description: 'Proposed team, roles, and CVs for key personnel.',
      mandatoryContent: [],
    },
    {
      number: '7',
      title: 'Financial Proposal',
      description: 'Priced Bill of Quantities, currency as specified (typically TTD).',
      mandatoryContent: ['Priced BoQ', 'Currency and unit rates'],
    },
  ],
};

export const DR_DGCP_TEMPLATE: ProposalTemplate = {
  id: 'dr-dgcp',
  name: 'República Dominicana (DGCP)',
  jurisdictions: ['dominican-republic'],
  description:
    'Dirección General de Contrataciones Públicas (República Dominicana). Secciones en español.',
  sections: [
    {
      number: '1',
      title: 'Carta de Presentación',
      description: 'Oferta formal firmada por el representante autorizado.',
      mandatoryContent: ['Validez de la oferta', 'Precio en DOP', 'Firma autorizada'],
      pageLimit: 2,
    },
    {
      number: '2',
      title: 'Garantía de Seriedad de la Oferta',
      description: 'Según requerimientos del pliego.',
      mandatoryContent: [],
      pageLimit: 2,
    },
    {
      number: '3',
      title: 'Credenciales y Cumplimiento',
      description:
        'RNC, registro como proveedor del Estado, cumplimiento tributario y de Seguridad Social.',
      mandatoryContent: [
        'Certificado de RNC',
        'Registro como Proveedor del Estado (RPE)',
        'Certificación de TSS y DGII',
        'Declaración jurada de beneficiarios finales',
      ],
    },
    {
      number: '4',
      title: 'Propuesta Técnica',
      description: 'Enfoque técnico, metodología y plan de trabajo.',
      mandatoryContent: [],
    },
    {
      number: '5',
      title: 'Experiencia Previa',
      description: 'Contratos similares ejecutados, con referencias verificables.',
      mandatoryContent: [],
    },
    {
      number: '6',
      title: 'Personal Clave',
      description: 'CV del personal clave propuesto.',
      mandatoryContent: [],
    },
    {
      number: '7',
      title: 'Propuesta Económica',
      description: 'Precios unitarios y totales, en DOP.',
      mandatoryContent: ['Precios en DOP', 'Desglose de partidas'],
    },
  ],
};

export const ALL_TEMPLATES: ProposalTemplate[] = [
  GENERIC_TEMPLATE,
  JAMAICA_GOJEP_TEMPLATE,
  GUYANA_NPTAB_TEMPLATE,
  TRINIDAD_EGP_TEMPLATE,
  DR_DGCP_TEMPLATE,
];

export function templatesForJurisdiction(slug: string): ProposalTemplate[] {
  const matches = ALL_TEMPLATES.filter((t) => t.jurisdictions.includes(slug));
  if (matches.length === 0) return [GENERIC_TEMPLATE];
  return [...matches, GENERIC_TEMPLATE];
}

export function getTemplateById(id: string): ProposalTemplate | null {
  return ALL_TEMPLATES.find((t) => t.id === id) ?? null;
}
