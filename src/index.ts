#!/usr/bin/env node
/**
 * THIN APIFY API CLIENT. Nothing else belongs in this file.
 *
 * This wrapper carries exactly three things: the tool name, the input schema
 * that mirrors the actor's own public input schema, and the HTTP call to the
 * Apify API. It holds NO waterfall logic, NO chain order, NO parsing rules and
 * NO provider knowledge beyond the provider names the actor's public input
 * schema already exposes to every Store visitor.
 *
 * That logic lives in a private package vendored into the actor. This
 * repository is public. Nothing from it may be copied here in any form.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(here, "..", "package.json"), "utf8"),
) as { version: string; name: string };

// Distinctive UA so Apify run meta.userAgent marks MCP-originated runs.
const USER_AGENT = `mambalabs-mcp ${pkg.name}@${pkg.version}`;

const APIFY_TOKEN = process.env.APIFY_TOKEN;

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

// Drop undefined values so optional inputs are not sent to the actor.
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// Shared caller. actorPath is the actor's immutable Apify actor ID (a stable key
// that survives Store renames). The /v2/acts/{id} endpoint accepts it directly,
// so a Store rename never breaks these calls.
async function runActor(
  actorPath: string,
  actorLabel: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  if (!APIFY_TOKEN) {
    return { isError: true, content: [{ type: "text", text: "APIFY_TOKEN is not set. Create a token at https://console.apify.com/account/integrations and set it as the APIFY_TOKEN environment variable." }] };
  }

  const url = `https://api.apify.com/v2/acts/${actorPath}/run-sync-get-dataset-items?timeout=300`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${APIFY_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify(input),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not reach the Apify API: ${message}` }] };
  }

  if (!response.ok) {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body?.error?.message) detail = ` ${body.error.message}`;
    } catch {
      detail = "";
    }

    let message: string;
    switch (response.status) {
      case 401:
        message = "Invalid Apify token. Check your APIFY_TOKEN environment variable.";
        break;
      case 402:
        message =
          "Insufficient Apify credits. Check your account balance at https://console.apify.com/billing";
        break;
      case 408:
        message = `The ${actorLabel} run timed out after 300 seconds. Try a smaller batch, or run the actor on Apify directly for longer jobs.`;
        break;
      default:
        message = `Apify request to ${actorLabel} failed with status ${response.status}.${detail}`;
    }
    return { isError: true, content: [{ type: "text", text: message }] };
  }

  const items = await response.json();
  return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
}

const server = new McpServer({
  name: "mamba-email-waterfall-orchestrator",
  version: pkg.version,
});

const contactShape = z
  .object({
    full_name: z.string().optional(),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    company_domain: z.string().optional(),
    company_name: z.string().optional(),
    linkedin_url: z.string().optional(),
    email: z.string().optional(),
  })
  .passthrough();

// Work Email Waterfall (immutable actor ID OT6xqTFThC0Rjf7Zj)
server.registerTool(
  "find_work_email",
  {
    title: "Find Work Email",
    description:
      "Find a work email address for each contact by running a chain of finder providers on YOUR OWN provider API keys, verify each result, and return real per-provider spend attribution instead of an opaque credit count. This is bring your own key: Mamba Labs supplies no provider keys, never sees your credits, and the run spends from your accounts, so set maxProviderUnits. Supply contacts as an array of objects, each carrying any of full_name, first_name, last_name, company_domain, company_name, linkedin_url and email. More identifiers means a better chance of a hit. Supply your keys in providerKeys by provider name. Every key is validated for free before any paid call, and a provider with no usable key is dropped from the chain and reported rather than failing the run; with no keys at all the run still completes, explains what was unavailable and charges nothing. Verification runs after each finder that returns an address, not once at the end. Every contact gets a row including misses, so you can see what was attempted, and a final summary row carries the run totals and spend. Returns flat Clay-ready JSON. Requires an APIFY_TOKEN and consumes Apify credits per contact submitted and per address found, on top of whatever your own provider keys spend.",
    annotations: {
      title: "Find Work Email",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      contacts: z
        .array(contactShape)
        .describe("One object per person. Each may carry full_name, first_name, last_name, company_domain, company_name, linkedin_url and email. A single contact is an array of one."),
      providerKeys: z
        .record(z.string())
        .optional()
        .describe("YOUR own provider API keys, keyed by provider name. Validated for free before any paid call. A provider with no usable key is dropped and reported rather than failing the run."),
      providerOrder: z
        .array(z.string())
        .optional()
        .describe("Registry entry ids in the order you want them called. Leave empty for the actor's default order."),
      verificationOrder: z
        .array(z.string())
        .optional()
        .describe("Verifier entry ids in order. Leave empty for the actor's default order."),
      maxContacts: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Hard ceiling on how many contacts are processed. Leave empty for no ceiling."),
      maxProviderUnits: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Run-level cap on the provider credits this run may consume from YOUR accounts. When it is reached the remaining contacts are skipped with a reason rather than spent on. Strongly recommended."),
      providerRates: z
        .record(z.number())
        .optional()
        .describe("Optional map of provider or provider.endpoint to YOUR cost per unit, for example {\"findymail.search_name\": 0.0198}. Supply it and the run reports dollars at your rate; leave it empty and it reports units only, because your plan tier is not knowable from here."),
      concurrencyHint: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Advisory only. Real pacing comes from each endpoint's own documented rate limits, which are multi-window and per endpoint, so this cannot exceed them."),
    },
  },
  async ({ contacts, providerKeys, providerOrder, verificationOrder, maxContacts, maxProviderUnits, providerRates, concurrencyHint }) => {
    if (!Array.isArray(contacts) || contacts.length === 0) {
      return {
        isError: true,
        content: [{ type: "text", text: "Provide contacts: an array of one or more contact objects." }],
      };
    }
    return runActor(
      "OT6xqTFThC0Rjf7Zj",
      "Work Email Waterfall",
      compact({
        contacts,
        providerKeys,
        providerOrder,
        verificationOrder,
        maxContacts,
        maxProviderUnits,
        providerRates,
        concurrencyHint,
      }),
    );
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
