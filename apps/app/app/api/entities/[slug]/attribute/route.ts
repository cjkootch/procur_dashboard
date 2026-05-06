import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  EDITABLE_ENTITY_ATTRIBUTES,
  insertFeedbackEvent,
  updateKnownEntityAttribute,
  type EditableEntityAttribute,
} from '@procur/catalog';
import { getCurrentUser } from '@procur/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PATCH /api/entities/[slug]/attribute
 *   { attribute: 'role' | 'country' | ..., newValue: string | string[] | null }
 *
 * Updates a single attribute on a known_entities row, then logs the
 * change to feedback_events (kind='entity_attribute') so Pattern 2
 * generates training labels for ML Component D attribute prediction.
 *
 * Per docs/feedback-ui-brief.md §5.3: edits affect the entity
 * GLOBALLY (not per-user), so the route doesn't scope by user.
 * Auth is required to prevent random POSTs but the edit is shared.
 */
const BodySchema = z.object({
  attribute: z.enum(EDITABLE_ENTITY_ATTRIBUTES as readonly [EditableEntityAttribute, ...EditableEntityAttribute[]]),
  newValue: z.union([z.string(), z.array(z.string()), z.null()]),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { slug } = await params;
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'bad_request', detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const decodedSlug = decodeURIComponent(slug);
  const result = await updateKnownEntityAttribute({
    slug: decodedSlug,
    attribute: parsed.data.attribute,
    newValue: parsed.data.newValue,
  });

  // Determine edit_type per brief §5.4 schema.
  const editType =
    result.oldValue == null && result.newValue != null
      ? 'addition'
      : result.oldValue != null && result.newValue == null
      ? 'removal'
      : 'correction';

  await insertFeedbackEvent({
    userId: user.id,
    feedbackKind: 'entity_attribute',
    targetType: 'entity',
    targetId: decodedSlug,
    targetSecondaryId: parsed.data.attribute,
    sentiment: 'neutral',
    payload: {
      attribute: parsed.data.attribute,
      old_value: result.oldValue,
      new_value: result.newValue,
      edit_type: editType,
    },
    context: { page: `/entities/${decodedSlug}` },
  });

  // Revalidate the entity page so the next render shows the new value.
  revalidatePath(`/entities/${decodedSlug}`);
  return NextResponse.json({ ok: true });
}
