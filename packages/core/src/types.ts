// Types mirroring the BrowserOps v1 procedure schema (see schema.ts).

export interface Locator {
  role?: string;
  name?: string;
  aria_label?: string;
  data_testid?: string;
  href?: string;
  attr?: { name: string; value: string };
  has_text?: string;
  has_text_not?: string;
  in_frame?: string;
  near?: { ref?: number; locator?: Locator; radius_px?: number };
  nth?: number;
  scope?: "viewport" | "document";
}

export interface Expect {
  url_matches?: string;
  text_visible?: string;
  text_invisible?: string;
  new_dialog?: boolean | string;
  network_endpoint?: string;
  network_endpoint_seen?: string;
  value_contains?: { locator?: Locator; ref?: number; substring: string };
  visual_delta_at_least?: number;
  focus_moved_to?: { locator?: Locator };
  dom_added_min?: number;
  dom_removed_min?: number;
  console_errors_max?: number;
  timeout_ms?: number;
  poll_interval_ms?: number;
}

export type FallbackStrategy = "strict" | "retry" | "relocate" | "relocate_then_llm" | "llm";

export interface Fallback {
  strategy: FallbackStrategy;
  budget?: { tool_calls?: number; tokens?: number };
  retry?: { attempts?: number; backoff_ms?: number };
  relocate?: { widen_role?: boolean; widen_name?: boolean; consider_text?: boolean };
}

export type StepAction =
  | "click"
  | "type"
  | "press"
  | "hover"
  | "navigate"
  | "scroll"
  | "wait"
  | "observe"
  | "procedure_call"
  | "js";

export interface Step {
  id: string;
  goal?: string;
  do: StepAction;
  locator?: Locator;
  with?: Record<string, unknown>;
  auto_wait?: { timeout_ms?: number; poll_interval_ms?: number };
  expect?: Expect;
  fallback?: Fallback;
  bind?: string;
}

export type SideEffect = "send_message" | "payment" | "post_public" | "modify_account" | "delete";

export interface InputSpec {
  type: "string" | "number" | "boolean" | "array" | "object";
  required?: boolean;
  description?: string;
  destructive?: boolean;
}

export interface StepHealth {
  runs: number;
  relocates: number;
  ambiguous_resolves: number;
  target_changed: number;
  avg_match_count?: number;
  last_tier?: 1 | 2 | 3;
  last_ref?: number;
}

export interface Health {
  updated: string;
  steps: Record<string, StepHealth>;
}

export interface Procedure {
  schema_version: 1;
  name: string;
  description: string;
  kind: "leaf" | "composite";
  goal?: string;
  domain?: string;
  triggers?: string[];
  tags?: string[];
  side_effects?: SideEffect[];
  inputs?: Record<string, InputSpec>;
  forbidden?: { locators?: Locator[]; actions?: string[] };
  verify?: Expect;
  uses?: string[];
  steps: Step[];
  meta?: {
    version: number;
    created: string;
    last_verified?: string;
    status?: "draft" | "trusted";
    health?: Health;
  };
}
