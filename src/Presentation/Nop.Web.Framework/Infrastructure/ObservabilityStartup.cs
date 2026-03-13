using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Nop.Core.Infrastructure;
using Nop.Services.Observability;
using Nop.Web.Framework.Observability;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

namespace Nop.Web.Framework.Infrastructure;

/// <summary>
/// Registers the OpenTelemetry SDK with tracing and metrics for the order placement flow.
///
/// Instrumentation decisions:
/// - AspNetCore instrumentation: automatically creates root spans for every HTTP request,
///   propagating W3C traceparent headers so distributed traces stitch together correctly.
/// - HttpClient instrumentation: captures outbound calls (e.g. to payment gateways) as
///   child spans within the order placement trace.
/// - NopActivitySource: our custom ActivitySource for order.placement and order.payment spans.
/// - PiiScrubProcessor: removes sensitive attributes from all spans before export.
///
/// Transport: OTLP over gRPC to a local collector (Jaeger or Tempo). The endpoint is
/// configurable via OTEL_EXPORTER_OTLP_ENDPOINT environment variable or appsettings.json
/// under "OpenTelemetry:OtlpEndpoint". Defaults to http://localhost:4317 (standard OTLP port).
///
/// Order: 50 — must run before NopStartup (2000) so the OTel SDK is ready when the
/// IEventPublisher decorator is resolved.
/// </summary>
public class ObservabilityStartup : INopStartup
{
    public void ConfigureServices(IServiceCollection services, IConfiguration configuration)
    {
        var otlpEndpoint = configuration["OpenTelemetry:OtlpEndpoint"] ?? "http://localhost:4317";
        var serviceName = configuration["OpenTelemetry:ServiceName"] ?? "nopcommerce";

        services.AddOpenTelemetry()
            .ConfigureResource(resource => resource
                .AddService(serviceName, serviceVersion: "5.00"))
            .WithTracing(tracing => tracing
                .AddSource(NopActivitySource.ActivitySourceName)
                .AddAspNetCoreInstrumentation(opts =>
                {
                    // Exclude health-check and keep-alive noise from traces
                    opts.Filter = ctx =>
                        !ctx.Request.Path.StartsWithSegments("/health") &&
                        !ctx.Request.Path.StartsWithSegments("/keepalive");
                })
                .AddHttpClientInstrumentation()
                .AddProcessor(new PiiScrubProcessor())
                .AddOtlpExporter(opts => opts.Endpoint = new Uri(otlpEndpoint)))
            .WithMetrics(metrics => metrics
                .AddMeter(NopActivitySource.MeterName)
                .AddAspNetCoreInstrumentation()
                .AddOtlpExporter(opts => opts.Endpoint = new Uri(otlpEndpoint)));
    }

    public void Configure(IApplicationBuilder application)
    {
        // No middleware additions needed — OTel hooks in at the SDK level
    }

    /// <summary>
    /// Must be lower than NopStartup.Order (2000) so OTel is ready before services resolve.
    /// </summary>
    public int Order => 50;
}
