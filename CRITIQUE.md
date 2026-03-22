# CRITIQUE — Observability in nopCommerce

## What the Design Helped

**`IEventPublisher` is the single best thing in nopCommerce for observability.**
Every significant business event — order placed, payment processed, status changed — flows through one method: `PublishAsync<TEvent>`. This is an unintentional but effective chokepoint. Decorating it with `ObservabilityEventPublisher` required one new file and one DI registration change, and immediately gave spans for the entire business event lifecycle without touching any service class.

The layered architecture also helped. Because `Nop.Services` sits cleanly below `Nop.Web`, it was possible to instrument `OrderProcessingService` in isolation. The dependency rules are enforced, so there are no surprise cross-layer calls that would have broken the trace context.

ASP.NET Core's built-in middleware pipeline was another asset. The standard `OpenTelemetry.Instrumentation.AspNetCore` package hooks in with two lines of configuration and provides HTTP-level spans, W3C `traceparent` propagation, and request/response attributes at no extra cost.

## What the Design Hindered

**The event system resolves consumers at runtime via `EngineContext.Current.ResolveAll<IConsumer<TEvent>>()`**, not through constructor injection. This means a decorator registered via Autofac's normal `Decorate<T>` mechanism does not intercept it — the decorator must be registered explicitly and the original `EventPublisher` must be replaced. The workaround works, but it is fragile: if a future nopCommerce upgrade changes the DI registration, the decorator silently stops wrapping.

**Payment data is embedded inline in `ProcessPaymentRequest`.** The object that flows through `PlaceOrderAsync` carries raw `CreditCard*` properties. Instrumenting the payment step without a scrubbing layer would leak card data into traces. This forced the addition of a `PiiScrubProcessor` (a `BaseProcessor<Activity>`) at the OTel SDK level, which strips known sensitive attributes before they reach the OTLP exporter. The need for this layer is an architectural smell: sensitive data should not travel in the same object as operational data.

**There is no existing `DiagnosticSource` or `ActivitySource` anywhere in the codebase.** Every span had to be created from scratch. In a greenfield system this would be normal; in a mature e-commerce platform it reflects observability being treated as an afterthought rather than a first-class concern.

The multi-step validation inside `PreparePlaceOrderDetailsAsync` runs six private methods sequentially with no shared interception point. This made it impossible to get per-step spans without modifying the method itself, which was judged too invasive for the risk involved.

## What Architectural Changes Would Improve Observability

| Change | Cost | Benefit |
|---|---|---|
| Move `EventPublisher` to constructor-injected consumers | High — touches Autofac registration across the codebase | Enables standard decorator patterns; makes the current workaround unnecessary |
| Separate `ProcessPaymentRequest` into a sanitised DTO and a private payment detail object | Medium — changes method signatures across the payment flow | PII would never be present in the instrumented path; scrubbing at the SDK layer becomes unnecessary |
| Add `DiagnosticSource` instrumentation inside LINQ2DB | Low-Medium — one interceptor class | Database spans automatically included in traces; currently DB calls are invisible unless explicitly wrapped |
| Publish a structured `OrderValidationEvent` from `PreparePlaceOrderDetailsAsync` | Low — one new event, one publisher call | Gives visibility into validation failures without needing to open private methods |

The highest-value change with the lowest risk is the LINQ2DB interceptor. It would surface slow queries during high-load checkout scenarios directly in the trace, enabling the Grafana dashboard to answer "is the bottleneck in the application or the database?" — which is exactly the question the metrics cannot answer alone.

## Where Surgical Changes Were Made and Why

Three files were added or modified in `Nop.Services`:

- **`NopActivitySource.cs`** — defines the shared `ActivitySource` and two metrics (`order_placement_duration_milliseconds` histogram and `order_payment_failures_total` counter). Kept in `Nop.Services` so both the decorator and the order processing service can reference it without creating a new layer.

- **`ObservabilityEventPublisher.cs`** — wraps `IEventPublisher`. The only change to the DI registration is replacing `EventPublisher` with this decorator. No service class was modified.

- **`PiiScrubProcessor.cs`** — lives in `Nop.Web.Framework` where the OTel SDK is configured. Strips PII attributes (`CardNumber`, `Email`, `Address1`, etc.) from every span before export. Centralising the scrubbing here means individual instrumentation points do not need to remember which fields are sensitive.

One targeted change was made to `OrderProcessingService.PlaceOrderAsync`: two `ActivitySource.StartActivity()` calls were added — one wrapping the full order placement and one wrapping the payment step. These were the only lines added to an existing service class. The span is started with `ActivityKind.Internal` and carries only safe attributes (`order.guid`, `order.store_id`). The impact on the existing code path is a nullable activity object that is a no-op when tracing is disabled.

The guiding principle throughout was: **instrument at infrastructure boundaries, not inside business logic.** The decorator, the OTel middleware, and the SDK processor are all boundary-level additions. The two `StartActivity` calls in `OrderProcessingService` are the only exception, and they were added because that method is the critical path for the entire flow — the operational benefit of seeing it in a trace outweighed the cost of the single-line change.
