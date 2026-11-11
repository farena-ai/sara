// make_document: the look of the three quick templates (and the plain default), shared by Word,
// PDF, PowerPoint and HTML so a document looks the same whichever format it is made in.
import type { Template } from './spec.ts';

export interface Theme {
  /** Headings and rules (hex, no #). */
  accent: string;
  /** Captions, footers, quotes. */
  muted: string;
  /** Table header fill. */
  head: string;
  /** Point sizes. */
  title: number;
  h1: number;
  h2: number;
  h3: number;
  body: number;
  /** Space between lines, as a multiple of the size. */
  lead: number;
  titleAlign: 'left' | 'center';
  /** A rule under the title (report, resume). */
  titleRule: boolean;
  /** Section headings in capitals with a rule under them (resume). */
  sectionRule: boolean;
  /** Page numbers in the footer: always, or only when there's more than one page (letters). */
  pageNumbers: 'always' | 'many' | 'never';
  /** Page margin, points. */
  margin: number;
  /** Space after a paragraph, points. */
  after: number;
}

const BASE: Theme = { accent: '1F3A5F', muted: '6B7280', head: 'E8EEF5', title: 24, h1: 17, h2: 13.5, h3: 11.5, body: 10.5, lead: 1.42, titleAlign: 'left', titleRule: false, sectionRule: false, pageNumbers: 'always', margin: 60, after: 6 };

export const THEMES: Record<Template, Theme> = {
  plain: BASE,
  report: { ...BASE, title: 26, titleRule: true },
  letter: { ...BASE, accent: '222222', h1: 13, h2: 12, h3: 11, body: 11, lead: 1.45, pageNumbers: 'many', margin: 72, after: 9 },
  resume: { ...BASE, accent: '1F3A5F', title: 24, h1: 12, h2: 11, h3: 10.5, body: 10, lead: 1.32, titleAlign: 'center', titleRule: false, sectionRule: true, pageNumbers: 'never', margin: 48, after: 3 },
};

export const rgb = (hex: string): [number, number, number] => [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
