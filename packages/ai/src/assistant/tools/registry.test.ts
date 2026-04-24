import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { defineTool, buildToolsParam, zodToJsonSchema } from './registry';

describe('zodToJsonSchema', () => {
  it('converts an object with required + optional string fields', () => {
    const schema = z.object({
      query: z.string(),
      limit: z.number().optional(),
    });
    const json = zodToJsonSchema(schema);
    assert.equal(json.type, 'object');
    assert.deepEqual(json.required, ['query']);
    const props = (json as { properties: Record<string, { type: string }> }).properties;
    assert.equal(props.query.type, 'string');
    assert.equal(props.limit.type, 'number');
  });

  it('handles enums and arrays', () => {
    const schema = z.object({
      stage: z.enum(['identification', 'qualification']),
      ids: z.array(z.string()),
    });
    const json = zodToJsonSchema(schema) as {
      properties: Record<string, { type: string; enum?: string[]; items?: { type: string } }>;
    };
    assert.deepEqual(json.properties.stage.enum, ['identification', 'qualification']);
    assert.equal(json.properties.ids.type, 'array');
    assert.equal(json.properties.ids.items?.type, 'string');
  });

  it('wraps non-object schemas under value', () => {
    const json = zodToJsonSchema(z.string()) as {
      type: string;
      required: string[];
      properties: Record<string, unknown>;
    };
    assert.equal(json.type, 'object');
    assert.deepEqual(json.required, ['value']);
  });
});

describe('defineTool + buildToolsParam', () => {
  it('emits a valid Claude tool param', () => {
    const tool = defineTool({
      name: 'search_opportunities',
      description: 'Search tender opportunities',
      kind: 'read',
      schema: z.object({ query: z.string(), limit: z.number().optional() }),
      handler: async () => ({ results: [] }),
    });

    const [param] = buildToolsParam({ [tool.name]: tool });
    assert.equal(param.name, 'search_opportunities');
    assert.equal(param.description, 'Search tender opportunities');
    assert.equal((param.input_schema as { type: string }).type, 'object');
  });
});
