import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { ToolDefinition, ToolRegistry } from '../types';

/**
 * Minimal zod-to-json-schema for the primitives we actually use in tool
 * definitions. Adding a full converter would pull zod-to-json-schema;
 * keeping this inline avoids a dependency for a handful of shapes.
 */
function zodToJsonSchema(schema: z.ZodTypeAny): Anthropic.Tool['input_schema'] {
  const root = convert(schema);
  // Claude requires the top-level schema to be an object.
  if (root.type !== 'object') {
    return { type: 'object', properties: { value: root }, required: ['value'] };
  }
  return root as Anthropic.Tool['input_schema'];
}

// Minimal recursive walker for z.object / z.string / z.number / z.boolean /
// z.array / z.enum / z.optional / z.nullable / z.literal / z.union of literals.
function convert(schema: z.ZodTypeAny): Record<string, unknown> {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    return convert(schema._def.innerType);
  }
  if (schema instanceof z.ZodDefault) {
    return convert(schema._def.innerType);
  }
  if (schema instanceof z.ZodString) {
    const out: Record<string, unknown> = { type: 'string' };
    if (schema.description) out.description = schema.description;
    return out;
  }
  if (schema instanceof z.ZodNumber) {
    const out: Record<string, unknown> = { type: 'number' };
    if (schema.description) out.description = schema.description;
    return out;
  }
  if (schema instanceof z.ZodBoolean) {
    return { type: 'boolean' };
  }
  if (schema instanceof z.ZodArray) {
    return { type: 'array', items: convert(schema._def.type) };
  }
  if (schema instanceof z.ZodEnum) {
    return { type: 'string', enum: schema._def.values };
  }
  if (schema instanceof z.ZodLiteral) {
    const v = schema._def.value;
    return { type: typeof v, const: v };
  }
  if (schema instanceof z.ZodUnion) {
    return { anyOf: schema._def.options.map((o: z.ZodTypeAny) => convert(o)) };
  }
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = convert(value);
      if (!(value instanceof z.ZodOptional) && !(value instanceof z.ZodDefault)) {
        required.push(key);
      }
    }
    return {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    };
  }
  // Fallback — treat as free-form.
  return {};
}

export function defineTool<I extends z.ZodTypeAny, O>(
  def: Omit<ToolDefinition<I, O>, 'jsonSchema'>,
): ToolDefinition<I, O> {
  return {
    ...def,
    jsonSchema: zodToJsonSchema(def.schema),
  } as ToolDefinition<I, O>;
}

export function buildToolsParam(registry: ToolRegistry): Anthropic.Tool[] {
  return Object.values(registry).map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.jsonSchema,
  }));
}

// Exported for tests.
export { zodToJsonSchema };
