import type { TelemetryCarrier } from "@earendil-works/pi-telemetry";
import {
	AggregationTemporality,
	InMemoryMetricExporter,
	MeterProvider,
	PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
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

	it("retains no measurements unless the journal is enabled", () => {
		const telemetry = createOpenTelemetryTelemetry();
		telemetry.metrics.counter("requests").add(3);
		telemetry.metrics.histogram("latency").record(7);
		expect(telemetry.getMetrics()).toEqual([]);
	});

	it("records measurements through OTel instruments", async () => {
		const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
		const meterProvider = new MeterProvider({
			readers: [new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 60_000 })],
		});
		const tracerProvider = new TracerProvider({
			spanProcessors: [new SimpleSpanProcessor({ exporter: new InMemorySpanExporter() })],
		});
		const telemetry = createOpenTelemetryTelemetry({
			tracerProvider,
			meterProvider,
			enableMeasurementJournal: true,
		});
		telemetry.metrics.counter("requests").add(3, { route: "home" });
		telemetry.metrics.upDownCounter("inflight").add(1);
		await telemetry.startSpan({ name: "measured" }, (span) => {
			telemetry.metrics.histogram("latency", { unit: "ms" }).record(7, { route: "home" }, span);
		});
		await meterProvider.forceFlush();
		// The SDK aggregates, so the exporter proves forwarding while the
		// adapter snapshot preserves recording order.
		expect(metricExporter.getMetrics().length).toBeGreaterThan(0);
		const snapshot = telemetry.getMetrics();
		expect(snapshot.map((measurement) => [measurement.kind, measurement.name, measurement.value])).toEqual([
			["counter", "requests", 3],
			["upDownCounter", "inflight", 1],
			["histogram", "latency", 7],
		]);
		expect(snapshot[2]?.context).toMatchObject({ traceparent: expect.any(String) });
		await telemetry.shutdown();
		await meterProvider.shutdown();
		await tracerProvider.shutdown();
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
