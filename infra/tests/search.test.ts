import { describe, expect, test } from "bun:test";
import type * as aisearch from "@distilled.cloud/cloudflare/aisearch";
import {
  SEARCH_INSTANCE,
  SEARCH_NAMESPACE,
  SEARCH_SETTINGS,
  drifted,
  notBuiltIn,
} from "../src/search.ts";

/** An instance as Cloudflare reads it back: built-in storage, set as the stack says. */
const observed = (
  overrides: Partial<aisearch.ReadNamespaceInstanceResponse> = {},
): aisearch.ReadNamespaceInstanceResponse => ({
  id: SEARCH_INSTANCE,
  createdAt: "2026-11-27T00:00:00Z",
  modifiedAt: "2026-11-27T00:00:00Z",
  type: null,
  source: null,
  ...SEARCH_SETTINGS,
  // Cloudflare answers more than it is told, and nulls for what it holds no value of.
  indexingOptions: { ...SEARCH_SETTINGS.indexingOptions },
  publicEndpointParams: { enabled: false, authorizedHosts: [] },
  aiGatewayId: null,
  embeddingModel: "@cf/qwen/qwen3-embedding-0.6b",
  ...overrides,
});

describe("the site's search index", () => {
  test("is the site's own, by name", () => {
    expect(SEARCH_NAMESPACE).toBe("allthings");
    expect(SEARCH_INSTANCE).toBe("pages");
  });

  test("is set to bill nothing beyond what is indexed and searched", () => {
    expect(SEARCH_SETTINGS).toMatchObject({
      // No public REST, MCP or snippet search beside the Worker's.
      publicEndpointParams: { enabled: false },
      // No OCR (billed as images); the tokens indexed are each counted once.
      indexingOptions: { useOcr: false },
      chunkOverlap: 0,
      // Nothing generated: no rewriting, no reranking.
      rewriteQuery: false,
      reranking: false,
    });
    // It never names a data source: built-in storage alone.
    expect(Object.keys(SEARCH_SETTINGS)).not.toContain("type");
    expect(Object.keys(SEARCH_SETTINGS)).not.toContain("source");
    expect(Object.keys(SEARCH_SETTINGS)).not.toContain("syncInterval");
  });

  test("hasn't drifted when Cloudflare holds every setting, whatever else it holds", () => {
    expect(drifted(observed(), SEARCH_SETTINGS)).toEqual([]);
  });

  test("has drifted in each setting Cloudflare holds otherwise, or doesn't hold", () => {
    expect(
      drifted(
        observed({
          chunkOverlap: 10,
          publicEndpointParams: { enabled: true },
          indexingOptions: { keywordTokenizer: "trigram", useOcr: false },
          cache: null,
        }),
        SEARCH_SETTINGS,
      ),
    ).toEqual([
      "indexingOptions",
      "chunkOverlap",
      "cache",
      "publicEndpointParams",
    ]);
  });

  test("takes a switch or a setting Cloudflare holds no value of as off", () => {
    expect(
      drifted(
        observed({
          publicEndpointParams: null,
          rewriteQuery: null,
          reranking: null,
          indexingOptions: { keywordTokenizer: "porter" },
        }),
        SEARCH_SETTINGS,
      ),
    ).toEqual([]);
    // What is on, or named, must be held as it is.
    expect(
      drifted(
        observed({ indexMethod: null, chunkSize: null }),
        SEARCH_SETTINGS,
      ),
    ).toEqual(["indexMethod", "chunkSize"]);
  });

  test("refuses an instance with a data source, which would index on Cloudflare's schedule", () => {
    expect(notBuiltIn(observed())).toBeUndefined();
    expect(notBuiltIn(observed({ source: "" }))).toBeUndefined();
    expect(
      notBuiltIn(
        observed({ type: "web-crawler", source: "https://allthings.dev" }),
      ),
    ).toContain(
      '"pages" has a data source (web-crawler: https://allthings.dev)',
    );
    expect(
      notBuiltIn(observed({ type: "r2", source: "bucket" })),
    ).toBeDefined();
  });
});
