import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Budget,
  BudgetExceededError,
  FREE_MONTHLY,
  estimateCost,
} from "../src/services/budget";
import {
  placesQuery,
  PLACES_SKU,
  WEBSITE_FIELD_MASK,
  createGooglePlaces,
} from "../src/adapters/googlePlaces";

function counters(start = 0) {
  let used = start;
  const recorded: number[] = [];
  return {
    counters: {
      async usedThisMonth() {
        return used;
      },
      async record(_sku: string, n: number) {
        used += n;
        recorded.push(n);
      },
    },
    get used() {
      return used;
    },
    recorded,
  };
}

test("the guard refuses the request that would cross the free allowance", async () => {
  const limit = FREE_MONTHLY[PLACES_SKU]!;
  const c = counters(limit);
  const budget = new Budget(c.counters);
  await assert.rejects(() => budget.check(PLACES_SKU), BudgetExceededError);
  // Nothing was spent, because nothing was allowed to happen.
  assert.equal(c.recorded.length, 0);
});

test("the check happens before the spend, not after", async () => {
  const limit = FREE_MONTHLY[PLACES_SKU]!;
  const c = counters(limit - 1);
  const budget = new Budget(c.counters);
  await budget.check(PLACES_SKU);
  await budget.spent(PLACES_SKU);
  // Exactly at the ceiling now; the next one must be refused.
  await assert.rejects(() => budget.check(PLACES_SKU), BudgetExceededError);
  assert.equal(c.used, limit);
});

test("a per-run ceiling stops before the monthly one does", async () => {
  const c = counters(0);
  const budget = new Budget(c.counters, { maxRequests: 2 });
  for (let i = 0; i < 2; i++) {
    await budget.check(PLACES_SKU);
    await budget.spent(PLACES_SKU);
  }
  await assert.rejects(() => budget.check(PLACES_SKU), BudgetExceededError);
  assert.equal(budget.requestsThisRun, 2);
});

test("remaining counts down from the monthly allowance", async () => {
  const c = counters(940);
  const budget = new Budget(c.counters);
  assert.equal(await budget.remaining(PLACES_SKU), FREE_MONTHLY[PLACES_SKU]! - 940);
});

test("an unknown SKU has no allowance, so nothing is free", async () => {
  const budget = new Budget(counters(0).counters);
  assert.equal(await budget.remaining("inventado"), 0);
  await assert.rejects(() => budget.check("inventado"), BudgetExceededError);
});

test("the cost estimate is what the free tier is saving you", () => {
  // 1000 Text Search Enterprise calls at USD 35 / 1000.
  assert.equal(estimateCost(PLACES_SKU, 1000), 35);
  assert.equal(estimateCost("inventado", 1000), 0);
});

test("the query is name plus city plus state", () => {
  assert.equal(
    placesQuery({
      nomeFantasia: "Colégio X",
      razaoSocial: "X LTDA",
      municipio: "Santos",
      uf: "SP",
    }),
    "Colégio X, Santos, SP"
  );
  // Falls back to razão social, and tolerates a missing município.
  assert.equal(
    placesQuery({ nomeFantasia: null, razaoSocial: "Y LTDA", municipio: null, uf: "SP" }),
    "Y LTDA, SP"
  );
  assert.equal(
    placesQuery({ nomeFantasia: null, razaoSocial: null, municipio: "Santos", uf: "SP" }),
    null
  );
});

test("only place id and website are ever requested from Google", async () => {
  // Their terms permit storing place_id and nothing else. The field mask is the
  // enforcement: a field never fetched cannot be stored by accident.
  assert.equal(WEBSITE_FIELD_MASK, "places.id,places.websiteUri");
  assert.doesNotMatch(WEBSITE_FIELD_MASK, /displayName|phone|rating|formattedAddress/);

  let sentMask: string | null = null;
  const client = createGooglePlaces({
    apiKey: "k",
    http: {
      async fetch(_url, init) {
        sentMask = (init?.headers as Record<string, string>)["X-Goog-FieldMask"] ?? null;
        return new Response(
          JSON.stringify({ places: [{ id: "p1", websiteUri: "https://x.br" }] }),
          {
            status: 200,
          }
        );
      },
    },
  });
  const out = await client.findWebsite("Colégio X, Santos, SP");
  assert.equal(sentMask, WEBSITE_FIELD_MASK);
  assert.deepEqual(out, { placeId: "p1", websiteUrl: "https://x.br" });
});

test("no match is an answer, not an error", async () => {
  const client = createGooglePlaces({
    apiKey: "k",
    http: {
      async fetch() {
        return new Response(JSON.stringify({}), { status: 200 });
      },
    },
  });
  assert.equal(await client.findWebsite("Nada, Lugar, XX"), null);
});

test("a billed search that matched nothing is still counted", async () => {
  let counted = 0;
  const client = createGooglePlaces({
    apiKey: "k",
    afterRequest: () => {
      counted++;
    },
    http: {
      async fetch() {
        return new Response(JSON.stringify({}), { status: 200 });
      },
    },
  });
  await client.findWebsite("Nada, Lugar, XX");
  assert.equal(counted, 1, "Google bills the search whether or not it matched");
});
