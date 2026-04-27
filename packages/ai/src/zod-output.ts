import { zodOutputFormat as anthropicZodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { ZodType, infer as ZInfer } from 'zod/v4';
import type { AutoParseableOutputFormat } from '@anthropic-ai/sdk/lib/parser';

/**
 * Typed wrapper around Anthropic SDK's zodOutputFormat helper.
 *
 * Why this exists: @anthropic-ai/sdk@0.88.0's `zodOutputFormat` is
 * declared with Zod 3 types in its TS signature (`ZodType<any,
 * ZodTypeDef, any>`) but **internally** calls Zod 4's `toJSONSchema`,
 * which only succeeds on Zod 4 schemas (it reads `schema.def` — a
 * field that only exists on Zod 4 objects).
 *
 * Our schemas in `types.ts` and per-task files are now Zod 4 schemas
 * (imported from 'zod/v4') so the runtime call works. But the SDK's
 * Zod 3 type signature rejects them at the TS level. This wrapper
 * casts past that mismatch in one place so the 13 task files don't
 * have to repeat the cast.
 *
 * Remove once the SDK ships a unified Zod 4 type signature.
 */
export function zodOutputFormat<T extends ZodType>(
  schema: T,
): AutoParseableOutputFormat<ZInfer<T>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return anthropicZodOutputFormat(schema as any) as AutoParseableOutputFormat<ZInfer<T>>;
}
