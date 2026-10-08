/**
 * The `deck_design` → outline contract.
 *
 * Course design produces a page plan as data: each page says what it must
 * achieve, what it carries, and how it should be presented. Slide generation
 * used to receive teaching intent as a free-form `requirement` paragraph and
 * re-interpret it, which is where a teaching design turns back into a list of
 * titles.
 *
 * This module renders that plan into a prompt block. It is app-level on
 * purpose: the shared `@openmaic/generation` prompt templates are checksum-
 * pinned, and the course-design path is a deployment concern that has no
 * business changing the bytes the ad-hoc path sends.
 *
 * Two rules the rendering holds to:
 *
 * **The plan is authoritative.** Pages are emitted in `order`, one per
 * numbered block, and the model is told to follow them rather than restructure.
 * A generator allowed to reinvent the page structure has discarded the
 * teaching design that produced the plan.
 *
 * **Nothing is dropped silently.** A page missing `goal` or `coreInfo` is a
 * title rather than a design, and it is rendered with an explicit warning
 * instead of being quietly passed through — otherwise a broken plan produces
 * a plausible-looking deck that nobody can trace back to a teaching decision.
 */
import type { DeckDesign, DeckDesignPage } from '@/lib/types/generation';

/** What each presentation mode means to the model building the page. */
const MODE_INSTRUCTIONS: Record<DeckDesignPage['mode'], string> = {
  case: 'open with a concrete situation that makes the problem real — a real request, error, or screen',
  explain: 'state the mechanism plainly and directly',
  demo: 'show it happening rather than describing it',
  compare: 'place two things side by side and contrast the one decisive difference',
  diagram: 'draw the process, flow or structure — a diagram carries this page, not text',
  summary: 'consolidate what came before and point at what comes next',
};

const isNonEmpty = (value: string | undefined): value is string =>
  typeof value === 'string' && value.trim().length > 0;

/** One page, or null when it carries nothing a generator could act on. */
function renderPage(page: DeckDesignPage, position: number): string | null {
  const lines: string[] = [`### Page ${position}: ${page.title}`];

  if (isNonEmpty(page.goal)) {
    lines.push(`Goal: ${page.goal}`);
  } else {
    // A page with no goal is a heading. Say so rather than presenting it as
    // designed: the model should ask for the goal, not invent one.
    lines.push(
      'Goal: ⚠ MISSING — this page has no stated goal. Do not invent one; flag this page in your output.',
    );
  }

  if (isNonEmpty(page.coreInfo)) {
    lines.push(`Core message: ${page.coreInfo}`);
  } else {
    lines.push(
      'Core message: ⚠ MISSING — derive nothing from this page beyond its title and flag it.',
    );
  }

  lines.push(`Present as: ${MODE_INSTRUCTIONS[page.mode] ?? page.mode}.`);

  if (page.emphasis?.length) {
    lines.push(`Must land: ${page.emphasis.join('; ')}.`);
  }
  if (isNonEmpty(page.visual)) {
    lines.push(`Needs a diagram of: ${page.visual}.`);
  }
  if (isNonEmpty(page.code)) {
    lines.push('Must show this code verbatim:');
    lines.push('```');
    lines.push(page.code);
    lines.push('```');
  }

  return lines.join('\n');
}

/**
 * Render the deck design as a prompt block, or return null when there is
 * nothing to render. Null is the signal to fall back to the free-form
 * requirement path, so an empty or absent plan changes no existing behaviour.
 */
export function buildDeckDesignBlock(deckDesign: DeckDesign | undefined): string | null {
  if (!deckDesign?.pages?.length) return null;

  // A plan's order IS its teaching order. Sorting defensively here means a
  // plan stored out of order still produces pages in the right sequence, and
  // a duplicate order cannot silently drop a page.
  const pages = [...deckDesign.pages].sort((a, b) => a.order - b.order);

  const blocks = pages
    .map((page, index) => renderPage(page, index + 1))
    .filter((block): block is string => block !== null);

  const missing = pages.filter(
    (page) => !isNonEmpty(page.goal) || !isNonEmpty(page.coreInfo),
  ).length;

  const header = [
    '## Teaching plan (authoritative)',
    '',
    `This course was designed outcome-first. The ${pages.length} page(s) below are the teaching plan, produced by the course designer before any slide was generated. Follow this plan:`,
    '',
    '- Produce exactly these pages, in this order, with these titles.',
    '- Each page must achieve its stated goal and carry its stated core message. Do not merge pages, split them, or add pages that are not here.',
    '- A page marked ⚠ MISSING is incomplete in the plan: render what you can from its title and flag it in your output rather than inventing content for it.',
    '- The plan is the contract. Your job is to build these pages, not to redesign the lesson.',
  ];

  if (missing > 0) {
    header.push(
      '',
      `⚠ ${missing} of ${pages.length} planned page(s) are missing a goal or core message. Generate them as best you can and report which pages were incomplete.`,
    );
  }

  if (deckDesign.estPages && deckDesign.estPages !== pages.length) {
    header.push(
      '',
      `The plan estimates ${deckDesign.estPages} pages but specifies ${pages.length}. Follow the specified pages.`,
    );
  }

  return [...header, '', ...blocks].join('\n');
}
