# Work Email Waterfall MCP Server

[![npm](https://img.shields.io/npm/v/@mambalabsdev/mcp-email-waterfall-orchestrator)](https://www.npmjs.com/package/@mambalabsdev/mcp-email-waterfall-orchestrator)
[![MCP](https://img.shields.io/badge/MCP-server-blue)](https://modelcontextprotocol.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

MCP server for the Mamba Labs [Work Email Waterfall](https://apify.com/mambalabs/email-waterfall-orchestrator) actor on Apify.

Give it contacts and your own provider API keys. It finds a work email for each, verifies it, and tells you exactly what each provider cost you.

## Tool

`find_work_email`

Returns one flat row per contact, misses included, plus a summary row carrying the run totals: the address found, which provider found it, its position in the chain, every provider attempted, the verification verdict and its source, and the provider units spent.

## Bring your own keys

This is the part that makes it different from a credit-based enrichment tool. Mamba Labs supplies no provider keys, never sees your credits, and never resells them. The run spends from your accounts at your negotiated rates, which is why `maxProviderUnits` exists and why you should set it.

The tradeoff is honest in both directions: you keep your own pricing and your own provider relationships, and you carry your own spend. What you get back is real attribution rather than a credit count, so you can see which provider actually earned its keep.

Give it `providerRates` and the run reports dollars at **your** rate. Leave it empty and it reports units only, because your plan tier is not knowable from here and guessing it would produce a confident wrong number.

## What happens to a bad key

Nothing dramatic. Every key is validated for free before any paid call. A provider with no usable key is dropped from the chain and reported, rather than failing the run or silently burning attempts. With no keys at all the run still completes, explains which capabilities were unavailable, and charges nothing.

## Verification is not an afterthought

Verification runs after **each** finder that returns an address, not once at the end, because providers do not agree on what "found" means. An address that one provider calls a hit and a verifier calls undeliverable is a miss, and you want to know that before it reaches a sequencer.

## `find_work_email`

| Input | Type | Notes |
|---|---|---|
| `contacts` | object[] | One object per person. Any of `full_name`, `first_name`, `last_name`, `company_domain`, `company_name`, `linkedin_url`, `email`. A single contact is an array of one. |
| `providerKeys` | object | Your own keys, by provider name. Validated for free before any paid call. |
| `providerOrder` | string[] | Registry entry ids in call order. Empty means the actor's default chain. |
| `verificationOrder` | string[] | Verifier entry ids in order. Empty means the actor's default. |
| `maxContacts` | integer | Hard ceiling on contacts processed. |
| `maxProviderUnits` | integer | Run-level cap on provider credits spent from your accounts. Strongly recommended. |
| `providerRates` | object | Map of provider or provider.endpoint to your cost per unit, so spend is reported in dollars. |
| `concurrencyHint` | integer | Advisory. Real pacing comes from each endpoint's own multi-window rate limits. |

More identifiers means a better chance of a hit. Keyed on a LinkedIn URL the top provider measured 13.7 percent against 9.3 percent on name plus domain, on the same 300 contacts in the same hour.

## Setup

```json
{
  "mcpServers": {
    "mamba-email-waterfall-orchestrator": {
      "command": "npx",
      "args": ["-y", "@mambalabsdev/mcp-email-waterfall-orchestrator"],
      "env": { "APIFY_TOKEN": "your-apify-token" }
    }
  }
}
```

Get a token at [console.apify.com/account/integrations](https://console.apify.com/account/integrations). Read-only. Consumes Apify credits per contact submitted and per address found, on top of whatever your own provider keys spend.

## Also available

This tool is also exposed by the [GTM Suite](https://www.npmjs.com/package/@mambalabsdev/mcp-gtm-suite) umbrella server, alongside the rest of the Mamba Labs GTM actors, if you would rather run one server than many.

Built by [Mamba Labs](https://apify.com/mambalabs).
