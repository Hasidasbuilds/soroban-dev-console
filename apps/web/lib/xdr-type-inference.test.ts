import { describe, it, expect } from "vitest";
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
} from "@stellar/stellar-sdk";
import {
  XDR_TYPE_ATTEMPTS,
  decodeXdr,
  inferXdrType,
  inferXdrTypes,
} from "@devconsole/soroban-utils";

function buildEnvelopeXdr(): string {
  const source = Keypair.random();
  const transaction = new TransactionBuilder(
    new Account(source.publicKey(), "1"),
    {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    },
  )
    .addOperation(
      Operation.payment({
        destination: Keypair.random().publicKey(),
        asset: Asset.native(),
        amount: "1",
      }),
    )
    .setTimeout(30)
    .build();

  return transaction.toEnvelope().toXDR("base64");
}

describe("inferXdrTypes / inferXdrType (#1277)", () => {
  it("decodes an ScVal payload and returns ranked candidates", () => {
    const candidates = inferXdrTypes(nativeToScVal(42).toXDR("base64"));

    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.map((candidate) => candidate.rank)).toEqual(
      candidates.map((_, index) => index),
    );
    expect(
      candidates.every((candidate) => candidate.parsed !== undefined),
    ).toBe(true);
  });

  it("identifies a transaction envelope", () => {
    const candidates = inferXdrTypes(buildEnvelopeXdr());

    expect(candidates.some((c) => c.typeName === "Transaction Envelope")).toBe(
      true,
    );
    expect(inferXdrType(buildEnvelopeXdr())?.typeName).toBe(
      "Transaction Envelope",
    );
  });

  it("agrees with decodeXdr's best-effort result", () => {
    const payload = nativeToScVal(42).toXDR("base64");

    expect(inferXdrType(payload)?.typeName).toBe(decodeXdr(payload)?.typeName);
  });

  it("reports confidence based on how many types matched", () => {
    const candidates = inferXdrTypes(nativeToScVal(42).toXDR("base64"));

    expect(candidates[0].confidence).toBe(
      candidates.length === 1 ? "high" : "ambiguous",
    );
    expect(
      candidates.every(
        (candidate) => candidate.confidence === candidates[0].confidence,
      ),
    ).toBe(true);
  });

  it("returns a BigInt-safe JSON rendering alongside the decoded value", () => {
    const payload = nativeToScVal(42).toXDR("base64");
    const [candidate] = inferXdrTypes(payload);

    expect(candidate.json).toContain("42");
    expect(candidate.raw).toBe(payload);
  });

  it("returns an empty list for input no known type can decode", () => {
    expect(inferXdrTypes("not-valid-xdr!!")).toEqual([]);
    expect(inferXdrType("not-valid-xdr!!")).toBeNull();
    expect(inferXdrType("")).toBeNull();
  });

  it("probes a bounded set of types so inference stays fast", () => {
    expect(XDR_TYPE_ATTEMPTS.length).toBeGreaterThan(0);
    expect(XDR_TYPE_ATTEMPTS.length).toBeLessThanOrEqual(10);

    const startedAt = Date.now();
    inferXdrTypes(buildEnvelopeXdr());
    expect(Date.now() - startedAt).toBeLessThan(200);
  });
});
