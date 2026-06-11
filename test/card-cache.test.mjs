import assert from "node:assert/strict";
import { test } from "node:test";

import {
  clearRedisKeysByPatternFromClient,
  createCardCacheKey,
  createRedisCardDataCacheFromClient,
  defaultPoneglyphSimCardCacheVersions,
  fetchPoneglyphCardCatalogIds,
  fetchPoneglyphCardCatalogSnapshot,
  isCurrentCachedResolvedCard,
  summarizeCardCacheCoverage,
  warmCardCache,
} from "../dist/index.js";

const versions = {
  cardDataVersion: "live-poneglyph-dev-v1",
  effectDefinitionsVersion: "generated-dev-v13",
  overlayVersion: "none",
};

test("exports the shared current sim cache versions", () => {
  assert.deepEqual(defaultPoneglyphSimCardCacheVersions, versions);
});

const cachedCard = (cardId, status = "implemented-dsl") => ({
  cacheSchemaVersion: 1,
  versions,
  card: {
    cardId,
    support: { status },
  },
});

const memoryCache = () => {
  const values = new Map();
  return {
    values,
    async getJson(key) {
      return values.get(key);
    },
    async setJson(key, value) {
      values.set(key, value);
    },
  };
};

test("createCardCacheKey matches the sim card cache key shape", () => {
  assert.equal(
    createCardCacheKey({ cardId: "OP01-001", versions }),
    "card:live-poneglyph-dev-v1:generated-dev-v13:none:OP01-001",
  );
});

test("redis JSON cache parses stored values and writes TTL-backed JSON", async () => {
  const calls = [];
  const cache = createRedisCardDataCacheFromClient({
    async get(key) {
      assert.equal(key, "card:key");
      return JSON.stringify({ ok: true });
    },
    async set(key, value, options) {
      calls.push({ key, value, options });
    },
  });

  assert.deepEqual(await cache.getJson("card:key"), { ok: true });
  await cache.setJson("card:key", { ok: true }, { ttlSeconds: 42 });

  assert.deepEqual(calls, [
    {
      key: "card:key",
      value: JSON.stringify({ ok: true }),
      options: { EX: 42 },
    },
  ]);
});

test("isCurrentCachedResolvedCard rejects stale versions and wrong card ids", () => {
  assert.equal(
    isCurrentCachedResolvedCard(cachedCard("OP01-001"), {
      cardId: "OP01-001",
      versions,
    }),
    true,
  );
  assert.equal(
    isCurrentCachedResolvedCard(cachedCard("OP01-002"), {
      cardId: "OP01-001",
      versions,
    }),
    false,
  );
  assert.equal(
    isCurrentCachedResolvedCard(
      {
        ...cachedCard("OP01-001"),
        versions: { ...versions, overlayVersion: "next" },
      },
      { cardId: "OP01-001", versions },
    ),
    false,
  );
});

test("summarizeCardCacheCoverage reports cache and implementation coverage", async () => {
  const cache = memoryCache();
  await cache.setJson(
    createCardCacheKey({ cardId: "OP01-001", versions }),
    cachedCard("OP01-001", "implemented-dsl"),
  );
  await cache.setJson(
    createCardCacheKey({ cardId: "OP01-002", versions }),
    cachedCard("OP01-002", "vanilla-confirmed"),
  );
  await cache.setJson(
    createCardCacheKey({ cardId: "OP01-003", versions }),
    cachedCard("OP01-003", "unsupported"),
  );
  await cache.setJson(
    createCardCacheKey({ cardId: "OP01-004", versions }),
    { bad: true },
  );

  const coverage = await summarizeCardCacheCoverage({
    cardIds: ["OP01-001", "OP01-002", "OP01-003", "OP01-004", "OP01-005"],
    versions,
    cache,
  });

  assert.deepEqual(coverage, {
    cards: {
      total: 5,
      cached: 3,
      missing: 1,
      invalid: 1,
      coverage: 0.6,
    },
    implementation: {
      total: 5,
      implemented: 1,
      vanilla: 1,
      unsupported: 1,
      unknown: 2,
      coverage: 0.4,
    },
  });
});

test("warmCardCache resolves only missing cards and waits between batches", async () => {
  const cache = memoryCache();
  await cache.setJson(
    createCardCacheKey({ cardId: "OP01-001", versions }),
    cachedCard("OP01-001"),
  );
  const batches = [];
  const sleeps = [];
  const progress = [];

  const result = await warmCardCache({
    cardIds: ["OP01-001", "OP01-002", "OP01-003", "OP01-002"],
    versions,
    cache,
    batchSize: 1,
    delayMs: 25,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    onProgress: (entry) => {
      progress.push(entry);
    },
    resolveCards: async (cardIds) => {
      batches.push([...cardIds]);
      return cardIds.map((cardId) => ({
        card: { cardId, support: { status: "vanilla-confirmed" } },
      }));
    },
  });

  assert.deepEqual(batches, [["OP01-002"], ["OP01-003"]]);
  assert.deepEqual(sleeps, [25]);
  assert.equal(progress.length, 2);
  assert.equal(result.cached, 1);
  assert.equal(result.warmed, 2);
  assert.equal(result.failed, 0);
  assert.equal(result.coverage.cards.coverage, 1);
  assert.equal(result.coverage.implementation.coverage, 1);
});

test("warmCardCache records failed cards when resolver omits them", async () => {
  const cache = memoryCache();

  const result = await warmCardCache({
    cardIds: ["OP01-001", "OP01-002"],
    versions,
    cache,
    delayMs: 0,
    resolveCards: async () => [
      { card: { cardId: "OP01-001", support: { status: "unsupported" } } },
    ],
  });

  assert.equal(result.warmed, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.coverage.cards.cached, 1);
  assert.equal(result.coverage.implementation.unsupported, 1);
});

test("fetchPoneglyphCardCatalogIds follows pagination and deduplicates", async () => {
  const urls = [];
  const cardIds = await fetchPoneglyphCardCatalogIds({
    baseUrl: "https://api.example/",
    pageSize: 2,
    fetch: async (url) => {
      urls.push(String(url));
      const page = new URL(String(url)).searchParams.get("page");
      return new Response(
        JSON.stringify(
          page === "1"
            ? {
                data: [
                  { card_number: "OP01-001" },
                  { card_number: "OP01-002" },
                ],
                pagination: { has_more: true },
              }
            : {
                data: [
                  { card_number: "OP01-002" },
                  { card_number: "OP01-003" },
                ],
                pagination: { has_more: false },
              },
        ),
        { status: 200 },
      );
    },
  });

  assert.deepEqual(cardIds, ["OP01-001", "OP01-002", "OP01-003"]);
  assert.equal(
    urls[0],
    "https://api.example/v1/search?page=1&limit=2&sort=card_number&order=asc&collapse=card",
  );
  assert.equal(
    urls[1],
    "https://api.example/v1/search?page=2&limit=2&sort=card_number&order=asc&collapse=card",
  );
});

test("fetchPoneglyphCardCatalogSnapshot derives version from catalog metadata", async () => {
  const responseFor = (name) =>
    new Response(
      JSON.stringify({
        data: [
          {
            card_number: "OP01-001",
            name,
            effect: "[On Play] Draw 1 card.",
          },
          {
            effect: null,
            name: "Vanilla",
            card_number: "OP01-002",
          },
        ],
        pagination: { has_more: false },
      }),
      { status: 200 },
    );

  const first = await fetchPoneglyphCardCatalogSnapshot({
    baseUrl: "https://api.example",
    fetch: async () => responseFor("Monkey.D.Luffy"),
  });
  const second = await fetchPoneglyphCardCatalogSnapshot({
    baseUrl: "https://api.example",
    fetch: async () => responseFor("Monkey D. Luffy"),
  });

  assert.deepEqual(first.cardIds, ["OP01-001", "OP01-002"]);
  assert.match(first.cardDataVersion, /^poneglyph-search-[a-f0-9]{16}$/);
  assert.notEqual(first.cardDataVersion, second.cardDataVersion);
});

test("clearRedisKeysByPatternFromClient scans and deletes matching keys", async () => {
  const deleted = await clearRedisKeysByPatternFromClient(
    {
      async *scanIterator(options) {
        assert.deepEqual(options, { MATCH: "card:*", COUNT: 100 });
        yield "card:1";
        yield ["card:2", "card:3"];
      },
      async del(keys) {
        assert.deepEqual(keys, ["card:1", "card:2", "card:3"]);
        return keys.length;
      },
    },
    "card:*",
  );

  assert.equal(deleted, 3);
});
