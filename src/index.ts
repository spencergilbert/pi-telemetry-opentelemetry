import {
	NOOP_TELEMETRY_CONTEXT,
	type RecordedTelemetryMeasurement,
	type SpanAttributes,
	type SpanOptions,
	type SpanStatus,
	type TelemetryCarrier,
	type TelemetryContext,
	type TelemetryCounter,
	type TelemetryHistogram,
	type TelemetryMetrics,
	type TelemetryPropagation,
	type TelemetrySpan,
	type TelemetryUpDownCounter,
} from "@earendil-works/pi-telemetry";
import {
	defaultTextMapGetter,
	defaultTextMapSetter,
	isSpanContextValid,
	type MeterProvider,
	type Context as OTelContext,
	type Link as OTelLink,
	type SpanStatus as OTelStatus,
	context as otelContext,
	metrics as otelMetrics,
	trace as otelTrace,
	ROOT_CONTEXT,
	SpanStatusCode,
	type TracerProvider,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { toOtelAttributes } from "./attributes.ts";

const propagator = new W3CTraceContextPropagator();

export interface OpenTelemetryTelemetryOptions {
	/**
	 * Provider the adapter records spans through. Defaults to the global
	 * tracer provider, so hosts that already configure OpenTelemetry need no
	 * extra wiring. The adapter never shuts down an injected provider.
	 */
	readonly tracerProvider?: TracerProvider;
	/** Tracer name used for `tracerProvider.getTracer()`. */
	readonly tracerName?: string;
	/** Tracer version used for `tracerProvider.getTracer()`. */
	readonly tracerVersion?: string;
	/**
	 * Provider the adapter records measurements through. Defaults to the
	 * global meter provider, so hosts that already configure OpenTelemetry
	 * need no extra wiring. The adapter never shuts down an injected provider.
	 */
	readonly meterProvider?: MeterProvider;
	/** Meter name used for `meterProvider.getMeter()`. */
	readonly meterName?: string;
	/** Meter version used for `meterProvider.getMeter()`. */
	readonly meterVersion?: string;
	/**
	 * Test-only measurement journal. When true, every instrument recording
	 * is also appended to an in-memory journal in recording order (no
	 * aggregation) readable via `getMetrics()`; when false (default)
	 * nothing is retained and `getMetrics()` returns `[]`. The journal is
	 * unbounded by design, mirroring the reference in-memory adapter, so
	 * leave it disabled in long-lived processes.
	 */
	readonly enableMeasurementJournal?: boolean;
}

/**
 * OpenTelemetry-backed pi-telemetry context. Extends the vendor-neutral
 * contract with adapter lifecycle: `flush()` asks the tracer provider to
 * export buffered spans (a no-op when the provider has no `forceFlush`,
 * such as the default global provider), and `shutdown()` flushes and stops
 * the adapter (new spans become inert). Providers are always caller-owned
 * and are never shut down.
 */
export interface OpenTelemetryTelemetry extends TelemetryContext {
	readonly metrics: TelemetryMetrics;
	readonly propagation: TelemetryPropagation;
	flush(): Promise<void>;
	shutdown(): Promise<void>;
	/**
	 * Test support: ordered snapshot of the measurements recorded through
	 * this adapter's instruments, as detached copies in recording order
	 * (no aggregation). Only populated when `enableMeasurementJournal` is
	 * set; otherwise returns `[]`. Production querying belongs to the
	 * metrics backend.
	 */
	getMetrics(): readonly RecordedTelemetryMeasurement[];
}

function toOtelStatus(status: SpanStatus): OTelStatus {
	if (status.status === "ok") return { code: SpanStatusCode.OK };
	if (status.error === undefined) return { code: SpanStatusCode.ERROR };
	return { code: SpanStatusCode.ERROR, message: `${status.error.name}: ${status.error.message}` };
}

function errorStatusOf(error: unknown): OTelStatus {
	if (error instanceof Error) return { code: SpanStatusCode.ERROR, message: `${error.name}: ${error.message}` };
	return { code: SpanStatusCode.ERROR };
}

/**
 * Create an OpenTelemetry-backed telemetry context. Exporter, sampling,
 * aggregation, and resource configuration belong to the (optionally
 * injected) providers, not to this adapter. The global providers are used
 * when none are injected, so a host with an already-configured
 * OpenTelemetry SDK needs no options.
 */
export function createOpenTelemetryTelemetry(options: OpenTelemetryTelemetryOptions = {}): OpenTelemetryTelemetry {
	const tracerProvider = options.tracerProvider ?? otelTrace.getTracerProvider();
	const tracer = tracerProvider.getTracer(
		options.tracerName ?? "@brainrot.xyz/pi-telemetry-opentelemetry",
		options.tracerVersion,
	);
	const meterProvider = options.meterProvider ?? otelMetrics.getMeterProvider();
	const meter = meterProvider.getMeter(
		options.meterName ?? "@brainrot.xyz/pi-telemetry-opentelemetry",
		options.meterVersion,
	);
	const contexts = new WeakMap<TelemetryContext, OTelContext>();
	// Test-only journal of detached measurements in recording order. The
	// OpenTelemetry SDK aggregates (e.g. two up-down adds with the same
	// attributes become one data point), so the vendor-neutral snapshot
	// cannot be normalized from export data; with `enableMeasurementJournal`
	// every factory records here and forwards the same measurement to its
	// OTel instrument. Opt-in so production processes retain nothing.
	const journalEnabled = options.enableMeasurementJournal === true;
	const measurements: RecordedTelemetryMeasurement[] = [];
	let stopped = false;

	function carrierOfOtel(otelParent: OTelContext | undefined): TelemetryCarrier | null {
		if (otelParent === undefined) return null;
		const spanContext = otelTrace.getSpanContext(otelParent);
		if (spanContext === undefined || !isSpanContextValid(spanContext)) return null;
		const carrier: TelemetryCarrier = {};
		propagator.inject(otelParent, carrier, defaultTextMapSetter);
		return Object.keys(carrier).length > 0 ? carrier : null;
	}

	const metrics: TelemetryMetrics = {
		counter: (name, instrumentOptions): TelemetryCounter => {
			const description = instrumentOptions?.description;
			const unit = instrumentOptions?.unit;
			const instrument = meter.createCounter(name, {
				...(description !== undefined ? { description } : {}),
				...(unit !== undefined ? { unit } : {}),
			});
			return {
				add: (value, attributes) => {
					if (stopped) return;
					instrument.add(value, toOtelAttributes(attributes));
					if (journalEnabled) {
						measurements.push({
							kind: "counter",
							name,
							...(description !== undefined ? { description } : {}),
							...(unit !== undefined ? { unit } : {}),
							value,
							attributes: toOtelAttributes(attributes) as SpanAttributes,
							context: null,
						});
					}
				},
			};
		},
		upDownCounter: (name, instrumentOptions): TelemetryUpDownCounter => {
			const description = instrumentOptions?.description;
			const unit = instrumentOptions?.unit;
			const instrument = meter.createUpDownCounter(name, {
				...(description !== undefined ? { description } : {}),
				...(unit !== undefined ? { unit } : {}),
			});
			return {
				add: (value, attributes) => {
					if (stopped) return;
					instrument.add(value, toOtelAttributes(attributes));
					if (journalEnabled) {
						measurements.push({
							kind: "upDownCounter",
							name,
							...(description !== undefined ? { description } : {}),
							...(unit !== undefined ? { unit } : {}),
							value,
							attributes: toOtelAttributes(attributes) as SpanAttributes,
							context: null,
						});
					}
				},
			};
		},
		histogram: (name, histogramOptions): TelemetryHistogram => {
			const description = histogramOptions?.description;
			const unit = histogramOptions?.unit;
			const boundaries = histogramOptions?.boundaries === undefined ? undefined : [...histogramOptions.boundaries];
			const instrument = meter.createHistogram(name, {
				...(description !== undefined ? { description } : {}),
				...(unit !== undefined ? { unit } : {}),
				...(boundaries !== undefined ? { advice: { explicitBucketBoundaries: [...boundaries] } } : {}),
			});
			return {
				record: (value, attributes, context) => {
					if (stopped) return;
					const otelParent = context === undefined ? undefined : contexts.get(context);
					instrument.record(value, toOtelAttributes(attributes), otelParent);
					if (journalEnabled) {
						measurements.push({
							kind: "histogram",
							name,
							...(description !== undefined ? { description } : {}),
							...(unit !== undefined ? { unit } : {}),
							...(boundaries !== undefined ? { boundaries: [...boundaries] } : {}),
							value,
							attributes: toOtelAttributes(attributes) as SpanAttributes,
							context: carrierOfOtel(otelParent),
						});
					}
				},
			};
		},
	};

	const propagation: TelemetryPropagation = {
		inject: (context) => carrierOfOtel(contexts.get(context)) ?? undefined,
		extract: (carrier) => {
			if (carrier === undefined || typeof carrier !== "object" || Array.isArray(carrier)) return root;
			const extracted = propagator.extract(ROOT_CONTEXT, carrier, defaultTextMapGetter);
			const spanContext = otelTrace.getSpanContext(extracted);
			if (spanContext === undefined || !isSpanContextValid(spanContext)) return root;
			return makeExtracted(extracted);
		},
	};
	const root: TelemetryContext & { metrics: TelemetryMetrics; propagation: TelemetryPropagation } = {
		metrics,
		propagation,
		startSpan: (spanOptions, callback) =>
			stopped ? startInert(spanOptions, callback) : startFromParent(undefined, spanOptions, callback),
	};

	function makeExtracted(otelParent: OTelContext): TelemetryContext {
		const extracted: TelemetryContext = {
			metrics,
			propagation,
			startSpan: (spanOptions, callback) =>
				stopped ? startInert(spanOptions, callback) : startFromParent(otelParent, spanOptions, callback),
		};
		contexts.set(extracted, otelParent);
		return extracted;
	}

	function startInert<T>(spanOptions: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
		return NOOP_TELEMETRY_CONTEXT.startSpan(spanOptions, (noop) =>
			callback({
				...noop,
				metrics,
				propagation,
				startSpan: (childOptions, childCallback) => startInert(childOptions, childCallback),
			}),
		);
	}

	function resolveTarget(linkContext: TelemetryContext): OTelLink | undefined {
		const target = contexts.get(linkContext);
		const spanContext = target === undefined ? undefined : otelTrace.getSpanContext(target);
		return spanContext === undefined ? undefined : { context: spanContext };
	}

	function startFromParent<T>(
		parent: OTelContext | undefined,
		spanOptions: SpanOptions,
		callback: (span: TelemetrySpan) => T | Promise<T>,
	): Promise<T> {
		if (stopped) return startInert(spanOptions, callback);
		const links: OTelLink[] = [];
		for (const link of spanOptions.links ?? []) {
			const resolved = resolveTarget(link.context);
			if (resolved !== undefined) links.push({ ...resolved, attributes: toOtelAttributes(link.attributes) });
		}
		const otelSpan = tracer.startSpan(
			spanOptions.name,
			{ attributes: toOtelAttributes(spanOptions.attributes), links },
			parent ?? ROOT_CONTEXT,
		);
		const spanContext = otelTrace.setSpan(parent ?? ROOT_CONTEXT, otelSpan);
		let settled = false;
		let explicit = false;

		const settleOk = (value: T): T => {
			// Success leaves the OpenTelemetry status UNSET, the SDK
			// convention for success; snapshots still normalize to ok.
			otelSpan.end();
			settled = true;
			return value;
		};
		const settleError = (error: unknown): Promise<T> => {
			if (!explicit) otelSpan.setStatus(errorStatusOf(error));
			otelSpan.end();
			settled = true;
			return Promise.reject(error);
		};

		const span: TelemetrySpan = {
			metrics,
			propagation,
			startSpan: (childOptions, childCallback) =>
				settled || stopped
					? startInert(childOptions, childCallback)
					: startFromParent(spanContext, childOptions, childCallback),
			addLink: (link) => {
				if (settled || stopped) return;
				const resolved = resolveTarget(link.context);
				if (resolved !== undefined)
					otelSpan.addLink({ ...resolved, attributes: toOtelAttributes(link.attributes) });
			},
			addEvent: (name, attributes) => {
				if (settled || stopped) return;
				otelSpan.addEvent(name, toOtelAttributes(attributes));
			},
			setAttributes: (attributes) => {
				if (settled || stopped) return;
				otelSpan.setAttributes(toOtelAttributes(attributes));
			},
			setStatus: (status) => {
				if (settled || stopped) return;
				explicit = true;
				otelSpan.setStatus(toOtelStatus(status));
			},
		};
		contexts.set(span, spanContext);

		let result: T | Promise<T>;
		try {
			// Activates the span for downstream auto-instrumentation; the
			// callback still runs synchronously, exactly once.
			result = otelContext.with(spanContext, () => callback(span));
		} catch (error) {
			return settleError(error);
		}
		return Promise.resolve(result).then(settleOk, settleError);
	}

	function getMetrics(): readonly RecordedTelemetryMeasurement[] {
		return measurements.map((measurement) => ({
			...measurement,
			attributes: toOtelAttributes(measurement.attributes) as SpanAttributes,
			...(measurement.boundaries === undefined ? {} : { boundaries: [...measurement.boundaries] }),
			...(measurement.context === null ? { context: null } : { context: { ...measurement.context } }),
		}));
	}

	async function flush(): Promise<void> {
		const tracerFlushable = tracerProvider as { forceFlush?: () => unknown };
		const meterFlushable = meterProvider as { forceFlush?: () => unknown };
		await Promise.all([tracerFlushable.forceFlush?.(), meterFlushable.forceFlush?.()]);
	}

	async function shutdown(): Promise<void> {
		stopped = true;
		await flush();
	}

	return {
		...root,
		flush,
		shutdown,
		getMetrics,
	};
}
