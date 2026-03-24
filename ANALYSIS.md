# Architecture Analysis — nopCommerce Observability Reading

---

## 1. Layer Organisation and Dependency Rules

nopCommerce follows a strict layered architecture with five core projects:

```
Nop.Web  (Presentation)
    └── Nop.Web.Framework  (Presentation Infrastructure)
            └── Nop.Services  (Business Logic)
                    └── Nop.Data  (Data Access)
                            └── Nop.Core  (Domain + Interfaces)
```

| Project | Role | Can Reference |
|---|---|---|
| `Nop.Core` | Domain entities, interfaces, events | Nothing internal |
| `Nop.Data` | Database access via LINQ2DB | Nop.Core |
| `Nop.Services` | Business logic and application services | Nop.Core, Nop.Data |
| `Nop.Web.Framework` | Middleware, filters, model factories | All above |
| `Nop.Web` | MVC controllers and views | All above |
| `Plugins/*` | Optional extensions | Nop.Core, Nop.Data, Nop.Services |

**Key rules:**
- `Nop.Core` has zero internal dependencies — it is the stable foundation.
- Higher layers reference lower layers only; no circular dependencies.
- Plugins can reach down to `Nop.Services` but not into `Nop.Web`.
- All database access goes through `Nop.Data`; services never call raw SQL directly.

---

## 2. How nopCommerce Handles Events Internally — IEventPublisher

### The Interface

```csharp
// Nop.Core/Events/IEventPublisher.cs
public partial interface IEventPublisher
{
    Task PublishAsync<TEvent>(TEvent @event);
}
```

A single generic method. Every business event in the system flows through it.

### The Implementation

```csharp
// Nop.Services/Events/EventPublisher.cs
public class EventPublisher : IEventPublisher
{
    public async Task PublishAsync<TEvent>(TEvent @event)
    {
        var consumers = EngineContext.Current.ResolveAll<IConsumer<TEvent>>();
        foreach (var consumer in consumers)
        {
            await consumer.HandleEventAsync(@event);
            if (@event is IStopProcessingEvent { StopProcessing: true })
                break;
        }
    }
}
```

It resolves all `IConsumer<TEvent>` implementations via Autofac at runtime and calls them in sequence. Processing can be halted early via `IStopProcessingEvent`.

### Key Publish Points in the Order Flow

| Event | Location | Line (approx.) |
|---|---|---|
| `OrderPlacedEvent` | `OrderProcessingService.PlaceOrderAsync` | ~1617 |
| `ShoppingCartItemMovedToOrderItemEvent` | `MoveShoppingCartItemsToOrderItemsAsync` | ~1336 |
| `OrderStatusChangedEvent` | `SetOrderStatusAsync` | ~1027 |
| `OrderPaidEvent` | `ProcessOrderPaidAsync` | ~1114 |
| `OrderAuthorizedEvent` | `ProcessNextRecurringPaymentAsync` | ~2430 |

### Consumer Examples

- `OrderCacheEventConsumer` — invalidates cached order data on any order change
- `AppStartedConsumer` — runs migrations and initialises the task scheduler at boot
- Model factory cache consumers throughout `Nop.Services` — cache invalidation patterns

### What This Means for Observability

`IEventPublisher` is a natural instrumentation boundary. Every significant business event passes through a single method. Wrapping or decorating `EventPublisher.PublishAsync` captures the complete business event log without touching individual services. It is the highest-leverage single point in the system.

---

## 3. Where the Code Makes Observability Easy vs. Hard

### Easy

| Opportunity | Why |
|---|---|
| `EventPublisher.PublishAsync` | Single chokepoint for all domain events; instrument once, capture everywhere |
| ASP.NET Core middleware pipeline (`ApplicationBuilderExtensions.cs`) | Standard hook points for HTTP-level tracing; `ActivitySource` slots in naturally |
| `ILogger<T>` injection in all services | Structured logging already in place; correlation IDs can be threaded through |
| `OrderProcessingService.PlaceOrderAsync` | Entire order lifecycle in one method with clear sequential steps |
| LINQ2DB database layer | Can be wrapped or intercepted at the connection/command level |

### Hard

| Obstacle | Why |
|---|---|
| No `ActivitySource` or `DiagnosticSource` anywhere | Zero existing OTel scaffolding; every span must be created from scratch |
| Direct service-to-service method calls | No middleware or decorator between service invocations; no automatic context propagation |
| `EngineContext.Current.ResolveAll<T>()` in EventPublisher | Runtime DI resolution bypasses the normal constructor injection chain, making decorator patterns harder to apply |
| `ProcessPaymentRequest` passes raw card data inline | Payment instrumentation must scrub credit card fields before any attribute is recorded |
| Notification emails fire during order placement | Async side effects (queued emails) are not awaitable in the tracing sense — their outcome is detached from the parent span |
| Multi-step validation in `PreparePlaceOrderDetailsAsync` | Six private preparation methods called sequentially with no shared interception point |

### Structural Change Assessment

The most impactful change would be **replacing the `EngineContext.Current.ResolveAll` call in `EventPublisher`** with a constructor-injected `IEnumerable<IConsumer<TEvent>>` — but this is non-trivial in nopCommerce's Autofac setup because generic consumer resolution is done at runtime.

A cheaper alternative: **decorate `IEventPublisher`** with an `ObservabilityEventPublisher` that wraps `PublishAsync` with a span, then delegates. This requires one registration change and zero modifications to service code. That trade-off is clearly worth making.

---

## 4. Order Placement Flow — End-to-End

```
Browser POST /checkout/confirm
    │
    ▼
CheckoutController.ConfirmOrder()          [Nop.Web]
    │  validate cart is not empty
    │  validate minimum order interval
    │  build ProcessPaymentRequest
    │
    ▼
OrderProcessingService.PlaceOrderAsync()   [Nop.Services]
    │
    ├─► PreparePlaceOrderDetailsAsync()
    │       ├─ ValidateCustomer (guest/registered check)
    │       ├─ ValidateShoppingCart (quantities, availability)
    │       ├─ ValidateBillingAddress
    │       ├─ ValidateShippingInfo (method selected, address cloned)
    │       └─ CalculateTotals (subtotal → shipping → tax → discounts → order total)
    │
    ├─► GetProcessPaymentResultAsync()
    │       └─ IPaymentService.ProcessPaymentAsync()  [payment plugin]
    │
    ├─► SaveOrderDetailsAsync()
    │       ├─ Create Order entity
    │       ├─ Encrypt card data (AES)
    │       ├─ Insert billing address
    │       ├─ Insert shipping address
    │       └─ IOrderService.InsertOrderAsync()  → DB
    │
    ├─► MoveShoppingCartItemsToOrderItemsAsync()
    │       ├─ Convert ShoppingCartItems → OrderItems
    │       ├─ Update product inventory
    │       └─ PublishAsync(ShoppingCartItemMovedToOrderItemEvent)
    │
    ├─► SaveDiscountUsageHistoryAsync()
    ├─► SaveGiftCardUsageHistoryAsync()
    ├─► CreateFirstRecurringPaymentAsync()
    │
    ├─► SendNotificationsAndSaveNotesAsync()
    │       ├─ Queue email to store owner
    │       ├─ Queue email to customer
    │       └─ Queue emails to vendors/affiliates
    │
    ├─► _customerService.ResetCheckoutDataAsync()
    ├─► _customerActivityService.InsertActivityAsync()
    │
    └─► PublishAsync(OrderPlacedEvent)         ← instrumentation boundary
            │
            ▼
        CheckOrderStatusAsync()
            └─ PublishAsync(OrderPaidEvent) if payment captured
```

**Services involved:**

| Service | Responsibility |
|---|---|
| `IOrderProcessingService` | Orchestrates the entire order lifecycle |
| `IShoppingCartService` | Validates cart items before order creation |
| `IPaymentService` | Delegates to the payment plugin |
| `IOrderService` | CRUD for Order entities in DB |
| `IOrderTotalCalculationService` | Computes subtotals, tax, shipping, discounts |
| `IWorkflowMessageService` | Queues transactional emails |

---

## 5. Sensitive Data — What Must Not Appear in Traces

### The Order Entity Fields to Exclude

| Property | Reason |
|---|---|
| `Order.CardNumber` | Raw card data (stored encrypted) |
| `Order.CardCvv2` | Card security code |
| `Order.CardName` | Cardholder name |
| `Order.CardExpirationMonth/Year` | Card expiry |
| `Order.MaskedCreditCardNumber` | Even masked versions reveal payment method |
| `Order.AuthorizationTransactionCode` | Payment gateway token |
| `Order.CustomerIp` | PII under GDPR |

### Address Fields to Exclude

`Email`, `FirstName`, `LastName`, `PhoneNumber`, `Address1`, `Address2`, `City`, `ZipPostalCode`

### ProcessPaymentRequest Fields to Exclude

All `CreditCard*` properties.

### Safe to Include in Spans

`Order.Id`, `Order.OrderGuid`, `Order.CustomerId`, `Order.OrderStatus`, `Order.PaymentStatus`, `Order.ShippingStatus`, `Order.OrderTotal`, `Order.StoreId`

### Recommended Approach

Add an OTel processor (`OTel.Processor` or a custom `BaseProcessor<Activity>`) at the SDK level that strips or hashes PII attributes before export. This is cleaner than trying to remember which fields to exclude at every instrumentation point. The processor sits between the SDK and the exporter and sanitises spans centrally.

---

## 6. What Would Need to Change Structurally — and Is It Worth It?

| Change | Cost | Benefit | Verdict |
|---|---|---|---|
| Decorate `IEventPublisher` with `ObservabilityEventPublisher` | Low — one file, one DI registration | Captures all business events as spans automatically | **Do it** |
| Add ASP.NET Core `ActivitySource` middleware | Low — standard OTel ASP.NET package | HTTP-level spans, trace IDs propagated via W3C headers | **Do it** |
| Add LINQ2DB instrumentation | Medium — requires EF/LINQ2DB OTel package or custom interceptor | DB spans inside order placement trace | **Do it for the selected flow** |
| Replace `EngineContext.Current.ResolveAll` with constructor injection | High — touches DI registration across the whole codebase | Cleaner but no direct observability gain | **Not worth it for this assignment** |
| Add AOP/decorator for every IService method | Very high — 50+ service interfaces | Full method-level tracing | **Not worth it — too invasive, too noisy** |

The minimum viable structural addition is: one OTel SDK registration in `Program.cs`/startup, one `IEventPublisher` decorator, and one PII-scrubbing processor. Everything else can be done with targeted `ActivitySource.StartActivity()` calls at the entry point (controller) and the payment step.
