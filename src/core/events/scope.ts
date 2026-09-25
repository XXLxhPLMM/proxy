import type { ProxyProtocol } from "@/core/types/proxy.js";
import type { EventContext } from "./types.js";

export interface EventScope {
  readonly runtimeId: string;
  readonly connectionId?: string;
  readonly requestId?: string;
  readonly protocol?: ProxyProtocol;
  readonly client?: string;
  readonly user?: string;
  readonly target?: string;
  /** 派生子作用域，继承父级 id，可覆写/补 protocol/client/user/target */
  child(patch: Partial<Omit<EventScope, "runtimeId">> & { request?: true }): EventScope;
  /** 转成 publish 的 context 部分（不含 runtimeId，由 hub 补） */
  toContext(): Omit<EventContext, "runtimeId">;
  withIdentity(patch: {
    user?: string;
    target?: string;
    client?: string;
    protocol?: ProxyProtocol;
  }): EventScope;
}

type ScopePatch = Partial<Omit<EventScope, "runtimeId">> & { request?: true };
type IdentityPatch = { user?: string; target?: string; client?: string; protocol?: ProxyProtocol };

interface ScopeValues {
  readonly runtimeId: string;
  readonly connectionId?: string;
  readonly requestId?: string;
  readonly protocol?: ProxyProtocol;
  readonly client?: string;
  readonly user?: string;
  readonly target?: string;
}

function hasPatchValue(patch: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(patch, key);
}

function contextOf(scope: EventScope): Omit<EventContext, "runtimeId"> {
  const context: Omit<EventContext, "runtimeId"> = {};
  if (scope.connectionId !== undefined) {
    context.connectionId = scope.connectionId;
  }
  if (scope.requestId !== undefined) {
    context.requestId = scope.requestId;
  }
  if (scope.protocol !== undefined) {
    context.protocol = scope.protocol;
  }
  if (scope.client !== undefined) {
    context.client = scope.client;
  }
  if (scope.user !== undefined) {
    context.user = scope.user;
  }
  if (scope.target !== undefined) {
    context.target = scope.target;
  }
  return context;
}

class Scope implements EventScope {
  public readonly runtimeId: string;
  public readonly connectionId?: string;
  public readonly requestId?: string;
  public readonly protocol?: ProxyProtocol;
  public readonly client?: string;
  public readonly user?: string;
  public readonly target?: string;

  constructor(values: ScopeValues) {
    this.runtimeId = values.runtimeId;
    this.connectionId = values.connectionId;
    this.requestId = values.requestId;
    this.protocol = values.protocol;
    this.client = values.client;
    this.user = values.user;
    this.target = values.target;
  }

  public child(patch: ScopePatch): EventScope {
    const connectionId = hasPatchValue(patch, "connectionId")
      ? patch.connectionId
      : this.connectionId;
    const requestId = hasPatchValue(patch, "requestId") ? patch.requestId : this.requestId;
    const protocol = hasPatchValue(patch, "protocol") ? patch.protocol : this.protocol;
    const client = hasPatchValue(patch, "client") ? patch.client : this.client;
    const user = hasPatchValue(patch, "user") ? patch.user : this.user;
    const target = hasPatchValue(patch, "target") ? patch.target : this.target;

    return new Scope({
      runtimeId: this.runtimeId,
      connectionId,
      requestId,
      protocol,
      client,
      user,
      target,
    });
  }

  public toContext(): Omit<EventContext, "runtimeId"> {
    return contextOf(this);
  }

  public withIdentity(patch: IdentityPatch): EventScope {
    return new Scope({
      runtimeId: this.runtimeId,
      connectionId: this.connectionId,
      requestId: this.requestId,
      protocol: hasPatchValue(patch, "protocol") ? patch.protocol : this.protocol,
      client: hasPatchValue(patch, "client") ? patch.client : this.client,
      user: hasPatchValue(patch, "user") ? patch.user : this.user,
      target: hasPatchValue(patch, "target") ? patch.target : this.target,
    });
  }
}

export function createRuntimeScope(runtimeId: string): EventScope {
  return new Scope({ runtimeId });
}

export function createConnectionScope(runtimeId: string, connectionId?: string): EventScope {
  return new Scope({ runtimeId, connectionId });
}

export function createRequestScope(
  runtimeId: string,
  requestId?: string,
  connectionId?: string,
): EventScope {
  return new Scope({ runtimeId, requestId, connectionId });
}
