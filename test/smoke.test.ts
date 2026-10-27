import type { TelemetryCarrier } from "@earendil-works/pi-telemetry";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { describe, expect, it } from "vitest";
import { createOpenTelemetryTelemetry } from "../src/index.ts";

describe("adapter entry point", () => {
	it("exposes stable tracing capabilities and lifecycle", () => {
		const telemetry = createOpenTelemetryTelemetry();
		expect(typeof telemetry.startSpan).toBe("function");
		expect(typeof telemetry.flush).toBe("function");
		expect(typeof telemetry.shutdown).toBe("function");
		expect(telemetry.metrics).toBe(telemetry.metrics);
		expect(telemetry.propagation).toBe(telemetry.propagation);
	});

	it("survives destructured shutdown and admits spans afterwards", async () => {
		const telemetry = createOpenTelemetryTelemetry();
		const { flush, shutdown } = telemetry;
		await expect(flush()).resolves.toBeUndefined();
		await expect(shutdown()).resolves.toBeUndefined();
		await expect(telemetry.startSpan({ name: "after-shutdown" }, () => 42)).resolves.toBe(42);
		await expect(shutdown()).resolves.toBeUndefined();
	});

	it("fails fast on unimplemented Phase 3 metrics", () => {
		const telemetry = createOpenTelemetryTelemetry();
		expect(() => telemetry.metrics.counter("counter")).toThrow(/Phase 3/);
		expect(() => telemetry.metrics.upDownCounter("up-down")).toThrow(/Phase 3/);
		expect(() => telemetry.metrics.histogram("histogram")).toThrow(/Phase 3/);
	});

	it("roundtrips W3C trace context through inject/extract", async () => {
		const provider = new TracerProvider({
			spanProcessors: [new SimpleSpanProcessor({ exporter: new InMemorySpanExporter() })],
		});
		const telemetry = createOpenTelemetryTelemetry({ tracerProvider: provider });
		await telemetry.startSpan({ name: "carrier-source" }, async (span) => {
			const carrier = telemetry.propagation.inject(span);
			expect(carrier?.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
			const wire = JSON.parse(JSON.stringify(carrier));
			const extracted = telemetry.propagation.extract(wire);
			expect(extracted.propagation).toBe(telemetry.propagation);
			expect(extracted.metrics).toBe(telemetry.metrics);
			await expect(extracted.startSpan({ name: "extracted-child" }, () => "ok")).resolves.toBe("ok");
		});
		await telemetry.shutdown();
	});

	it("falls back to root for absent and unknown carriers", async () => {
		const telemetry = createOpenTelemetryTelemetry();
		expect(telemetry.propagation.inject(telemetry)).toBeUndefined();
		const carriers: readonly (TelemetryCarrier | undefined)[] = [undefined, {}, { unknown: "format" }];
		for (const carrier of carriers) {
			const context = telemetry.propagation.extract(carrier);
			await expect(context.startSpan({ name: "fallback" }, () => 42)).resolves.toBe(42);
		}
		await telemetry.shutdown();
	});
});
