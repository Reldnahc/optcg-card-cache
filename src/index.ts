import { createHash } from "node:crypto";

export interface CardRepositoryVersions {
  readonly cardDataVersion: string;
  readonly effectDefinitionsVersion: string;
  readonly overlayVersion: string;
}

export const defaultPoneglyphSimCardCacheVersions: CardRepositoryVersions = {
  cardDataVersion: "live-poneglyph-dev-v1",
  effectDefinitionsVersion: "generated-dev-v13",
  overlayVersion: "none",
};

export interface CacheableResolvedCard {
  readonly cardId: string;
  readonly support?: {
    readonly status?: string;
  };
}

export interface CachedResolvedCard {
  readonly cacheSchemaVersion: 1;
  readonly versions: CardRepositoryVersions;
  readonly card: CacheableResolvedCard;
  readonly definition?: unknown;
}

export interface CardDataCache {
  getJson(key: string): Promise<unknown>;
  setJson(
    key: string,
    value: unknown,
    options?: { readonly ttlSeconds: number },
  ): Promise<void>;
}

export interface RedisJsonClient {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    options: { readonly EX: number },
  ): Promise<unknown>;
}

export interface RedisKeyPatternClient {
  scanIterator(options: {
    readonly MATCH: string;
    readonly COUNT: number;
  }): AsyncIterable<string | string[]>;
  del(keys: string[]): Promise<number>;
}

export interface WarmableResolvedCard {
  readonly card: CacheableResolvedCard;
  readonly definition?: unknown;
}

export interface WarmCardCacheInput {
  readonly cardIds: readonly string[];
  readonly versions: CardRepositoryVersions;
  readonly cache: CardDataCache;
  readonly resolveCards: (
    cardIds: readonly string[],
  ) => Promise<readonly WarmableResolvedCard[]>;
  readonly batchSize?: number;
  readonly delayMs?: number;
  readonly ttlSeconds?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onProgress?: (progress: CardCacheWarmProgress) => void;
}

export interface CardCacheWarmProgress {
  readonly processed: number;
  readonly total: number;
  readonly cached: number;
  readonly warmed: number;
  readonly failed: number;
}

export interface CardCacheWarmResult extends CardCacheWarmProgress {
  readonly coverage: CardCacheCoverage;
}

export interface CardCacheCoverage {
  readonly cards: {
    readonly total: number;
    readonly cached: number;
    readonly missing: number;
    readonly invalid: number;
    readonly coverage: number;
  };
  readonly implementation: {
    readonly total: number;
    readonly implemented: number;
    readonly vanilla: number;
    readonly unsupported: number;
    readonly unknown: number;
    readonly coverage: number;
  };
}

export interface FetchCardCatalogIdsInput {
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly pageSize?: number;
}

export interface PoneglyphCardCatalogSnapshot {
  readonly cardIds: readonly string[];
  readonly cardDataVersion: string;
}

interface CardSearchEnvelope {
  readonly data: readonly CardSearchCatalogItem[];
  readonly pagination?: {
    readonly has_more?: boolean;
  };
}

interface CardSearchCatalogItem {
  readonly card_number: string;
  readonly [key: string]: unknown;
}

const cacheSchemaVersion = 1;
const defaultRedisTtlSeconds = 60 * 60 * 24;
const defaultWarmBatchSize = 40;
const defaultWarmDelayMs = 300;
const defaultPoneglyphBaseUrl = "https://api.poneglyph.one";

export const createCardCacheKey = (input: {
  readonly cardId: string;
  readonly versions: CardRepositoryVersions;
}): string =>
  [
    "card",
    input.versions.cardDataVersion,
    input.versions.effectDefinitionsVersion,
    input.versions.overlayVersion,
    input.cardId,
  ].join(":");

export const createRedisCardDataCacheFromClient = (
  client: RedisJsonClient,
): CardDataCache => ({
  async getJson(key) {
    const value = await client.get(key);
    if (value === null) {
      return undefined;
    }
    try {
      return JSON.parse(value) as unknown;
    } catch (error) {
      throw new Error(
        `Invalid JSON stored in Redis card cache for ${key}`,
        error instanceof Error ? { cause: error } : undefined,
      );
    }
  },
  async setJson(key, value, options) {
    await client.set(key, JSON.stringify(value), {
      EX: options?.ttlSeconds ?? defaultRedisTtlSeconds,
    });
  },
});

export const createRedisCardDataCache = async (input: {
  readonly url: string;
}): Promise<CardDataCache> => {
  const redis = await import("redis");
  const client = redis.createClient({ url: input.url });
  await client.connect();
  return createRedisCardDataCacheFromClient(client);
};

export const clearRedisKeysByPatternFromClient = async (
  client: RedisKeyPatternClient,
  pattern = "card:*",
): Promise<number> => {
  const keys: string[] = [];
  for await (const entry of client.scanIterator({
    MATCH: pattern,
    COUNT: 100,
  })) {
    if (typeof entry === "string") {
      keys.push(entry);
    } else {
      keys.push(...entry);
    }
  }
  if (keys.length === 0) {
    return 0;
  }
  return client.del(keys);
};

export const isCurrentCachedResolvedCard = (
  value: unknown,
  input: {
    readonly cardId: string;
    readonly versions: CardRepositoryVersions;
  },
): value is CachedResolvedCard =>
  isCachedResolvedCard(value) &&
  value.card.cardId === input.cardId &&
  value.versions.cardDataVersion === input.versions.cardDataVersion &&
  value.versions.effectDefinitionsVersion ===
    input.versions.effectDefinitionsVersion &&
  value.versions.overlayVersion === input.versions.overlayVersion;

export const summarizeCardCacheCoverage = async (input: {
  readonly cardIds: readonly string[];
  readonly versions: CardRepositoryVersions;
  readonly cache: CardDataCache;
}): Promise<CardCacheCoverage> => {
  const cardIds = unique(input.cardIds);
  let cached = 0;
  let invalid = 0;
  let implemented = 0;
  let vanilla = 0;
  let unsupported = 0;
  let unknown = 0;

  for (const cardId of cardIds) {
    const cachedValue = await input.cache.getJson(
      createCardCacheKey({ cardId, versions: input.versions }),
    );
    if (
      !isCurrentCachedResolvedCard(cachedValue, {
        cardId,
        versions: input.versions,
      })
    ) {
      if (cachedValue === undefined) {
        unknown += 1;
      } else {
        invalid += 1;
        unknown += 1;
      }
      continue;
    }

    cached += 1;
    const status = cachedValue.card.support?.status;
    if (status === "implemented-dsl") {
      implemented += 1;
    } else if (status === "vanilla-confirmed") {
      vanilla += 1;
    } else if (status === "unsupported") {
      unsupported += 1;
    } else {
      unknown += 1;
    }
  }

  const total = cardIds.length;
  const supported = implemented + vanilla;
  return {
    cards: {
      total,
      cached,
      missing: total - cached - invalid,
      invalid,
      coverage: ratio(cached, total),
    },
    implementation: {
      total,
      implemented,
      vanilla,
      unsupported,
      unknown,
      coverage: ratio(supported, total),
    },
  };
};

export const warmCardCache = async (
  input: WarmCardCacheInput,
): Promise<CardCacheWarmResult> => {
  const cardIds = unique(input.cardIds);
  const batchSize = positiveInteger(input.batchSize, defaultWarmBatchSize);
  const delayMs = nonNegativeInteger(input.delayMs, defaultWarmDelayMs);
  const sleep = input.sleep ?? defaultSleep;
  const missing: string[] = [];
  let cached = 0;
  let failed = 0;

  for (const cardId of cardIds) {
    const cachedValue = await input.cache.getJson(
      createCardCacheKey({ cardId, versions: input.versions }),
    );
    if (
      isCurrentCachedResolvedCard(cachedValue, {
        cardId,
        versions: input.versions,
      })
    ) {
      cached += 1;
    } else {
      missing.push(cardId);
    }
  }

  let warmed = 0;
  for (let index = 0; index < missing.length; index += batchSize) {
    const batch = missing.slice(index, index + batchSize);
    try {
      const resolved = await input.resolveCards(batch);
      const resolvedById = new Map(
        resolved.map((entry) => [entry.card.cardId, entry]),
      );
      for (const cardId of batch) {
        const entry = resolvedById.get(cardId);
        if (entry === undefined) {
          failed += 1;
          continue;
        }
        await input.cache.setJson(
          createCardCacheKey({ cardId, versions: input.versions }),
          {
            cacheSchemaVersion,
            versions: input.versions,
            card: entry.card,
            ...(entry.definition === undefined
              ? {}
              : { definition: entry.definition }),
          },
          input.ttlSeconds === undefined
            ? undefined
            : { ttlSeconds: input.ttlSeconds },
        );
        warmed += 1;
      }
    } catch {
      failed += batch.length;
    }

    input.onProgress?.({
      processed: cached + warmed + failed,
      total: cardIds.length,
      cached,
      warmed,
      failed,
    });

    if (index + batchSize < missing.length && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  return {
    processed: cached + warmed + failed,
    total: cardIds.length,
    cached,
    warmed,
    failed,
    coverage: await summarizeCardCacheCoverage({
      cardIds,
      versions: input.versions,
      cache: input.cache,
    }),
  };
};

export const fetchPoneglyphCardCatalogIds = async ({
  baseUrl = defaultPoneglyphBaseUrl,
  fetch: fetchImpl = fetch,
  pageSize = 500,
}: FetchCardCatalogIdsInput = {}): Promise<string[]> => {
  const snapshot = await fetchPoneglyphCardCatalogSnapshot({
    baseUrl,
    fetch: fetchImpl,
    pageSize,
  });
  return [...snapshot.cardIds];
};

export const fetchPoneglyphCardCatalogSnapshot = async ({
  baseUrl = defaultPoneglyphBaseUrl,
  fetch: fetchImpl = fetch,
  pageSize = 500,
}: FetchCardCatalogIdsInput = {}): Promise<PoneglyphCardCatalogSnapshot> => {
  const cardIds: string[] = [];
  const hash = createHash("sha256");
  let page = 1;
  while (true) {
    const url = new URL(`${baseUrl.replace(/\/+$/u, "")}/v1/search`);
    url.searchParams.set("page", String(page));
    url.searchParams.set("limit", String(pageSize));
    url.searchParams.set("sort", "card_number");
    url.searchParams.set("order", "asc");
    url.searchParams.set("collapse", "card");
    const response = await fetchImpl(url);
    if (!response.ok) {
      throw new Error(
        `Poneglyph card catalog fetch failed with HTTP ${String(response.status)}.`,
      );
    }
    const body = (await response.json()) as unknown;
    if (!isCardSearchEnvelope(body)) {
      throw new Error("Poneglyph card catalog response is malformed.");
    }
    const cards = [...body.data].sort((left, right) =>
      left.card_number.localeCompare(right.card_number),
    );
    for (const card of cards) {
      cardIds.push(card.card_number);
      hash.update(stableJson(card));
      hash.update("\n");
    }
    if (body.pagination?.has_more !== true) {
      break;
    }
    page += 1;
  }
  return {
    cardIds: unique(cardIds),
    cardDataVersion: `poneglyph-search-${hash.digest("hex").slice(0, 16)}`,
  };
};

const isCachedResolvedCard = (value: unknown): value is CachedResolvedCard => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<CachedResolvedCard>;
  return (
    candidate.cacheSchemaVersion === cacheSchemaVersion &&
    typeof candidate.versions === "object" &&
    candidate.versions !== null &&
    typeof candidate.card === "object" &&
    candidate.card !== null &&
    typeof candidate.card.cardId === "string"
  );
};

const isCardSearchEnvelope = (value: unknown): value is CardSearchEnvelope => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { data?: unknown };
  return (
    Array.isArray(candidate.data) &&
    candidate.data.every(
      (card) =>
        typeof card === "object" &&
        card !== null &&
        typeof (card as { card_number?: unknown }).card_number === "string",
    )
  );
};

const unique = (values: readonly string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
};

const stableJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
};

const ratio = (value: number, total: number): number =>
  total === 0 ? 1 : value / total;

const positiveInteger = (
  value: number | undefined,
  fallback: number,
): number =>
  value !== undefined && Number.isInteger(value) && value > 0
    ? value
    : fallback;

const nonNegativeInteger = (
  value: number | undefined,
  fallback: number,
): number =>
  value !== undefined && Number.isInteger(value) && value >= 0
    ? value
    : fallback;

const defaultSleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};
