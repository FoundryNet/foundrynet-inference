# FoundryNet Inference

x402-gated revenue engine: LLM proxy + data-enriched analysis + predictive (IoT) intelligence.
Standard x402 v2 on Solana mainnet USDC (self-settled, Base-ready). An `fnet_` Forge key bypasses.

| Route | Price | What |
|-------|-------|------|
| `POST /v1/chat` | $0.02 | Claude LLM proxy `{model, messages}` |
| `POST /v1/analyze` | $0.25 | Data-enriched analysis `{query}` — Claude plans → queries FoundryNet servers → synthesizes |
| `POST /v1/predict` | $0.10 | TimesFM breach forecast `{canonical_field, values, threshold, oem?}` + NL rec + MINT attest |
| `POST /v1/infer` | $0.10 | IoT telemetry `{telemetry:{field:value|series}, oem?}` → normalize + forecast + anomalies |

Discovery: `GET /x402`, `GET /x402/:route` (402 + PAYMENT-REQUIRED header), `GET /.well-known/x402`.

Note: `/v1/predict` and `/v1/infer` forecasts require ≥16 historical points (TimesFM constraint).

Env: `ANTHROPIC_API_KEY`, `FORGE_API_KEY` (fnet_), `FORGE_BASE_URL`, `HELIUS_API_KEY`,
`PAYMENT_RECIPIENT`, `PAYMENT_USDC_MINT`, `PUBLIC_URL`. Base-ready: set `X402_NETWORK` +
swap the facilitator in `lib/x402.js` for CDP/Base.
