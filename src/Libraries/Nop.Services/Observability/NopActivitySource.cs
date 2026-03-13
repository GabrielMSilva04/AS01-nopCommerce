using System.Diagnostics;
using System.Diagnostics.Metrics;

namespace Nop.Services.Observability;

/// <summary>
/// Central registry for the ActivitySource and Meter used across nopCommerce instrumentation.
/// All custom spans and metrics for the order placement flow are defined here so they can be
/// referenced by both the service layer (OrderProcessingService) and the event decorator
/// (ObservabilityEventPublisher) without any coupling between them.
/// </summary>
public static class NopActivitySource
{
    public const string ActivitySourceName = "Nop.Commerce";
    public const string MeterName = "Nop.Commerce.Orders";

    /// <summary>
    /// The ActivitySource used to create all custom spans.
    /// Must be registered with the OTel SDK's TracerProvider (see ObservabilityStartup).
    /// </summary>
    public static readonly ActivitySource Source = new(ActivitySourceName, "1.0.0");

    /// <summary>
    /// The Meter used to create all custom metrics.
    /// Must be registered with the OTel SDK's MeterProvider (see ObservabilityStartup).
    /// </summary>
    public static readonly Meter Meter = new(MeterName, "1.0.0");

    /// <summary>
    /// Measures the end-to-end duration of the order placement pipeline in milliseconds,
    /// from the moment payment processing begins to the moment the order is persisted and
    /// the OrderPlacedEvent is published.
    ///
    /// Operational value: a sustained rise in p95/p99 latency here signals checkout pipeline
    /// degradation (slow payment gateway, DB contention) before customers start seeing
    /// timeouts or abandoning carts. Tagged with success=true|false to separate slow
    /// successes from slow failures.
    /// </summary>
    public static readonly Histogram<double> OrderPlacementDuration =
        Meter.CreateHistogram<double>(
            "order.placement.duration",
            unit: "ms",
            description: "End-to-end duration of the order placement pipeline");

    /// <summary>
    /// Counts payment processing failures, tagged by the first error reason returned by
    /// the payment plugin.
    ///
    /// Operational value: distinguishes payment gateway unavailability (all errors the same
    /// transient message) from declined cards (varied, customer-specific messages). An on-call
    /// engineer can use this to decide whether to page the payment gateway team or treat it
    /// as normal card-decline noise. Sudden spikes indicate infrastructure issues, not user errors.
    /// </summary>
    public static readonly Counter<long> PaymentFailures =
        Meter.CreateCounter<long>(
            "order.payment.failures",
            unit: "failures",
            description: "Number of payment processing failures tagged by error reason");
}
