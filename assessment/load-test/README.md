# Load Test — k6 Checkout Flow

Simulates the full checkout flow: browse → add to cart → billing → shipping → payment → confirm.

## Prerequisites

- [k6](https://k6.io/docs/get-started/installation/) installed
- Stack running: `docker compose up -d` from the repo root

## Run

```bash
# Smoke (1 VU, 1 min) — default
k6 run assessment/load-test/checkout-flow.js

# Load (ramp to 10 VUs, 14 min)
k6 run -e SCENARIO=load assessment/load-test/checkout-flow.js

# Stress (ramp to 50 VUs, 30 min)
k6 run -e SCENARIO=stress assessment/load-test/checkout-flow.js
```

Custom target URL:
```bash
k6 run -e BASE_URL=http://your-host assessment/load-test/checkout-flow.js
```

## Thresholds

| Metric                    | Threshold   |
| ------------------------- | ----------- |
| `http_req_duration` p(95) | < 2 000 ms  |
| `http_req_duration` p(99) | < 5 000 ms  |
| `http_req_failed`         | < 5%        |
| `checkout_success_rate`   | > 90%       |
| `checks`                  | > 95%       |
