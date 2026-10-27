import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createNodeOtlpTelemetry, resolveNodeOtlpResourceAttributes } from "../src/index.ts";

async function startCollector(captured: string[]): Promise<{ close: () => Promise<void>; baseUrl: string }> {
	const server = http.createServer((request, response) => {
		captured.push(request.url ?? "");
		request.resume();
		request.on("end", () => {
			response.writeHead(200, { "content-type": "application/json" }).end("{}");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	return {
		baseUrl: `http://127.0.0.1:${port}`,
		close: () =>
			new Promise<void>((resolve, reject) =>
				server.close((error) => (error === undefined ? resolve() : reject(error))),
			),
	};
}

describe("resolveNodeOtlpResourceAttributes", () => {
	it("returns no attributes for empty environments", () => {
		expect(resolveNodeOtlpResourceAttributes({ env: {} })).toEqual({});
	});

	it("reads the service name from the environment", () => {
		expect(resolveNodeOtlpResourceAttributes({ env: { OTEL_SERVICE_NAME: "payments" } })).toEqual({
			"service.name": "payments",
		});
	});

	it("prefers explicit options over the environment", () => {
		expect(
			resolveNodeOtlpResourceAttributes({
				serviceName: "explicit",
				resourceAttributes: { region: "explicit" },
				env: { OTEL_SERVICE_NAME: "env", OTEL_RESOURCE_ATTRIBUTES: "region=env,team=api" },
			}),
		).toEqual({ "service.name": "explicit", region: "explicit", team: "api" });
	});

	it("prefers OTEL_SERVICE_NAME over service.name in OTEL_RESOURCE_ATTRIBUTES", () => {
		expect(
			resolveNodeOtlpResourceAttributes({
				env: { OTEL_SERVICE_NAME: "payments", OTEL_RESOURCE_ATTRIBUTES: "service.name=billing,team=api" },
			}),
		).toEqual({ "service.name": "payments", team: "api" });
	});

	it("lets explicit resourceAttributes win over every environment source", () => {
		expect(
			resolveNodeOtlpResourceAttributes({
				serviceName: "explicit",
				resourceAttributes: { "service.name": "override" },
				env: { OTEL_SERVICE_NAME: "env", OTEL_RESOURCE_ATTRIBUTES: "service.name=parsed" },
			}),
		).toEqual({ "service.name": "override" });
	});

	it("parses spec-compliant attributes including percent-encoding", () => {
		expect(resolveNodeOtlpResourceAttributes({ env: { OTEL_RESOURCE_ATTRIBUTES: "team=a%20b,,region=us" } })).toEqual(
			{ team: "a b", region: "us" },
		);
	});

	it("discards the whole value when any entry is malformed", () => {
		for (const raw of ["good=1,k=a=b", "good=1,badentry", "good=1,=nokey", "good=1,team=%ZZ"]) {
			expect(resolveNodeOtlpResourceAttributes({ env: { OTEL_RESOURCE_ATTRIBUTES: raw } })).toEqual({});
		}
		expect(
			resolveNodeOtlpResourceAttributes({ env: { OTEL_RESOURCE_ATTRIBUTES: `toolong=${"x".repeat(256)}` } }),
		).toEqual({});
	});

	it("treats blank environment values as unset", () => {
		expect(
			resolveNodeOtlpResourceAttributes({ env: { OTEL_SERVICE_NAME: "  ", OTEL_RESOURCE_ATTRIBUTES: "" } }),
		).toEqual({});
	});
});

describe("createNodeOtlpTelemetry", () => {
	it("exports spans and metrics to the configured collector", async () => {
		const captured: string[] = [];
		const collector = await startCollector(captured);
		try {
			const { telemetry, tracerProvider, meterProvider } = createNodeOtlpTelemetry({
				serviceName: "smoke",
				traceEndpoint: `${collector.baseUrl}/v1/traces`,
				metricsEndpoint: `${collector.baseUrl}/v1/metrics`,
				enableMeasurementJournal: true,
			});
			telemetry.metrics.counter("requests").add(2, { route: "home" });
			await telemetry.startSpan({ name: "measured" }, (span) => {
				telemetry.metrics.histogram("latency", { unit: "ms" }).record(9, {}, span);
			});
			expect(telemetry.getMetrics().map((measurement) => [measurement.kind, measurement.name])).toEqual([
				["counter", "requests"],
				["histogram", "latency"],
			]);
			await telemetry.shutdown();
			await tracerProvider.shutdown();
			await meterProvider.shutdown();
		} finally {
			await collector.close();
		}
		expect(captured).toContain("/v1/traces");
		expect(captured).toContain("/v1/metrics");
	});

	it("retains no measurements unless the journal is enabled", async () => {
		const captured: string[] = [];
		const collector = await startCollector(captured);
		try {
			const { telemetry, tracerProvider, meterProvider } = createNodeOtlpTelemetry({
				serviceName: "smoke",
				traceEndpoint: `${collector.baseUrl}/v1/traces`,
				metricsEndpoint: `${collector.baseUrl}/v1/metrics`,
			});
			telemetry.metrics.counter("requests").add(1);
			expect(telemetry.getMetrics()).toEqual([]);
			await telemetry.shutdown();
			await tracerProvider.shutdown();
			await meterProvider.shutdown();
		} finally {
			await collector.close();
		}
	});
});
