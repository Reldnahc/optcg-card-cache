# optcg-card-cache

Shared card cache keys, Redis JSON adapter, cache warming orchestration, and coverage reporting for Poneglyph OPTCG services.

This package intentionally owns the cache contract outside the sim repo so the sim match server and admin API can agree on keys and status reporting.

## Card Cache Keys

```ts
import {
  createCardCacheKey,
  defaultPoneglyphSimCardCacheVersions,
} from "optcg-card-cache";

createCardCacheKey({
  cardId: "OP01-001",
  versions: defaultPoneglyphSimCardCacheVersions,
});
```

The key shape matches the sim cache:

```txt
card:<cardDataVersion>:<effectDefinitionsVersion>:<overlayVersion>:<cardId>
```

`defaultPoneglyphSimCardCacheVersions` is the shared current sim cache-version
contract. Admin/status callers and sim warmers should import it instead of
duplicating version string literals.

## Warming

The package warms cache entries by orchestrating rate-limited batches. The caller supplies the resolver so sim/admin can share the cache contract without duplicating gameplay parser logic.

```ts
await warmCardCache({
  cardIds,
  versions,
  cache,
  batchSize: 40,
  delayMs: 300,
  resolveCards: async (ids) => ids.map((id) => resolveCardForCache(id)),
});
```

## Coverage

`summarizeCardCacheCoverage` reports cache coverage and implementation coverage from cached `card.support.status` values.

`implemented-dsl` and `vanilla-confirmed` count as playable implementation coverage. Missing cache entries count as `unknown`.
