import type { DesktopSshEnvironmentTarget, EnvironmentId } from "@t3tools/contracts";
import { resolveRemotePairingTarget } from "@t3tools/shared/remote";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";

import { bootstrapRemoteBearerSession } from "../authorization/remote.ts";
import { deriveWsBaseUrl, normalizeHttpBaseUrl } from "../environment/endpoint.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  type ConnectionCatalogEntry,
  type ConnectionCredential,
  SshConnectionProfile,
  SshConnectionRegistration,
} from "./catalog.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import { credentialRevision } from "./credentialRevision.ts";
import { mapRemoteEnvironmentError } from "./errors.ts";
import {
  BearerConnectionTarget,
  ConnectionBlockedError,
  SshConnectionTarget,
  type ConnectionAttemptError,
} from "./model.ts";
import * as Persistence from "../platform/persistence.ts";
import * as EnvironmentRegistry from "./registry.ts";
import { orchestrationProtocolCompatibilityError } from "./compatibility.ts";
import { connectionRoutes, routeEntry, sshTargetKey } from "./routes.ts";

export interface PairingConnectionInput {
  readonly pairingUrl?: string;
  readonly host?: string;
  readonly pairingCode?: string;
  readonly expectedEnvironmentId?: EnvironmentId;
  readonly alsoAt?: ReadonlyArray<string>;
}

export interface SshConnectionInput {
  readonly target: DesktopSshEnvironmentTarget;
  readonly label?: string;
  readonly expectedEnvironmentId?: EnvironmentId;
}

export interface BearerConnectionUpdateInput {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly httpBaseUrl: string;
}

export interface PairingCommit {
  readonly environmentId: EnvironmentId;
  readonly credentialRevision: string;
}

export class ConnectionOnboarding extends Context.Service<
  ConnectionOnboarding,
  {
    readonly registerPairing: (
      input: PairingConnectionInput,
    ) => Effect.Effect<
      EnvironmentId,
      ConnectionAttemptError | Persistence.ConnectionPersistenceError
    >;
    readonly commitPairing: (
      input: PairingConnectionInput,
    ) => Effect.Effect<
      PairingCommit,
      ConnectionAttemptError | Persistence.ConnectionPersistenceError
    >;
    readonly registerSsh: (
      input: SshConnectionInput,
    ) => Effect.Effect<
      EnvironmentId,
      ConnectionAttemptError | Persistence.ConnectionPersistenceError
    >;
    readonly updateBearer: (
      input: BearerConnectionUpdateInput,
    ) => Effect.Effect<void, ConnectionAttemptError | Persistence.ConnectionPersistenceError>;
  }
>()("@t3tools/client-runtime/connection/onboarding/ConnectionOnboarding") {}

const resolvePairingTarget = Effect.fn("clientRuntime.connection.onboarding.resolvePairingTarget")(
  function* (input: PairingConnectionInput) {
    return yield* Effect.try({
      try: () => resolveRemotePairingTarget(input),
      catch: (cause) =>
        new ConnectionBlockedError({
          reason: "configuration",
          detail: cause instanceof Error ? cause.message : "The pairing details are invalid.",
        }),
    });
  },
);

function bearerConnectionId(environmentId: EnvironmentId, httpBaseUrl: string): string {
  return `bearer:${environmentId}:${new URL(httpBaseUrl).origin}`;
}

function differentMachineError(label: string) {
  return new ConnectionBlockedError({
    reason: "configuration",
    detail: `That address reaches ${label}, a different machine. Add it as its own environment instead.`,
  });
}

export const preparePairingRegistration = Effect.fn(
  "clientRuntime.connection.onboarding.preparePairingRegistration",
)(function* (input: PairingConnectionInput) {
  const target = yield* resolvePairingTarget(input);
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const descriptor = yield* fetchRemoteEnvironmentDescriptor({
    httpBaseUrl: target.httpBaseUrl,
  }).pipe(Effect.mapError(mapRemoteEnvironmentError));
  // Checked before redeeming the one-time code, so a wrong link is not spent.
  if (
    input.expectedEnvironmentId !== undefined &&
    descriptor.environmentId !== input.expectedEnvironmentId
  ) {
    return yield* differentMachineError(descriptor.label);
  }
  const connectionId = bearerConnectionId(descriptor.environmentId, target.httpBaseUrl);
  const route = {
    target: new BearerConnectionTarget({
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      connectionId,
    }),
    profile: new BearerConnectionProfile({
      connectionId,
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      httpBaseUrl: target.httpBaseUrl,
      wsBaseUrl: target.wsBaseUrl,
    }),
  };
  // The registry checks again under its lease; this early check keeps a refused code unspent.
  if (input.expectedEnvironmentId === undefined) {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    yield* registry.assertKnownAddress({ ...route, profile: Option.some(route.profile) });
  }
  const compatibilityError = orchestrationProtocolCompatibilityError(descriptor);
  // An outdated server is still saved so it can be updated from this client.
  if (compatibilityError !== null && compatibilityError.serverUpdateRequired !== true) {
    return yield* compatibilityError;
  }
  const access = yield* bootstrapRemoteBearerSession({
    httpBaseUrl: target.httpBaseUrl,
    credential: target.credential,
    clientMetadata: presentation.metadata,
  }).pipe(Effect.mapError(mapRemoteEnvironmentError));

  return new BearerConnectionRegistration({
    ...route,
    credential: new BearerConnectionCredential({
      token: access.access_token,
    }),
  });
});

function alternateBaseUrl(address: string): string | null {
  try {
    const url = new URL(address);
    return url.protocol === "https:" ? `${url.origin}/` : null;
  } catch {
    return null;
  }
}

function alternateOrigins(
  registration: BearerConnectionRegistration,
  addresses: ReadonlyArray<string>,
): ReadonlyArray<string | null> {
  const seen = new Set([new URL(registration.profile.httpBaseUrl).origin]);
  return addresses.flatMap((address) => {
    const httpBaseUrl = alternateBaseUrl(address);
    if (httpBaseUrl === null) return [null];
    const origin = new URL(httpBaseUrl).origin;
    if (seen.has(origin)) return [];
    seen.add(origin);
    return [httpBaseUrl];
  });
}

const prepareAlternateRoute = Effect.fn(
  "clientRuntime.connection.onboarding.prepareAlternateRoute",
)(function* (registration: BearerConnectionRegistration, httpBaseUrl: string) {
  const environmentId = registration.target.environmentId;
  const requestInit = yield* Effect.serviceOption(FetchHttpClient.RequestInit);
  const descriptor = yield* fetchRemoteEnvironmentDescriptor({ httpBaseUrl }).pipe(
    Effect.provideService(FetchHttpClient.RequestInit, {
      ...Option.getOrUndefined(requestInit),
      redirect: "error",
      cache: "no-store",
    }),
    Effect.mapError(mapRemoteEnvironmentError),
  );
  if (descriptor.environmentId !== environmentId) {
    return yield* differentMachineError(descriptor.label);
  }
  const connectionId = bearerConnectionId(environmentId, httpBaseUrl);
  const label = registration.target.label;
  return new BearerConnectionRegistration({
    target: new BearerConnectionTarget({ environmentId, label, connectionId }),
    profile: new BearerConnectionProfile({
      connectionId,
      environmentId,
      label,
      httpBaseUrl,
      wsBaseUrl: deriveWsBaseUrl(httpBaseUrl),
    }),
    credential: registration.credential,
  });
});

const prepareAlternateRoutes = Effect.fn(
  "clientRuntime.connection.onboarding.prepareAlternateRoutes",
)(function* (registration: BearerConnectionRegistration, addresses: ReadonlyArray<string>) {
  const prepared = yield* Effect.forEach(
    alternateOrigins(registration, addresses),
    (httpBaseUrl) =>
      httpBaseUrl === null
        ? Effect.logWarning("Skipped a paired environment's other address.", {
            reason: "not-https",
          }).pipe(Effect.as([]))
        : prepareAlternateRoute(registration, httpBaseUrl).pipe(
            Effect.map((route) => [route]),
            Effect.catch((error) =>
              Effect.logWarning("Could not add a paired environment's other address.", {
                error: error._tag,
                reason: "reason" in error ? error.reason : null,
              }).pipe(Effect.as([])),
            ),
          ),
    { concurrency: "unbounded" },
  );
  return prepared.flat();
});

const registerPairingConnection = Effect.fn(
  "clientRuntime.connection.onboarding.registerPairingConnection",
)(function* (input: PairingConnectionInput) {
  const unlessRemovedSince = yield* Clock.currentTimeNanos;
  const registration = yield* preparePairingRegistration(input);
  const alongside = yield* prepareAlternateRoutes(registration, input.alsoAt ?? []);
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const knownAddressOnly = input.expectedEnvironmentId === undefined;
  const environmentId = registration.target.environmentId;
  const committed = yield* registry.register(registration, {
    knownAddressOnly,
    alongside,
    unlessRemovedSince,
  });
  if (committed) {
    yield* registry.setCompatibility(environmentId, null);
    yield* registry
      .setEnabled(environmentId, true)
      .pipe(Effect.catchTags({ EnvironmentNotRegisteredError: () => Effect.void }));
  }
  return {
    environmentId,
    committed,
    credentialRevision: credentialRevision(registration.credential.token),
  };
});

const commitPairingConnection = Effect.fn(
  "clientRuntime.connection.onboarding.commitPairingConnection",
)(function* (input: PairingConnectionInput) {
  const receipt = yield* registerPairingConnection(input);
  if (!receipt.committed) {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      failureCause: "environment_platform_managed",
      detail: "This device already manages that environment, so the pairing was not saved.",
    });
  }
  return {
    environmentId: receipt.environmentId,
    credentialRevision: receipt.credentialRevision,
  } satisfies PairingCommit;
});

const isBearerCredential = Schema.is(BearerConnectionCredential);
const isBearerProfile = Schema.is(BearerConnectionProfile);

const updateBearerConnection = Effect.fn(
  "clientRuntime.connection.onboarding.updateBearerConnection",
)(function* (input: BearerConnectionUpdateInput) {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
  const saved = (yield* SubscriptionRef.get(registry.entries)).get(input.environmentId);
  const route =
    saved === undefined
      ? undefined
      : connectionRoutes(saved).find(
          (candidate) => candidate.target._tag === "BearerConnectionTarget",
        );
  const entry = saved === undefined || route === undefined ? saved : routeEntry(saved, route);
  const credential =
    entry?.target._tag === "BearerConnectionTarget"
      ? yield* credentials.get(entry.target.connectionId)
      : Option.none();
  const registration = yield* prepareBearerConnectionUpdate({
    input,
    entry: Option.fromUndefinedOr(entry),
    credential,
  });
  yield* registry.register(registration);
});

export const prepareBearerConnectionUpdate = Effect.fn(
  "clientRuntime.connection.onboarding.prepareBearerConnectionUpdate",
)(function* (options: {
  readonly input: BearerConnectionUpdateInput;
  readonly entry: Option.Option<ConnectionCatalogEntry>;
  readonly credential: Option.Option<ConnectionCredential>;
}) {
  const entry = Option.getOrNull(options.entry);
  if (
    entry === undefined ||
    entry === null ||
    entry.target._tag !== "BearerConnectionTarget" ||
    Option.isNone(entry.profile) ||
    !isBearerProfile(entry.profile.value)
  ) {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail: "Only saved bearer environments can be edited.",
    });
  }

  const credential = options.credential;
  if (Option.isNone(credential) || !isBearerCredential(credential.value)) {
    return yield* new ConnectionBlockedError({
      reason: "authentication",
      detail: "The saved bearer credential is unavailable.",
    });
  }

  const label = options.input.label.trim();
  if (label === "") {
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail: "Environment label cannot be empty.",
    });
  }
  const httpBaseUrl = yield* Effect.try({
    try: () => normalizeHttpBaseUrl(options.input.httpBaseUrl),
    catch: (cause) =>
      new ConnectionBlockedError({
        reason: "configuration",
        detail: cause instanceof Error ? cause.message : "The environment URL is invalid.",
      }),
  });
  const connectionId = entry.target.connectionId;
  return new BearerConnectionRegistration({
    target: new BearerConnectionTarget({
      environmentId: options.input.environmentId,
      label,
      connectionId,
    }),
    profile: new BearerConnectionProfile({
      connectionId,
      environmentId: options.input.environmentId,
      label,
      httpBaseUrl,
      wsBaseUrl: deriveWsBaseUrl(httpBaseUrl),
    }),
    credential: credential.value,
  });
});

export const prepareSshRegistration = Effect.fn(
  "clientRuntime.connection.onboarding.prepareSshRegistration",
)(function* (input: SshConnectionInput) {
  const gateway = yield* ClientCapabilities.SshEnvironmentGateway;
  const provisioned = yield* gateway.provision(input.target, input.expectedEnvironmentId);
  const connectionId = `ssh:${provisioned.environmentId}:${sshTargetKey(provisioned.bootstrap.target)}`;
  const label = input.label?.trim() || provisioned.label || provisioned.bootstrap.target.alias;

  return new SshConnectionRegistration({
    target: new SshConnectionTarget({
      environmentId: provisioned.environmentId,
      label,
      connectionId,
    }),
    profile: new SshConnectionProfile({
      connectionId,
      environmentId: provisioned.environmentId,
      label,
      target: provisioned.bootstrap.target,
    }),
    credential: new BearerConnectionCredential({ token: provisioned.bearerToken }),
  });
});

const registerSshConnection = Effect.fn(
  "clientRuntime.connection.onboarding.registerSshConnection",
)(function* (input: SshConnectionInput) {
  const registration = yield* prepareSshRegistration(input);
  if (
    input.expectedEnvironmentId !== undefined &&
    registration.target.environmentId !== input.expectedEnvironmentId
  ) {
    return yield* differentMachineError(registration.target.label);
  }
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  yield* registry.register(registration);
  return registration.target.environmentId;
});

/** @public */
export const make = Effect.gen(function* () {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const httpClient = yield* HttpClient.HttpClient;
  const ssh = yield* ClientCapabilities.SshEnvironmentGateway;
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;

  // Provisioning retains the delegated onboarding operation spans.
  return ConnectionOnboarding.of({
    registerPairing: Effect.fnUntraced(
      function* (input) {
        return (yield* registerPairingConnection(input)).environmentId;
      },
      Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
      Effect.provideService(ClientCapabilities.ClientPresentation, presentation),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    ),
    commitPairing: Effect.fnUntraced(
      function* (input) {
        return yield* commitPairingConnection(input);
      },
      Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
      Effect.provideService(ClientCapabilities.ClientPresentation, presentation),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    ),
    registerSsh: Effect.fnUntraced(
      function* (input) {
        return yield* registerSshConnection(input);
      },
      Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
      Effect.provideService(ClientCapabilities.SshEnvironmentGateway, ssh),
    ),
    updateBearer: Effect.fnUntraced(
      function* (input) {
        return yield* updateBearerConnection(input);
      },
      Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registry),
      Effect.provideService(ConnectionCredentialStore.ConnectionCredentialStore, credentials),
    ),
  });
});

export const layer = Layer.effect(ConnectionOnboarding, make);
