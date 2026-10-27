import type { SpanAttributes } from "@earendil-works/pi-telemetry";
import type { Attributes, SpanAttributeValue } from "@opentelemetry/api";

/**
 * Copy a pi-telemetry attribute bag into OpenTelemetry attributes.
 * Later defined values win via ordinary object assignment at the call site;
 * `undefined` is dropped so it stays a merge no-op, matching both the
 * pi-telemetry contract and the SDK (which ignores `undefined` and retains
 * the previous value).
 */
export function toOtelAttributes(attributes?: SpanAttributes): Attributes {
	const result: Record<string, SpanAttributeValue> = {};
	for (const [name, value] of Object.entries(attributes ?? {})) {
		if (value === undefined) continue;
		result[name] = Array.isArray(value) ? [...value] : value;
	}
	return result;
}
