import {
	NOOP_TELEMETRY_CONTEXT,
	type SpanOptions,
	type SpanStatus,
	type TelemetryContext,
	type TelemetryCounter,
	type TelemetryHistogram,
	type TelemetryMetrics,
	type TelemetryPropagation,
	type TelemetrySpan,
	type TelemetryUpDownCounter,
} from "@earendil-works/pi-telemetry";
import {
	type Context as OTelContext,
	type Link as OTelLink,
	type SpanStatus as OTelStatus,
	context as otelContext,
	trace as otelTrace,
	ROOT_CONTEXT,
	SpanStatusCode,
	type TracerProvider,
} from "@opentelemetry/api";
import { toOtelAttributes } from "./attributes.ts";

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
 * Create an OpenTelemetry-backed telemetry context. Exporter, sampling, and
 * resource configuration belong to the (optionally injected) providers, not
 * to this adapter. The global providers are used when none are injected, so
 * a host with an already-configured OpenTelemetry SDK needs no options.
 */
export function createOpenTelemetryTelemetry(options: OpenTelemetryTelemetryOptions = {}): OpenTelemetryTelemetry {
	const tracerProvider = options.tracerProvider ?? otelTrace.getTracerProvider();
	const tracer = tracerProvider.getTracer(
		options.tracerName ?? "@brainrot.xyz/pi-telemetry-opentelemetry",
		options.tracerVersion,
	);
	const contexts = new WeakMap<TelemetryContext, OTelContext>();
	let stopped = false;

	// TODO(Phase 3): back these factories with the meter provider.
	const unsupported = (kind: string): never => {
		throw new Error(`${kind} is not implemented yet (Phase 3: metrics)`);
	};
	const metrics: TelemetryMetrics = {
		counter: (): TelemetryCounter => unsupported("counter"),
		upDownCounter: (): TelemetryUpDownCounter => unsupported("upDownCounter"),
		histogram: (): TelemetryHistogram => unsupported("histogram"),
	};

	// TODO(Phase 2): back inject/extract with the propagator. Until then the
	// capability behaves like the no-op propagator with stable identity.
	const propagation: TelemetryPropagation = {
		inject: () => undefined,
		extract: () => root,
	};
	const root: TelemetryContext & { metrics: TelemetryMetrics; propagation: TelemetryPropagation } = {
		metrics,
		propagation,
		startSpan: (spanOptions, callback) =>
			stopped ? startInert(spanOptions, callback) : startFromParent(undefined, spanOptions, callback),
	};

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

	async function flush(): Promise<void> {
		const flushable = tracerProvider as { forceFlush?: () => unknown };
		await flushable.forceFlush?.();
	}

	async function shutdown(): Promise<void> {
		stopped = true;
		await flush();
	}

	return {
		...root,
		flush,
		shutdown,
	};
}
