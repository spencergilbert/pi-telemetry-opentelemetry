# @brainrot.xyz/pi-telemetry-opentelemetry

OpenTelemetry adapter for [`@earendil-works/pi-telemetry`](https://www.npmjs.com/package/@earendil-works/pi-telemetry).
Pi packages pass telemetry contexts explicitly; this adapter bridges that
vendor-neutral contract to OpenTelemetry tracers, meters, and propagators.

> Status: complete. Span lifecycle, attributes, events, links, status,
> W3C trace-context propagation, metrics (counters, up-down counters,
> histograms), and the env-based OTLP helper are implemented and covered
> by the pi-telemetry conformance suite.

## Installation

```bash
npm install @brainrot.xyz/pi-telemetry-opentelemetry
```

## Usage

```typescript
import { createOpenTelemetryTelemetry } from '@brainrot.xyz/pi-telemetry-opentelemetry';

const telemetry = createOpenTelemetryTelemetry();
// Pass `telemetry` (a TelemetryContext) to pi packages that accept one.
await telemetry.shutdown();
```

Bring your own providers to control exporters, sampling, aggregation, and resources:

```typescript
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';

const tracerProvider = new TracerProvider({
	// Any SpanExporter, e.g. an OTLP exporter; plus resource and sampler as needed.
	spanProcessors: [new SimpleSpanProcessor({ exporter: mySpanExporter })],
});
const meterProvider = new MeterProvider({
	// Any MetricReader, e.g. a periodic OTLP reader; plus views as needed.
	readers: [new PeriodicExportingMetricReader({ exporter: myMetricExporter })],
});
const telemetry = createOpenTelemetryTelemetry({ tracerProvider, meterProvider });
```

Batteries-included OTLP/HTTP setup from the environment:

```typescript
import { createNodeOtlpTelemetry } from '@brainrot.xyz/pi-telemetry-opentelemetry';

// Honors OTEL_EXPORTER_OTLP_ENDPOINT (plus signal-specific endpoints and
// headers), OTEL_SERVICE_NAME, and OTEL_RESOURCE_ATTRIBUTES. Shut down the
// returned providers after telemetry.shutdown() for a clean exit.
const { telemetry, tracerProvider, meterProvider } = createNodeOtlpTelemetry();
```

`createNodeOtlpTelemetry()` accepts explicit `serviceName`,
`resourceAttributes`, `traceEndpoint`, `metricsEndpoint`, `headers`, and
`enableMeasurementJournal` overrides; anything left unset falls back to
the exporters' standard `OTEL_EXPORTER_OTLP_*` handling. Use
`resolveNodeOtlpResourceAttributes()` to reuse the same service-name and
resource-attribute resolution when building custom providers.

`telemetry.getMetrics()` returns an ordered snapshot of the measurements
recorded through the adapter's instruments (recording order, no
aggregation) for tests. Pass `enableMeasurementJournal: true` to retain
it; the journal is disabled by default so long-lived processes retain
nothing. Production querying belongs to the metrics backend, which
aggregates per its views and readers.

## Compatibility

| Dependency | Version | Notes |
|---|---|---|
| `@earendil-works/pi-telemetry` | 1.4.0 | Adapter contract + conformance suite source |
| `@opentelemetry/api` | 1.10.0 | Shared by the whole OTel set |
| `@opentelemetry/core` | 3.0.0 | W3C trace-context propagator |
| `@opentelemetry/sdk-trace` | 3.0.0 | Span recording (3.x line; `sdk-trace-base@2.x` peers `api<1.10` and conflicts with `sdk-metrics@3.x`) + OTLP helper providers |
| `@opentelemetry/sdk-metrics` | 3.0.0 | Instrument recording + OTLP helper providers |
| `@opentelemetry/exporter-trace-otlp-http` | 0.300.0 | OTLP helper span export (pins the 3.0.0 SDK line) |
| `@opentelemetry/exporter-metrics-otlp-http` | 0.300.0 | OTLP helper metric export (pins the 3.0.0 SDK line) |
| `@opentelemetry/resources` | 3.0.0 | OTLP helper service-name / resource attributes |
| Node.js | >=22.19.0 | Matches pi-telemetry |

## Non-goals

- `TelemetryStore` (trace/metric querying) — OTel backends own storage.
- Exporter, sampler, resource, or view configuration — provider-owned.
- Renaming pi-owned `pi.ai.*` / `pi.durable.*` vocabulary.

## Development

```bash
npm install
npm test
npm run build
npm run check
```

## License

MIT
