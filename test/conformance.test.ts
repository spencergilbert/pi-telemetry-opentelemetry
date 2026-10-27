import type {
	AttributeValue,
	RecordedTelemetrySpan,
	SpanAttributes,
	TelemetryCarrier,
} from "@earendil-works/pi-telemetry";
import { createTelemetryAdapterConformance, type TelemetryAdapterFixture } from "@earendil-works/pi-telemetry/testing";
import { type Attributes, type SpanContext, SpanStatusCode } from "@opentelemetry/api";
import { MeterProvider } from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter, type ReadableSpan, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { describe, expect, it } from "vitest";
import { createOpenTelemetryTelemetry } from "../src/index.ts";

const ALL_GROUPS = new Set([
	"capabilities",
	"metrics",
	"links",
	"callback lifecycle",
	"status",
	"recording",
	"parentage",
	"propagation",
]);

function carrierOf(spanContext: SpanContext): TelemetryCarrier {
	const carrier: TelemetryCarrier = {
		traceparent: `00-${spanContext.traceId}-${spanContext.spanId}-0${Number(spanContext.traceFlags || 0).toString(16)}`,
	};
	const traceState = spanContext.traceState?.serialize();
	if (traceState) carrier.tracestate = traceState;
	return carrier;
}

function fromOtelValue(value: unknown): AttributeValue | undefined {
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
	if (Array.isArray(value) && value.every((item): item is string => typeof item === "string")) return [...value];
	if (Array.isArray(value) && value.every((item): item is number => typeof item === "number")) return [...value];
	if (Array.isArray(value) && value.every((item): item is boolean => typeof item === "boolean")) return [...value];
	return undefined;
}

function fromOtelAttributes(attributes?: Attributes): SpanAttributes {
	const result: SpanAttributes = {};
	for (const [name, value] of Object.entries(attributes ?? {})) {
		const converted = fromOtelValue(value);
		if (converted !== undefined) result[name] = converted;
	}
	return result;
}

function normalizeStatus(status: { code: SpanStatusCode; message?: string }): RecordedTelemetrySpan["status"] {
	if (status.code !== SpanStatusCode.ERROR) return { status: "ok" };
	if (status.message === undefined) return { status: "error" };
	const separator = status.message.indexOf(": ");
	if (separator < 0) return { status: "error" };
	return {
		status: "error",
		error: { name: status.message.slice(0, separator), message: status.message.slice(separator + 2) },
	};
}

function normalizeSpans(spans: readonly ReadableSpan[]): readonly RecordedTelemetrySpan[] {
	const ids = new Map<string, number>();
	for (const span of spans) {
		const spanId = span.spanContext().spanId;
		if (!ids.has(spanId)) ids.set(spanId, ids.size + 1);
	}
	return spans.map((span, index) => {
		const spanContext = span.spanContext();
		const parentSpanId = span.parentSpanContext?.spanId;
		return {
			id: ids.get(spanContext.spanId)!,
			parentId: parentSpanId === undefined ? null : (ids.get(parentSpanId) ?? null),
			context: carrierOf(spanContext),
			parentContext: span.parentSpanContext ? carrierOf(span.parentSpanContext) : null,
			links: span.links.map((link) => ({
				context: carrierOf(link.context),
				attributes: fromOtelAttributes(link.attributes),
			})),
			name: span.name,
			attributes: fromOtelAttributes(span.attributes),
			events: span.events.map((event) => ({ name: event.name, attributes: fromOtelAttributes(event.attributes) })),
			status: normalizeStatus(span.status),
			settled: true,
			endSequence: index,
		};
	});
}

async function createFixture(): Promise<TelemetryAdapterFixture> {
	const exporter = new InMemorySpanExporter();
	const tracerProvider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
	const meterProvider = new MeterProvider();
	const context = createOpenTelemetryTelemetry({
		tracerProvider,
		meterProvider,
		enableMeasurementJournal: true,
	});
	return {
		context,
		propagation: context.propagation,
		metrics: context.metrics,
		getMetrics: async () => context.getMetrics(),
		getSpans: async () => {
			await tracerProvider.forceFlush();
			return normalizeSpans(exporter.getFinishedSpans());
		},
		async [Symbol.asyncDispose]() {
			await tracerProvider.shutdown();
			await meterProvider.shutdown();
		},
	};
}

const conformance = createTelemetryAdapterConformance(createFixture);

describe("OpenTelemetry adapter conformance", () => {
	for (const group of new Set(conformance.map((testCase) => testCase.group))) {
		if (!ALL_GROUPS.has(group)) continue;
		describe(group, () => {
			for (const testCase of conformance.filter((candidate) => candidate.group === group)) {
				it(testCase.name, () => testCase.run());
			}
		});
	}

	it("covers every conformance group", () => {
		const groups = new Set(conformance.map((testCase) => testCase.group));
		for (const group of ALL_GROUPS) expect(groups.has(group)).toBe(true);
	});
});
