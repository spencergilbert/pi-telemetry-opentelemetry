import { diag } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { defaultResource, resourceFromAttributes } from "@opentelemetry/resources";
import {
	type MeterProvider,
	PeriodicExportingMetricReader,
	MeterProvider as SdkMeterProvider,
} from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor, TracerProvider as SdkTracerProvider, type TracerProvider } from "@opentelemetry/sdk-trace";
import { createOpenTelemetryTelemetry, type OpenTelemetryTelemetry } from "./index.ts";

export interface NodeOtlpResourceOptions {
	/** Explicit service name; wins over `OTEL_SERVICE_NAME`. */
	readonly serviceName?: string;
	/** Explicit resource attributes; win over `OTEL_RESOURCE_ATTRIBUTES` per key. */
	readonly resourceAttributes?: Record<string, string>;
	/** Environment record; defaults to `process.env`. */
	readonly env?: Record<string, string | undefined>;
}

export interface NodeOtlpTelemetryOptions extends NodeOtlpResourceOptions {
	/** Explicit OTLP/HTTP trace endpoint; otherwise the exporter's standard `OTEL_EXPORTER_OTLP_*` handling applies. */
	readonly traceEndpoint?: string;
	/** Explicit OTLP/HTTP metrics endpoint; otherwise the exporter's standard `OTEL_EXPORTER_OTLP_*` handling applies. */
	readonly metricsEndpoint?: string;
	/** Explicit request headers; otherwise the exporter's standard `OTEL_EXPORTER_OTLP_*_HEADERS` handling applies. */
	readonly headers?: Record<string, string>;
	/** Retain the in-memory measurement journal test snapshot; disabled by default. */
	readonly enableMeasurementJournal?: boolean;
}

export interface NodeOtlpTelemetry {
	readonly telemetry: OpenTelemetryTelemetry;
	readonly tracerProvider: TracerProvider;
	readonly meterProvider: MeterProvider;
}

function readEnv(env: Record<string, string | undefined>, name: string): string | undefined {
	const value = env[name]?.trim();
	return value === "" || value === undefined ? undefined : value;
}

const RESOURCE_ATTRIBUTE_MAX_LENGTH = 255;

/**
 * Parse `OTEL_RESOURCE_ATTRIBUTES` with the SDK reference (`EnvDetector`)
 * semantics: comma-separated `key=value` entries with exactly one `=`,
 * non-empty keys, strict percent-decoding, and 255-character limits. Per
 * the spec, any error discards the entire value — this is the explicit
 * translation boundary for malformed input, mirroring the reference which
 * catches here and keeps only a `diag.debug` line.
 */
function parseResourceAttributes(raw: string | undefined): Record<string, string> {
	const attributes: Record<string, string> = {};
	if (raw === undefined) return attributes;
	try {
		for (const entry of raw.split(",")) {
			if (entry.trim() === "") continue;
			const pair = entry.split("=");
			if (pair.length !== 2) {
				throw new Error(`Invalid entry "${entry}": expected key=value with exactly one "=".`);
			}
			const key = pair[0].trim();
			const value = pair[1].trim();
			if (key.length === 0) {
				throw new Error(`Invalid entry "${entry}": empty key.`);
			}
			let decodedKey: string;
			let decodedValue: string;
			try {
				decodedKey = decodeURIComponent(key);
				decodedValue = decodeURIComponent(value);
			} catch (error) {
				throw new Error(
					`Failed to percent-decode entry "${entry}": ${error instanceof Error ? error.message : error}.`,
				);
			}
			if (decodedKey.length > RESOURCE_ATTRIBUTE_MAX_LENGTH || decodedValue.length > RESOURCE_ATTRIBUTE_MAX_LENGTH) {
				throw new Error(`Entry "${entry}" exceeds the 255-character limit.`);
			}
			attributes[decodedKey] = decodedValue;
		}
	} catch (error) {
		diag.debug(`Discarding malformed OTEL_RESOURCE_ATTRIBUTES: ${error instanceof Error ? error.message : error}`);
		return {};
	}
	return attributes;
}

/**
 * Resolve the resource attributes for the OTLP providers: an explicit
 * service name, then `OTEL_SERVICE_NAME`, plus `OTEL_RESOURCE_ATTRIBUTES`
 * parsed with the SDK reference (`EnvDetector`) semantics) under explicit
 * `resourceAttributes`. Also useful for hosts that build their own
 * providers but want consistent naming.
 */
export function resolveNodeOtlpResourceAttributes(options: NodeOtlpResourceOptions = {}): Record<string, string> {
	const env = options.env ?? process.env;
	const serviceName = options.serviceName ?? readEnv(env, "OTEL_SERVICE_NAME");
	return {
		...parseResourceAttributes(readEnv(env, "OTEL_RESOURCE_ATTRIBUTES")),
		// Matches the SDK reference (EnvDetector): OTEL_SERVICE_NAME wins
		// over service.name inside OTEL_RESOURCE_ATTRIBUTES; explicit
		// resourceAttributes still win per key.
		...(serviceName === undefined ? {} : { "service.name": serviceName }),
		...options.resourceAttributes,
	};
}

/**
 * Batteries-included Node.js telemetry backed by OTLP/HTTP exporters.
 * Endpoint, header, and certificate configuration follows the exporters'
 * standard `OTEL_EXPORTER_OTLP_*` handling; `serviceName` and
 * `resourceAttributes` seed the resource. Providers are caller-owned:
 * `telemetry.shutdown()` flushes both, then shut down the returned
 * providers for a clean exit.
 */
export function createNodeOtlpTelemetry(options: NodeOtlpTelemetryOptions = {}): NodeOtlpTelemetry {
	const resource = defaultResource().merge(resourceFromAttributes(resolveNodeOtlpResourceAttributes(options)));
	const tracerProvider = new SdkTracerProvider({
		resource,
		spanProcessors: [
			new BatchSpanProcessor({
				exporter: new OTLPTraceExporter({
					...(options.traceEndpoint === undefined ? {} : { url: options.traceEndpoint }),
					...(options.headers === undefined ? {} : { headers: options.headers }),
				}),
			}),
		],
	});
	const meterProvider = new SdkMeterProvider({
		resource,
		readers: [
			new PeriodicExportingMetricReader({
				exporter: new OTLPMetricExporter({
					...(options.metricsEndpoint === undefined ? {} : { url: options.metricsEndpoint }),
					...(options.headers === undefined ? {} : { headers: options.headers }),
				}),
			}),
		],
	});
	return {
		telemetry: createOpenTelemetryTelemetry({
			tracerProvider,
			meterProvider,
			...(options.enableMeasurementJournal === true ? { enableMeasurementJournal: true } : {}),
		}),
		tracerProvider,
		meterProvider,
	};
}
