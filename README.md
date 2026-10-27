# @brainrot.xyz/pi-telemetry-opentelemetry

OpenTelemetry adapter for [`@earendil-works/pi-telemetry`](https://www.npmjs.com/package/@earendil-works/pi-telemetry).
Pi packages pass telemetry contexts explicitly; this adapter bridges that
vendor-neutral contract to OpenTelemetry tracers, meters, and propagators.

> Status: Phase 2 (propagation). Span lifecycle, attributes, events, links,
> status, and W3C trace-context propagation are implemented and covered by
> the pi-telemetry conformance suite; metrics (Phase 3) remain a declared
> placeholder.

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

Bring your own providers to control exporters, sampling, and resources:

```typescript
import { SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';

const provider = new TracerProvider({
	// Any SpanExporter, e.g. an OTLP exporter; plus resource and sampler as needed.
	spanProcessors: [new SimpleSpanProcessor({ exporter: myExporter })],
});
const telemetry = createOpenTelemetryTelemetry({ tracerProvider: provider });
```

## Compatibility

| Dependency | Version | Notes |
|---|---|---|
| `@earendil-works/pi-telemetry` | 1.4.0 | Adapter contract + conformance suite source |
| `@opentelemetry/api` | 1.10.0 | Shared by the whole OTel set |
| `@opentelemetry/core` | 3.0.0 | W3C trace-context propagator |
| `@opentelemetry/sdk-trace` | 3.0.0 | Span recording, dev-only (3.x line; `sdk-trace-base@2.x` peers `api<1.10` and conflicts with `sdk-metrics@3.x`) |
| `@opentelemetry/sdk-metrics` | 3.0.0 | Instrument recording, dev-only (Phase 3 tests) |
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
