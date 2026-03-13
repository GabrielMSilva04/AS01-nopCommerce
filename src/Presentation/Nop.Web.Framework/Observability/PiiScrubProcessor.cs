using System.Diagnostics;
using OpenTelemetry;

namespace Nop.Web.Framework.Observability;

/// <summary>
/// OpenTelemetry processor that removes PII-adjacent span attributes before export.
///
/// Architectural decision: scrubbing at the SDK processor level is cleaner than trying to
/// remember which fields to exclude at every individual instrumentation point. If a future
/// developer adds a span with a sensitive attribute, this processor removes it regardless
/// of where in the codebase it was added. The alternative — per-site exclusion — creates
/// scattered responsibility and is easy to miss during code review.
///
/// This processor runs on every span end, before the OTLP exporter sends data to Jaeger/Tempo.
/// The list of keys matches the PII fields identified in the nopCommerce domain model
/// (Order, Address, Customer, ProcessPaymentRequest).
/// </summary>
public class PiiScrubProcessor : BaseProcessor<Activity>
{
    // Keys that must never leave this process in telemetry.
    // Lowercase because OTel attribute names are conventionally lowercase dot-separated.
    private static readonly HashSet<string> _sensitiveKeys = new(StringComparer.OrdinalIgnoreCase)
    {
        // Payment card data
        "payment.card_number",
        "payment.cvv",
        "payment.card_name",
        "payment.card_expiry",
        "order.card_number",
        "order.card_cvv2",
        "order.card_name",
        "order.card_expiration_month",
        "order.card_expiration_year",
        "order.masked_credit_card_number",
        "order.authorization_transaction_code",

        // Personal identity
        "customer.email",
        "customer.phone",
        "customer.first_name",
        "customer.last_name",
        "customer.date_of_birth",
        "customer.street_address",
        "customer.zip_postal_code",
        "address.email",
        "address.first_name",
        "address.last_name",
        "address.phone_number",
        "address.address1",
        "address.address2",

        // Network identity
        "order.customer_ip",
        "http.request.header.x-forwarded-for",
        "http.request.header.x-real-ip",
    };

    public override void OnEnd(Activity activity)
    {
        foreach (var key in _sensitiveKeys)
        {
            // SetTag with null removes the attribute from the span
            if (activity.GetTagItem(key) != null)
                activity.SetTag(key, null);
        }

        base.OnEnd(activity);
    }
}
