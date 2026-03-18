# CRITIQUE — Observability in nopCommerce

## What Helped

- **`IEventPublisher`** is a natural chokepoint — all business events pass through one method, making decoration trivial.
- **Layered architecture** enforces clean boundaries, so `OrderProcessingService` could be instrumented in isolation.
- **ASP.NET Core middleware** gave HTTP-level spans and trace propagation with minimal configuration.

## What Hindered

- **Runtime DI resolution** (`EngineContext.Current.ResolveAll`) breaks standard decorator patterns; the decorator had to replace the original binding explicitly.
- **`ProcessPaymentRequest` carries raw `CreditCard*` fields**, requiring a `PiiScrubProcessor` at the SDK level before export.
- **Zero existing `ActivitySource`** — every span was built from scratch.

## Approach

Three files added (`NopActivitySource`, `ObservabilityEventPublisher`, `PiiScrubProcessor`). Two `StartActivity()` calls added to `OrderProcessingService.PlaceOrderAsync` — the only existing code touched. All other instrumentation is at infrastructure boundaries (decorator, middleware, SDK processor), not inside business logic.
