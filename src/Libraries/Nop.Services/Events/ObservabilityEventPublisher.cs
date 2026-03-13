using System.Diagnostics;
using Nop.Core.Events;
using Nop.Services.Observability;

namespace Nop.Services.Events;

/// <summary>
/// Decorator for IEventPublisher that creates an OpenTelemetry span for every domain event
/// published through the system.
///
/// Architectural decision: rather than adding ActivitySource calls into each individual service,
/// this decorator intercepts the single chokepoint that all business events pass through.
/// One file, one DI registration change — zero modifications to service code.
///
/// The span name follows the convention "event.{EventTypeName}" so traces group naturally
/// in Jaeger/Tempo (e.g. "event.OrderPlacedEvent", "event.OrderPaidEvent").
///
/// PII is excluded by design: only the event type name is recorded as a tag. No event
/// payload properties are serialised into spans. Sensitive data stays in the domain layer.
/// </summary>
public class ObservabilityEventPublisher : IEventPublisher
{
    private readonly IEventPublisher _inner;

    public ObservabilityEventPublisher(IEventPublisher inner)
    {
        _inner = inner;
    }

    public async Task PublishAsync<TEvent>(TEvent @event)
    {
        var eventName = typeof(TEvent).Name;

        using var activity = NopActivitySource.Source.StartActivity(
            $"event.{eventName}",
            ActivityKind.Internal);

        activity?.SetTag("event.type", eventName);

        await _inner.PublishAsync(@event);
    }
}
