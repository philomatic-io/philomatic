/**
 * Validation report types (MVP.md). The parser returns a structured
 * report rather than throwing, so callers (a CLI `validate` dry-run, or `import`) decide
 * what to do with it.
 */

export type IssueCode =
  | 'illegal_endpoint'
  | 'dangling_reference'
  | 'prerequisite_cycle'
  | 'refinement_cycle'
  | 'precedence_cycle'
  | 'external_prerequisite';

export interface Issue {
  code: IssueCode;
  message: string;
  /** JSON-pointer-ish location, e.g. "edges[3].dstId" or a node id. */
  pointer?: string;
}

export interface ValidationReport {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
}

/** Thrown by `engine.importPayload` when validation fails. */
export class ValidationError extends Error {
  constructor(readonly report: ValidationReport) {
    super(
      `Validation failed with ${report.errors.length} error(s):\n` +
        report.errors.map((e) => `  - [${e.code}] ${e.message}`).join('\n'),
    );
    this.name = 'ValidationError';
  }
}
