import { nativeToScVal, StrKey, xdr } from "@stellar/stellar-sdk";

export type XdrType = "TransactionEnvelope" | "ScVal" | "LedgerKey";

/**
 * Decoded XDR result. Returned by {@link decodeXdr}.
 *
 * `typeName` is the inferred Stellar XDR type name (best-effort heuristic).
 * `json` is a JSON-stringified representation safe to render in the UI.
 */
export interface DecodedXdr {
  typeName: string;
  parsed: unknown;
  json: string;
  raw: string;
  error?: string;
}

/**
 * BigInt-safe JSON replacer used across the app.
 * Public so consumers (e.g. <XdrTooltip />) can re-use the same shape.
 */
export const xdrJsonReplacer = (_key: string, value: unknown): unknown => {
  if (typeof value === "bigint") {
    return value.toString();
  }
  return value;
};

/** A single candidate decoder: a display name plus the XDR type's `fromXDR`. */
export interface XdrTypeAttempt {
  name: string;
  from: (raw: string, fmt: "base64") => unknown;
}

/**
 * Issue #1277: the XDR types probed when inferring an unknown payload.
 *
 * Ordered most-specific/common first. The order doubles as the ranking used by
 * {@link inferXdrTypes}: a `Transaction Envelope` beats a `Ledger Entry` when
 * both manage to decode the same bytes.
 *
 * The `from` callbacks are arrow functions on purpose: the SDK's `fromXDR`
 * statics are `this`-dependent, so a detached reference (`from: X.fromXDR`)
 * throws inside the decoder and makes every probe fail.
 */
export const XDR_TYPE_ATTEMPTS: Array<XdrTypeAttempt> = [
  {
    name: "Transaction Envelope",
    from: (raw, format) => xdr.TransactionEnvelope.fromXDR(raw, format),
  },
  {
    name: "Transaction Result",
    from: (raw, format) => xdr.TransactionResult.fromXDR(raw, format),
  },
  {
    name: "Transaction Meta",
    from: (raw, format) => xdr.TransactionMeta.fromXDR(raw, format),
  },
  {
    name: "Soroban Value (ScVal)",
    from: (raw, format) => xdr.ScVal.fromXDR(raw, format),
  },
  {
    name: "Ledger Entry",
    from: (raw, format) => xdr.LedgerEntry.fromXDR(raw, format),
  },
  {
    name: "Soroban Auth",
    from: (raw, format) => xdr.SorobanAuthorizationEntry.fromXDR(raw, format),
  },
];

/**
 * Best-effort XDR decoder used by FE-680 / W7-FE-002.
 *
 * Tries the most common Stellar/Soroban XDR envelope types in order of
 * likelihood and returns the first that decodes successfully. Returns
 * `null` if no known type matches.
 *
 * The returned `json` field is BigInt-safe and safe to render in <pre>.
 */
export function decodeXdr(base64Xdr: string): DecodedXdr | null {
  if (!base64Xdr || typeof base64Xdr !== "string") return null;

  for (const attempt of XDR_TYPE_ATTEMPTS) {
    try {
      const parsed = attempt.from(base64Xdr, "base64");
      return {
        typeName: attempt.name,
        parsed,
        json: JSON.stringify(parsed, xdrJsonReplacer, 2),
        raw: base64Xdr,
      };
    } catch {
      // try next type
    }
  }

  return null;
}

/** A ranked candidate from {@link inferXdrTypes}. */
export interface XdrTypeCandidate extends DecodedXdr {
  /** Position in the ranked list; 0 is the most likely type. */
  rank: number;
  /** `high` when exactly one type decoded, `ambiguous` when several did. */
  confidence: "high" | "ambiguous";
}

/**
 * Issue #1277: infer every XDR type that can decode `base64Xdr`, ranked.
 *
 * Unlike {@link decodeXdr}, which stops at the first plausible type, this
 * reports *all* matches so callers can surface ambiguity (a payload that decodes
 * as both a Transaction Meta and a Ledger Entry is worth flagging to the user).
 *
 * Each attempt is wrapped in try/catch, so a full pass costs one failed parse
 * per non-matching type — well under the 200ms budget for the six known types.
 */
export function inferXdrTypes(base64Xdr: string): XdrTypeCandidate[] {
  if (!base64Xdr || typeof base64Xdr !== "string") return [];

  const matches: DecodedXdr[] = [];

  for (const attempt of XDR_TYPE_ATTEMPTS) {
    try {
      const parsed = attempt.from(base64Xdr, "base64");
      matches.push({
        typeName: attempt.name,
        parsed,
        json: JSON.stringify(parsed, xdrJsonReplacer, 2),
        raw: base64Xdr,
      });
    } catch {
      // Type did not match; try the next candidate.
    }
  }

  const confidence = matches.length === 1 ? "high" : "ambiguous";

  return matches.map((match, rank) => ({ ...match, rank, confidence }));
}

/**
 * Issue #1277: the single most likely XDR type for `base64Xdr`, or `null`.
 *
 * Equivalent to the head of {@link inferXdrTypes} and to {@link decodeXdr}
 * (same probe order), which keeps the helpers consistent.
 */
export function inferXdrType(base64Xdr: string): XdrTypeCandidate | null {
  return inferXdrTypes(base64Xdr)[0] ?? null;
}

export function encodeJsonToXdr(jsonString: string, type: XdrType): string {
  try {
    const obj = JSON.parse(jsonString);

    switch (type) {
      case "TransactionEnvelope":
        if (typeof obj === "string") {
          return xdr.TransactionEnvelope.fromXDR(obj, "base64").toXDR("base64");
        }
        if (typeof obj?.xdr === "string") {
          return xdr.TransactionEnvelope.fromXDR(obj.xdr, "base64").toXDR(
            "base64",
          );
        }
        throw new Error(
          "TransactionEnvelope encoding currently accepts base64 XDR only.",
        );

      case "ScVal":
        return nativeToScVal(obj).toXDR("base64");

      case "LedgerKey":
        if (typeof obj === "string") {
          return xdr.LedgerKey.fromXDR(obj, "base64").toXDR("base64");
        }
        if (typeof obj?.xdr === "string") {
          return xdr.LedgerKey.fromXDR(obj.xdr, "base64").toXDR("base64");
        }
        throw new Error(
          "LedgerKey encoding currently accepts base64 XDR only.",
        );

      default:
        throw new Error("Unsupported XDR type for encoding");
    }
  } catch (error: any) {
    throw new Error(`Encoding failed: ${error.message}`);
  }
}

/**
 * FE-049: Extract the real contract ID from a successful deploy transaction's
 * result XDR. The Soroban host returns the new contract address as an ScAddress
 * inside the transaction's return value.
 *
 * @param resultMetaXdr - TransactionMeta from getTransaction, or its base64 XDR
 * @returns Strkey-encoded contract ID (C…) or null if not found
 */
export function extractContractIdFromDeployResult(
  resultMetaXdr: string | xdr.TransactionMeta,
): string | null {
  try {
    const meta =
      typeof resultMetaXdr === "string"
        ? xdr.TransactionMeta.fromXDR(resultMetaXdr, "base64")
        : resultMetaXdr;
    // v3 meta carries sorobanMeta with the return value
    const sorobanMeta = meta.v3().sorobanMeta();
    if (!sorobanMeta) return null;

    const returnValue = sorobanMeta.returnValue();
    // The return value of createCustomContract is ScVal::Address
    if (returnValue.switch().name !== "scvAddress") return null;

    const scAddress = returnValue.address();
    if (scAddress.switch().name !== "scAddressTypeContract") return null;

    const contractIdBytes = scAddress.contractId();
    return StrKey.encodeContract(
      Buffer.from(contractIdBytes as unknown as Uint8Array),
    );
  } catch {
    return null;
  }
}
