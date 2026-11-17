// @effect-diagnostics nodeBuiltinImport:off - Electron main signs with a P-256 key it keeps as a JWK; Effect has no JWK EC signer.
import * as NodeCrypto from "node:crypto";

import { DpopProof } from "@t3tools/client-runtime/relay";
import { DpopPublicJwk } from "@t3tools/shared/dpopCommon";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";

const PrivateJwk = Schema.Struct({
  kty: Schema.Literal("EC"),
  crv: Schema.Literal("P-256"),
  x: Schema.String,
  y: Schema.String,
  d: Schema.String,
});

const StoredDevice = Schema.Struct({
  privateJwk: PrivateJwk,
  publicJwk: DpopPublicJwk,
  deviceId: Schema.String,
  deviceName: Schema.String,
  connectedAt: Schema.String,
});
export type StoredDevice = typeof StoredDevice.Type;

const StoredDeviceJson = Schema.fromJsonString(StoredDevice);
const KeyFileDocument = fromLenientJson(
  Schema.Struct({
    version: Schema.Literal(1),
    encryptedDevice: Schema.optionalKey(Schema.String),
    devPlainDevice: Schema.optionalKey(Schema.String),
  }),
);
const decodeKeyFile = Schema.decodeEffect(KeyFileDocument);
const encodeKeyFile = Schema.encodeEffect(KeyFileDocument);
const decodeStoredDevice = Schema.decodeEffect(StoredDeviceJson);
const encodeStoredDevice = Schema.encodeEffect(StoredDeviceJson);

export class RailsDeviceKeyError extends Schema.TaggedError<RailsDeviceKeyError>()(
  "RailsDeviceKeyError",
  {
    operation: Schema.Literals(["storage", "read", "write", "delete", "decode"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `The Rails device key could not ${this.operation}.`;
  }
}

export interface RailsKeyPair {
  readonly privateJwk: typeof PrivateJwk.Type;
  readonly publicJwk: DpopPublicJwk;
}

export const generateKeyPair = (): RailsKeyPair => {
  const { privateKey } = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = privateKey.export({ format: "jwk" });
  const privateJwk = { kty: "EC", crv: "P-256", x: jwk.x!, y: jwk.y!, d: jwk.d! } as const;
  return { privateJwk, publicJwk: { kty: "EC", crv: "P-256", x: privateJwk.x, y: privateJwk.y } };
};

export const proofKey = (pair: RailsKeyPair): DpopProof.DpopProofKey => {
  const privateKey = NodeCrypto.createPrivateKey({ key: pair.privateJwk, format: "jwk" });
  return {
    publicJwk: pair.publicJwk,
    sign: (signingInput) =>
      Effect.try({
        try: () =>
          new Uint8Array(
            NodeCrypto.sign("sha256", signingInput, { key: privateKey, dsaEncoding: "ieee-p1363" }),
          ),
        catch: (cause) =>
          new DpopProof.DpopProofError({ message: "Rails proof signing failed.", cause }),
      }),
  };
};

export class RailsDeviceKey extends Context.Service<
  RailsDeviceKey,
  {
    readonly storageUsable: Effect.Effect<boolean>;
    readonly load: Effect.Effect<Option.Option<StoredDevice>, RailsDeviceKeyError>;
    readonly store: (device: StoredDevice) => Effect.Effect<void, RailsDeviceKeyError>;
    readonly remove: Effect.Effect<void, RailsDeviceKeyError>;
  }
>()("@t3tools/desktop/railsWords/RailsDeviceKey") {}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const random = yield* SecureRandom.SecureRandom;
  const keyPath = path.join(environment.stateDir, "rails-words-device.json");
  const fail = (operation: RailsDeviceKeyError["operation"]) => (cause: unknown) =>
    new RailsDeviceKeyError({ operation, cause });

  const storageMode = Effect.gen(function* () {
    const available = yield* safeStorage.isEncryptionAvailable.pipe(
      Effect.orElseSucceed(() => false),
    );
    const backend = yield* safeStorage.selectedStorageBackend;
    const plainText = Option.isSome(backend) && backend.value === "basic_text";
    if (!plainText) return available ? "safe" : "none";
    return environment.isDevelopment ? "devPlain" : "none";
  });
  const storageUsable = Effect.map(storageMode, (mode) => mode !== "none");

  const load = Effect.gen(function* () {
    const raw = yield* fileSystem
      .readFileString(keyPath)
      .pipe(
        Effect.catch((error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed(null)
            : Effect.fail(fail("read")(error)),
        ),
      );
    if (raw === null) return Option.none<StoredDevice>();
    const document = yield* decodeKeyFile(raw).pipe(Effect.mapError(fail("decode")));
    const bytes = yield* Effect.fromResult(
      Base64.decode(document.encryptedDevice ?? document.devPlainDevice ?? ""),
    ).pipe(Effect.mapError(fail("decode")));
    const json =
      document.encryptedDevice === undefined
        ? new TextDecoder().decode(bytes)
        : yield* safeStorage.decryptString(bytes).pipe(Effect.mapError(fail("storage")));
    return Option.some(yield* decodeStoredDevice(json).pipe(Effect.mapError(fail("decode"))));
  }).pipe(Effect.withSpan("RailsDeviceKey.load"));

  const store = Effect.fn("RailsDeviceKey.store")(function* (device: StoredDevice) {
    const mode = yield* storageMode;
    if (mode === "none") return yield* new RailsDeviceKeyError({ operation: "storage" });
    const json = yield* encodeStoredDevice(device).pipe(Effect.mapError(fail("write")));
    const document = yield* encodeKeyFile(
      mode === "safe"
        ? {
            version: 1,
            encryptedDevice: Base64.encode(
              yield* safeStorage.encryptString(json).pipe(Effect.mapError(fail("storage"))),
            ),
          }
        : { version: 1, devPlainDevice: Base64.encode(new TextEncoder().encode(json)) },
    ).pipe(Effect.mapError(fail("write")));
    const tempPath = `${keyPath}.${(yield* random.uuidV4()).replace(/-/g, "")}.tmp`;
    yield* fileSystem
      .makeDirectory(path.dirname(keyPath), { recursive: true })
      .pipe(Effect.mapError(fail("write")));
    yield* fileSystem
      .writeFileString(tempPath, `${document}\n`, { mode: 0o600 })
      .pipe(
        Effect.andThen(fileSystem.rename(tempPath, keyPath)),
        Effect.mapError(fail("write")),
        Effect.ensuring(fileSystem.remove(tempPath, { force: true }).pipe(Effect.ignore)),
      );
  });

  const remove = fileSystem
    .remove(keyPath, { force: true })
    .pipe(Effect.mapError(fail("delete")), Effect.withSpan("RailsDeviceKey.remove"));

  return RailsDeviceKey.of({ storageUsable, load, store, remove });
});

export const layer = Layer.effect(RailsDeviceKey, make);
