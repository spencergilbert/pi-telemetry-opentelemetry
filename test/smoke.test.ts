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

	it("treats propagation as a no-op until Phase 2", async () => {
		const telemetry = createOpenTelemetryTelemetry();
		await telemetry.startSpan({ name: "carrier-source" }, (span) => {
			expect(telemetry.propagation.inject(span)).toBeUndefined();
		});
		const root = telemetry.propagation.extract(undefined);
		await expect(root.startSpan({ name: "extracted-root" }, () => "ok")).resolves.toBe("ok");
	});
});
