/**
 * BrowserOps procedure v1 JSON Schema.
 *
 * Ported verbatim (structure + limits) from `@browserops/bridge@0.0.11`
 * (shared/dist/procedures.js, shared/dist/locator.js), MIT License,
 * Copyright (c) 2025-2026 Saket Aryan and contributors.
 *
 * Forge validates every compiled procedure against this schema so that what
 * the compiler emits is exactly what `procedures_save` will accept.
 */
import Ajv from "ajv";

export const LOCATOR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    role: { type: "string", minLength: 1, maxLength: 40 },
    name: { type: "string", minLength: 1, maxLength: 400 },
    aria_label: { type: "string", minLength: 1, maxLength: 400 },
    data_testid: { type: "string", minLength: 1, maxLength: 200 },
    href: { type: "string", minLength: 1, maxLength: 400 },
    attr: {
      type: "object",
      additionalProperties: false,
      required: ["name", "value"],
      properties: {
        name: { type: "string", minLength: 1, maxLength: 80 },
        value: { type: "string", minLength: 1, maxLength: 400 },
      },
    },
    has_text: { type: "string", minLength: 1, maxLength: 400 },
    has_text_not: { type: "string", minLength: 1, maxLength: 400 },
    in_frame: { type: "string", minLength: 1, maxLength: 400 },
    near: {
      type: "object",
      additionalProperties: false,
      properties: {
        ref: { type: "integer", minimum: 1 },
        locator: { type: "object", additionalProperties: true },
        radius_px: { type: "number", minimum: 0 },
      },
    },
    nth: { type: "integer", minimum: 0 },
    scope: { enum: ["viewport", "document"] },
  },
} as const;

const expectSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    url_matches: { type: "string", maxLength: 400 },
    text_visible: { type: "string", maxLength: 400 },
    text_invisible: { type: "string", maxLength: 400 },
    new_dialog: { oneOf: [{ type: "boolean" }, { type: "string", maxLength: 200 }] },
    network_endpoint: { type: "string", maxLength: 400 },
    network_endpoint_seen: { type: "string", maxLength: 400 },
    value_contains: {
      type: "object",
      additionalProperties: false,
      required: ["substring"],
      properties: {
        locator: LOCATOR_SCHEMA,
        ref: { type: "integer", minimum: 1 },
        substring: { type: "string", maxLength: 400 },
      },
    },
    visual_delta_at_least: { type: "number", minimum: 0, maximum: 1 },
    focus_moved_to: {
      type: "object",
      additionalProperties: false,
      properties: { locator: LOCATOR_SCHEMA },
    },
    dom_added_min: { type: "integer", minimum: 0 },
    dom_removed_min: { type: "integer", minimum: 0 },
    console_errors_max: { type: "integer", minimum: 0 },
    timeout_ms: { type: "integer", minimum: 0, maximum: 60000 },
    poll_interval_ms: { type: "integer", minimum: 50, maximum: 5000 },
  },
} as const;

const fallbackSchema = {
  type: "object",
  additionalProperties: false,
  required: ["strategy"],
  properties: {
    strategy: { enum: ["strict", "retry", "relocate", "relocate_then_llm", "llm"] },
    budget: {
      type: "object",
      additionalProperties: false,
      properties: {
        tool_calls: { type: "integer", minimum: 0, maximum: 50 },
        tokens: { type: "integer", minimum: 0, maximum: 50000 },
      },
    },
    retry: {
      type: "object",
      additionalProperties: false,
      properties: {
        attempts: { type: "integer", minimum: 1, maximum: 10 },
        backoff_ms: { type: "integer", minimum: 0, maximum: 30000 },
      },
    },
    relocate: {
      type: "object",
      additionalProperties: false,
      properties: {
        widen_role: { type: "boolean" },
        widen_name: { type: "boolean" },
        consider_text: { type: "boolean" },
      },
    },
  },
} as const;

const autoWaitSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    timeout_ms: { type: "integer", minimum: 0, maximum: 60000 },
    poll_interval_ms: { type: "integer", minimum: 50, maximum: 5000 },
  },
} as const;

const forbiddenSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    locators: { type: "array", items: LOCATOR_SCHEMA, maxItems: 20 },
    actions: {
      type: "array",
      items: { type: "string", maxLength: 80 },
      maxItems: 20,
      uniqueItems: true,
    },
  },
} as const;

const stepSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "do"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 80 },
    goal: { type: "string", minLength: 1, maxLength: 200 },
    do: {
      enum: ["click", "type", "press", "hover", "navigate", "scroll", "wait", "observe", "procedure_call", "js"],
    },
    locator: LOCATOR_SCHEMA,
    with: { type: "object", additionalProperties: true },
    auto_wait: autoWaitSchema,
    expect: expectSchema,
    fallback: fallbackSchema,
    bind: { type: "string", minLength: 1, maxLength: 80 },
  },
} as const;

const stepHealthSchema = {
  type: "object",
  additionalProperties: false,
  required: ["runs", "relocates", "ambiguous_resolves", "target_changed"],
  properties: {
    runs: { type: "integer", minimum: 0 },
    relocates: { type: "integer", minimum: 0 },
    ambiguous_resolves: { type: "integer", minimum: 0 },
    target_changed: { type: "integer", minimum: 0 },
    avg_match_count: { type: "number", minimum: 0 },
    last_tier: { enum: [1, 2, 3] },
    last_ref: { type: "integer", minimum: 1 },
  },
} as const;

const procedureMetaSchema = {
  type: "object",
  additionalProperties: false,
  required: ["version", "created"],
  properties: {
    version: { type: "number", minimum: 1 },
    created: { type: "string" },
    last_verified: { type: "string" },
    status: { enum: ["draft", "trusted"] },
    health: {
      type: "object",
      additionalProperties: false,
      required: ["updated", "steps"],
      properties: {
        updated: { type: "string" },
        steps: { type: "object", additionalProperties: stepHealthSchema, maxProperties: 60 },
      },
    },
  },
} as const;

export const PROCEDURE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "name", "description", "kind", "steps"],
  properties: {
    schema_version: { const: 1 },
    name: { type: "string", pattern: "^[a-z][a-z0-9_.-]{0,79}$" },
    description: { type: "string", minLength: 1, maxLength: 200 },
    kind: { enum: ["leaf", "composite"] },
    goal: { type: "string", maxLength: 200 },
    domain: { type: "string", pattern: "^[a-z][a-z0-9_-]*$", maxLength: 40 },
    triggers: { type: "array", items: { type: "string", maxLength: 80 }, maxItems: 10 },
    tags: { type: "array", items: { type: "string", pattern: "^[a-z0-9_-]+$", maxLength: 24 }, maxItems: 10 },
    side_effects: {
      type: "array",
      items: { enum: ["send_message", "payment", "post_public", "modify_account", "delete"] },
      uniqueItems: true,
      maxItems: 5,
    },
    inputs: {
      type: "object",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        required: ["type"],
        properties: {
          type: { enum: ["string", "number", "boolean", "array", "object"] },
          required: { type: "boolean", default: true },
          description: { type: "string", maxLength: 200 },
          destructive: { type: "boolean" },
        },
      },
      maxProperties: 20,
    },
    forbidden: forbiddenSchema,
    verify: expectSchema,
    uses: { type: "array", items: { type: "string" }, uniqueItems: true, maxItems: 20 },
    steps: { type: "array", items: stepSchema, minItems: 1, maxItems: 60 },
    meta: procedureMetaSchema,
  },
  if: { properties: { kind: { const: "composite" } } },
  then: { required: ["uses"] },
} as const;

const ajv = new Ajv({ allErrors: true, strict: false });
const validateFn = ajv.compile(PROCEDURE_SCHEMA);

export interface SchemaIssue {
  path: string;
  message: string;
}

export function validateProcedure(doc: unknown): { valid: boolean; issues: SchemaIssue[] } {
  const valid = validateFn(doc) as boolean;
  const issues = (validateFn.errors ?? []).map((e) => ({
    path: e.instancePath || "/",
    message: `${e.message ?? "invalid"}${e.params && "additionalProperty" in e.params ? ` (${(e.params as { additionalProperty: string }).additionalProperty})` : ""}`,
  }));
  return { valid, issues };
}
