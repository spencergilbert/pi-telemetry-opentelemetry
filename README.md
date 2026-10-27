# @brainrot.xyz/pi-telemetry-opentelemetry

OpenTelemetry adapter for [`@earendil-works/pi-telemetry`](https://www.npmjs.com/package/@earendil-works/pi-telemetry).
Pi packages pass telemetry contexts explicitly; this adapter bridges that
vendor-neutral contract to OpenTelemetry tracers, meters, and propagators.

> Status: Phase 3 (metrics). Span lifecycle, attributes, events, links,
> status, W3C trace-context propagation, and metrics (counters,
> up-down counters, histograms) are implemented and covered by the
> pi-telemetry conformance suite.

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
| `@opentelemetry/sdk-trace` | 3.0.0 | Span recording, dev-only (3.x line; `sdk-trace-base@2.x` peers `api<1.10` and conflicts with `sdk-metrics@3.x`) |
| `@opentelemetry/sdk-metrics` | 3.0.0 | Test MeterProvider + exporters (fixture/smoke); the adapter itself only needs `@opentelemetry/api` meter types |
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
