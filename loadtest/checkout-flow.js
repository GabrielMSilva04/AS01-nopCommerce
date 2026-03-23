/**
 * k6 Load Test — nopCommerce Checkout Flow
 *
 * Simulates the complete guest checkout journey:
 *   1. Browse product catalog
 *   2. Add item to cart (+ accept required checkout attributes)
 *   3. Load billing address form
 *   4. Enter billing address
 *   5. Select shipping method
 *   6. Select payment method (Check/Money Order)
 *   7. Submit payment info
 *   8. Confirm order
 *
 * Notable nopCommerce-specific details:
 *   - All checkout POST actions use [FormValueRequired("nextstep")]; the field
 *     must be present or ASP.NET MVC falls through to the GET handler.
 *   - Required checkout attributes (e.g. "Gift wrapping") must be submitted via
 *     the cart form before the checkout session is considered valid.
 *   - Anti-forgery tokens are refreshed at each step.
 */

import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { parseHTML } from 'k6/html';
import { Rate, Trend, Counter } from 'k6/metrics';

// ────────────────────────────────────────────────────────────────────────────────
// Configuration
// ────────────────────────────────────────────────────────────────────────────────

const BASE_URL = __ENV.BASE_URL || 'http://localhost';
const SCENARIO  = __ENV.SCENARIO  || 'smoke'; // smoke | demo | load | stress

const checkoutDuration         = new Trend('checkout_flow_duration', true);
const checkoutSuccessRate      = new Rate('checkout_success_rate');
const addToCartFailures        = new Counter('add_to_cart_failures');
const orderConfirmationFailures = new Counter('order_confirmation_failures');

// ────────────────────────────────────────────────────────────────────────────────
// Scenarios
// ────────────────────────────────────────────────────────────────────────────────

const scenarios = {
    smoke: {
        executor: 'constant-vus',
        vus: 1,
        duration: '1m',
        gracefulStop: '10s',
    },
    load: {
        executor: 'ramping-vus',
        startVUs: 0,
        stages: [
            { duration: '2m', target: 10 },
            { duration: '10m', target: 10 },
            { duration: '2m', target: 0 },
        ],
        gracefulRampDown: '30s',
    },
    stress: {
        executor: 'ramping-vus',
        startVUs: 0,
        stages: [
            { duration: '2m', target: 20 },
            { duration: '5m', target: 20 },
            { duration: '2m', target: 50 },
            { duration: '5m', target: 50 },
            { duration: '2m', target: 0 },
        ],
        gracefulRampDown: '30s',
    },
    demo: {
        executor: 'constant-vus',
        vus: 3,
        duration: '2m',
        gracefulStop: '10s',
    },
};

const demoScenarios = {
    good_users: {
        executor: 'constant-vus',
        exec: 'default',
        vus: 3,
        duration: '2m',
        gracefulStop: '10s',
    },
    bad_users: {
        executor: 'constant-vus',
        exec: 'badCheckout',
        vus: 1,
        duration: '2m',
        gracefulStop: '10s',
    },
};

export const options = {
    scenarios: SCENARIO === 'demo'
        ? demoScenarios
        : { checkout_flow: scenarios[SCENARIO] },
    thresholds: {
        'http_req_duration':    ['p(95)<2000', 'p(99)<5000'],
        'http_req_failed':      ['rate<0.05'],
        'checkout_success_rate': ['rate>0.90'],
        'checks':               ['rate>0.95'],
    },
    userAgent: 'k6-load-test/1.0 (nopCommerce checkout flow)',
};

// ────────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────────

function getVerificationToken(response) {
    const doc   = parseHTML(response.body);
    const token = doc.find('input[name="__RequestVerificationToken"]').first().attr('value');
    if (!token) {
        console.error(`[Error] No anti-forgery token — status=${response.status} url=${response.url}`);
    }
    return token || null;
}

function thinkTime()  { sleep(Math.random() * 3 + 2); }
function shortPause() { sleep(Math.random() + 0.5); }

function extractProductId(response) {
    const urlMatch = response.url.match(/\/(\d+)$/);
    if (urlMatch) return urlMatch[1];

    const doc  = parseHTML(response.body);
    const btn  = doc.find('button[id^="add-to-cart-button-"]').first();
    if (btn) {
        const m = (btn.attr('id') || '').match(/add-to-cart-button-(\d+)/);
        if (m) return m[1];
    }
    return '19'; // HTC One Mini Blue fallback
}

// ────────────────────────────────────────────────────────────────────────────────
// Main flow
// ────────────────────────────────────────────────────────────────────────────────

export default function () {
    const startTime = Date.now();
    let token = null;
    let productId = null;
    let res;

    // ── Step 1: Browse ────────────────────────────────────────────────────────
    group('01_Browse_Products', function () {
        res = http.get(`${BASE_URL}/`, { tags: { name: 'Homepage' } });
        check(res, {
            'Homepage loaded': (r) => r.status === 200,
            'Homepage contains products': (r) => r.body.includes('product-item'),
        });
        thinkTime();

        res = http.get(`${BASE_URL}/cell-phones`, { tags: { name: 'Category Page' } });
        check(res, { 'Category page loaded': (r) => r.status === 200 });
        thinkTime();

        res = http.get(`${BASE_URL}/htc-one-mini-blue`, { tags: { name: 'Product Details' } });
        const ok = check(res, {
            'Product page loaded': (r) => r.status === 200,
            'Product has add-to-cart button': (r) => r.body.includes('add-to-cart-button'),
        });
        if (ok) {
            token     = getVerificationToken(res);
            productId = extractProductId(res);
        }
        thinkTime();
    });

    if (!token) { checkoutSuccessRate.add(false); return; }

    // ── Step 2: Add to cart + save checkout attributes ────────────────────────
    group('02_Add_To_Cart', function () {
        res = http.post(
            `${BASE_URL}/addproducttocart/details/${productId}/1`,
            {
                __RequestVerificationToken: token,
                [`addtocart_${productId}.EnteredQuantity`]: '1',
            },
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'X-Requested-With': 'XMLHttpRequest',
                },
                tags: { name: 'Add to Cart' },
            }
        );

        const addOk = check(res, {
            'Add to cart succeeded': (r) => r.status === 200 && r.body.includes('"success":true'),
        });
        if (!addOk) { addToCartFailures.add(1); checkoutSuccessRate.add(false); return; }

        shortPause();

        // Load cart page to get required checkout attribute options
        res = http.get(`${BASE_URL}/cart`, { tags: { name: 'View Cart' } });
        check(res, {
            'Cart page loaded':    (r) => r.status === 200,
            'Cart contains items': (r) => r.body.includes('order-summary-content'),
        });

        token = getVerificationToken(res) || token;

        // Build checkout attribute payload dynamically and submit with the
        // checkout button.  Required attributes (e.g. "Gift wrapping") must be
        // sent here; nopCommerce stores them as generic attributes on the customer
        // so they pass PlaceOrderAsync validation later.
        const cartPayload = {
            __RequestVerificationToken: token,
            checkout: 'checkout',
        };
        const cartDoc = parseHTML(res.body);
        const selects  = cartDoc.find('select[name^="checkout_attribute_"]');
        for (let ci = 0; ci < selects.size(); ci++) {
            const selEl   = selects.eq(ci);
            const name    = selEl.attr('name');
            const options = selEl.find('option');
            for (let oi = 0; oi < options.size(); oi++) {
                const v = options.eq(oi).attr('value');
                if (v && v !== '') { cartPayload[name] = v; break; }
            }
        }

        thinkTime();

        // POST saves attributes server-side; redirect destination is ignored
        // (may go to /login/checkoutasguest for anonymous users)
        res = http.post(`${BASE_URL}/cart`, cartPayload, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            tags: { name: 'Cart Checkout Submit' },
            redirects: 0,
        });

        thinkTime();
    });

    // ── Step 3: Load billing address form ─────────────────────────────────────
    group('03_Start_Checkout', function () {
        // Go directly to the billing address page instead of /checkout, which
        // has stricter cart-attribute validation and can redirect to /cart.
        res = http.get(`${BASE_URL}/checkout/billingaddress`, {
            tags: { name: 'Billing Address Page' },
        });
        const ok = check(res, {
            'Billing address page loaded': (r) => r.status === 200,
            'On checkout (not cart)':      (r) => !r.url.includes('/cart'),
        });
        if (ok) {
            token = getVerificationToken(res);
        } else {
            checkoutSuccessRate.add(false);
        }
        thinkTime();
    });

    if (!token) { checkoutSuccessRate.add(false); return; }

    // ── Step 4: Submit billing address ────────────────────────────────────────
    group('04_Enter_Billing_Address', function () {
        res = http.post(
            `${BASE_URL}/checkout/billingaddress`,
            {
                __RequestVerificationToken: token,
                nextstep: 'nextstep',          // [FormValueRequired("nextstep")]
                'BillingNewAddress.FirstName':      'Load',
                'BillingNewAddress.LastName':       'Test',
                'BillingNewAddress.Email':          `loadtest${Date.now()}@example.com`,
                'BillingNewAddress.CountryId':      '237', // United States of America
                'BillingNewAddress.StateProvinceId': '1797', // California
                'BillingNewAddress.City':           'San Francisco',
                'BillingNewAddress.Address1':       '123 Test Street',
                'BillingNewAddress.ZipPostalCode':  '94102',
                'BillingNewAddress.PhoneNumber':    '555-0100',
                ShipToSameAddress: 'true',
            },
            {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                tags: { name: 'Submit Billing Address' },
                redirects: 0,
            }
        );

        const ok = check(res, {
            'Billing address accepted': (r) => r.status === 302,
        });
        if (!ok) { checkoutSuccessRate.add(false); return; }

        const redirectUrl = res.headers['Location'] || res.headers['location'];
        res   = http.get(`${BASE_URL}${redirectUrl}`, { tags: { name: 'Shipping Method Page' } });
        token = getVerificationToken(res);
        thinkTime();
    });

    // ── Step 5: Select shipping method ────────────────────────────────────────
    group('05_Select_Shipping_Method', function () {
        res = http.post(
            `${BASE_URL}/checkout/shippingmethod`,
            {
                __RequestVerificationToken: token,
                nextstep: 'nextstep',
                shippingoption: 'Ground___Shipping.FixedByWeightByTotal',
            },
            {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                tags: { name: 'Select Shipping Method' },
                redirects: 0,
            }
        );

const ok = check(res, {
            'Shipping method accepted': (r) => r.status === 302,
        });
        if (!ok) { checkoutSuccessRate.add(false); return; }

        const redirectUrl = res.headers['Location'] || res.headers['location'];
        res   = http.get(`${BASE_URL}${redirectUrl}`, { tags: { name: 'Payment Method Page' } });
        token = getVerificationToken(res);
        thinkTime();
    });

    // ── Step 6: Select payment method (Check/Money Order) ─────────────────────
    group('06_Select_Payment_Method', function () {
        res = http.post(
            `${BASE_URL}/checkout/paymentmethod`,
            {
                __RequestVerificationToken: token,
                nextstep: 'nextstep',
                paymentmethod: 'Payments.CheckMoneyOrder',
            },
            {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                tags: { name: 'Select Payment Method' },
                redirects: 0,
            }
        );

        const ok = check(res, {
            'Payment method accepted': (r) => r.status === 302,
        });
        if (!ok) { checkoutSuccessRate.add(false); return; }

        const redirectUrl = res.headers['Location'] || res.headers['location'];
        res   = http.get(`${BASE_URL}${redirectUrl}`, { tags: { name: 'Payment Info Page' } });
        token = getVerificationToken(res);
        thinkTime();
    });

    // ── Step 7: Submit payment info ───────────────────────────────────────────
    group('07_Submit_Payment_Info', function () {
        res = http.post(
            `${BASE_URL}/checkout/paymentinfo`,
            { __RequestVerificationToken: token, nextstep: 'nextstep' },
            {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                tags: { name: 'Submit Payment Info' },
                redirects: 0,
            }
        );

        const ok = check(res, {
            'Payment info accepted': (r) => r.status === 302,
        });
        if (!ok) { checkoutSuccessRate.add(false); return; }

        const redirectUrl = res.headers['Location'] || res.headers['location'];
        res   = http.get(`${BASE_URL}${redirectUrl}`, { tags: { name: 'Confirm Order Page' } });
        token = getVerificationToken(res) || token;
        shortPause();
    });

    // ── Step 8: Confirm order ─────────────────────────────────────────────────
    group('08_Confirm_Order', function () {
        res = http.post(
            `${BASE_URL}/checkout/confirm`,
            { __RequestVerificationToken: token },
            {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                tags: { name: 'Confirm Order' },
                redirects: 0,
            }
        );

        const orderSuccess = check(res, {
            'Order confirmed':         (r) => r.status === 302,
            'Redirected to completion': (r) =>
                (r.headers['Location'] || r.headers['location'] || '').includes('checkout/completed'),
        });

        if (orderSuccess) {
            checkoutSuccessRate.add(true);
            const redirectUrl = res.headers['Location'] || res.headers['location'];
            res = http.get(`${BASE_URL}${redirectUrl}`, { tags: { name: 'Order Completed' } });
            check(res, {
                'Completion page loaded': (r) => r.status === 200,
                'Order confirmation shown': (r) =>
                    r.body.includes('order number') || r.body.includes('order has been') ||
                    r.body.includes('completed'),
            });
        } else {
            orderConfirmationFailures.add(1);
            checkoutSuccessRate.add(false);
        }
    });

    checkoutDuration.add(Date.now() - startTime);
}

// ────────────────────────────────────────────────────────────────────────────────
// Bad checkout — simulates expired-session / CSRF failure on confirm
//
// Completes the checkout flow up to the confirm page, then POSTs /checkout/confirm
// with a stale antiforgery token.  ASP.NET Core's antiforgery middleware rejects
// the request with HTTP 400, which is recorded by the ASP.NET Core OTel
// instrumentation and surfaces in the "Checkout HTTP Error Rate — 4xx vs 5xx"
// Grafana panel.  This mirrors a common production failure: a customer who leaves
// the confirm page open for too long and clicks "Place Order" after their session
// has expired.
// ────────────────────────────────────────────────────────────────────────────────

export function badCheckout() {
    let res, token;

    // Complete the full checkout flow so the session is in a valid confirm state
    http.get(`${BASE_URL}/cell-phones`, { tags: { name: 'Category (bad)' } });

    res = http.get(`${BASE_URL}/nokia-lumia-1020`, { tags: { name: 'Product (bad)' } });
    token = getVerificationToken(res);
    shortPause();

    http.post(`${BASE_URL}/addproducttocart/catalog/36/1/1`,
        `__RequestVerificationToken=${token}`,
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' }, tags: { name: 'Add to Cart (bad)' } }
    );

    res = http.get(`${BASE_URL}/cart`, { tags: { name: 'Cart (bad)' } });
    token = getVerificationToken(res) || token;
    const cartPayload = { __RequestVerificationToken: token, checkout: 'checkout' };
    http.post(`${BASE_URL}/cart`, cartPayload, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, redirects: 0, tags: { name: 'Cart Submit (bad)' } });
    thinkTime();

    res = http.get(`${BASE_URL}/checkout/billingaddress`, { tags: { name: 'Billing (bad)' } });
    token = getVerificationToken(res);

    res = http.post(`${BASE_URL}/checkout/billingaddress`, {
        __RequestVerificationToken: token, nextstep: 'nextstep',
        'BillingNewAddress.FirstName': 'Expired', 'BillingNewAddress.LastName': 'Session',
        'BillingNewAddress.Email': `expired${Date.now()}@example.com`,
        'BillingNewAddress.CountryId': '237', 'BillingNewAddress.StateProvinceId': '1797',
        'BillingNewAddress.City': 'San Francisco', 'BillingNewAddress.Address1': '1 Timeout St',
        'BillingNewAddress.ZipPostalCode': '94102', 'BillingNewAddress.PhoneNumber': '555-0000',
        ShipToSameAddress: 'true',
    }, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, redirects: 0, tags: { name: 'Billing Submit (bad)' } });

    const shipRedirect = res.headers['Location'] || res.headers['location'];
    res = http.get(`${BASE_URL}${shipRedirect}`, { tags: { name: 'Shipping (bad)' } });
    token = getVerificationToken(res);

    res = http.post(`${BASE_URL}/checkout/shippingmethod`, {
        __RequestVerificationToken: token, nextstep: 'nextstep',
        shippingoption: 'Ground___Shipping.FixedByWeightByTotal',
    }, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, redirects: 0, tags: { name: 'Shipping Method (bad)' } });

    const pmRedirect = res.headers['Location'] || res.headers['location'];
    res = http.get(`${BASE_URL}${pmRedirect}`, { tags: { name: 'Payment Method (bad)' } });
    token = getVerificationToken(res);

    res = http.post(`${BASE_URL}/checkout/paymentmethod`, {
        __RequestVerificationToken: token, nextstep: 'nextstep',
        paymentmethod: 'Payments.CheckMoneyOrder',
    }, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, redirects: 0, tags: { name: 'Payment Method Submit (bad)' } });

    const piRedirect = res.headers['Location'] || res.headers['location'];
    res = http.get(`${BASE_URL}${piRedirect}`, { tags: { name: 'Payment Info (bad)' } });
    token = getVerificationToken(res);
    thinkTime();

    res = http.post(`${BASE_URL}/checkout/paymentinfo`, {
        __RequestVerificationToken: token, nextstep: 'nextstep',
    }, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, redirects: 0, tags: { name: 'Payment Info Submit (bad)' } });

    const toConfirm = res.headers['Location'] || res.headers['location'];
    if (toConfirm) {
        http.get(`${BASE_URL}${toConfirm}`, { tags: { name: 'Confirm Page (bad)' } });
    }
    thinkTime();

    // POST /checkout/confirm with a deliberately stale token — simulates the user
    // leaving the confirm page open until their session expires, then clicking
    // "Place Order".  ASP.NET Core antiforgery returns 400.
    const staleToken = 'stale_' + Math.random().toString(36).slice(2);
    res = http.post(`${BASE_URL}/checkout/confirm`, {
        __RequestVerificationToken: staleToken, nextstep: 'nextstep',
    }, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, tags: { name: 'Confirm (stale token)' } });

    check(res, { 'confirm rejected (400)': (r) => r.status === 400 });
    checkoutSuccessRate.add(false);
    thinkTime();
}

// ────────────────────────────────────────────────────────────────────────────────
// Setup / Teardown
// ────────────────────────────────────────────────────────────────────────────────

export function setup() {
    console.log(`Starting k6 load test: ${SCENARIO} scenario`);
    console.log(`Target: ${BASE_URL}`);
    const res = http.get(BASE_URL);
    if (res.status !== 200) {
        throw new Error(`Application not reachable at ${BASE_URL} (status: ${res.status})`);
    }
}

export function teardown() {
    console.log('Load test completed');
    console.log(`Grafana traces: http://localhost:3000 (Tempo datasource)`);
    console.log(`Grafana metrics: http://localhost:3000 (Prometheus datasource)`);
}
