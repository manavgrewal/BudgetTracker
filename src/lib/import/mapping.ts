import { z } from 'zod';

export type AmountMode = 'signed' | 'debit_credit';
export type SignConvention = 'negative_is_spend' | 'positive_is_spend';
export type EncodingChoice = 'auto' | 'utf-8' | 'windows-1252';

export interface ImportMapping {
  hasHeader: boolean;
  /** Number of leading lines to discard (usually 1 when hasHeader). */
  headerRows: number;
  /** 0-based column index. */
  dateCol: number;
  /** One of DATE_FORMATS in src/lib/dates.ts. */
  dateFormat: string;
  /** 0-based column indexes joined with a single space to form raw_description. */
  descCols: number[];
  amountMode: AmountMode;
  amountCol: number | null;
  debitCol: number | null;
  creditCol: number | null;
  /**
   * Only meaningful when amountMode === 'signed'.
   * In 'debit_credit' mode the debit column is always money out (negative cents)
   * and the credit column is always money in (positive cents).
   */
  signConvention: SignConvention;
  encoding: EncodingChoice;
  /** Rows whose joined raw text contains any of these strings are silently skipped. */
  skipRules: { containsAny: string[] } | null;
}

const baseSchema = z.object({
  hasHeader: z.boolean(),
  headerRows: z.number().int().min(0).max(20),
  dateCol: z.number().int().min(0).max(200),
  dateFormat: z.string().min(1),
  descCols: z.array(z.number().int().min(0).max(200)).min(1),
  amountMode: z.enum(['signed', 'debit_credit']),
  amountCol: z.number().int().min(0).max(200).nullable(),
  debitCol: z.number().int().min(0).max(200).nullable(),
  creditCol: z.number().int().min(0).max(200).nullable(),
  signConvention: z.enum(['negative_is_spend', 'positive_is_spend']),
  encoding: z.enum(['auto', 'utf-8', 'windows-1252']),
  skipRules: z.object({ containsAny: z.array(z.string().min(1)) }).nullable(),
});

export const importMappingSchema = baseSchema.superRefine((value, ctx) => {
  if (value.amountMode === 'signed' && value.amountCol === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'amountCol is required when amountMode is "signed"' });
  }
  if (value.amountMode === 'debit_credit' && value.debitCol === null && value.creditCol === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'debitCol or creditCol is required when amountMode is "debit_credit"',
    });
  }
}) as unknown as z.ZodType<ImportMapping>;

export function parseImportMapping(value: unknown): ImportMapping {
  const input = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  return importMappingSchema.parse(input);
}

export function serializeImportMapping(mapping: ImportMapping): string {
  return JSON.stringify(importMappingSchema.parse(mapping));
}
