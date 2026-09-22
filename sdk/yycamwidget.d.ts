export type JSONPrimitive = string | number | boolean | null;
export type JSONValue =
  | JSONPrimitive
  | JSONValue[]
  | { [key: string]: JSONValue };

export type WidgetRole = "main" | "config";
export type CaptureMode = "automatic" | "captureAnimation" | "alwaysCapture";

export type WidgetAPIErrorCode =
  | "UNSUPPORTED_API_VERSION"
  | "METHOD_NOT_ALLOWED"
  | "INVALID_ARGUMENT"
  | "ORIGIN_NOT_ALLOWED"
  | "CONFIG_PAGE_UNAVAILABLE"
  | "ALREADY_IN_PROGRESS"
  | "NAVIGATION_FAILED"
  | "RUNTIME_METHOD_UNAVAILABLE"
  | "RUNTIME_INVALID_RESULT"
  | "DUPLICATE_RUNTIME_HANDLER"
  | "TIMEOUT"
  | "CANCELLED"
  | "INTERNAL_ERROR";

export interface WidgetAPIErrorPayload {
  code: WidgetAPIErrorCode;
  message: string;
  retryable: boolean;
}

export class WidgetAPIError extends Error {
  readonly name: "WidgetAPIError";
  readonly code: WidgetAPIErrorCode;
  readonly retryable: boolean;
  readonly requestId?: string;

  constructor(
    payload: WidgetAPIErrorPayload,
    requestId?: string
  );
}

export interface WidgetContext {
  apiVersion: 1;
  role: WidgetRole;
  widget: {
    id: string;
    revision: string;
    subscriptionId: string;
  };
  page: {
    url: string;
    origin: string;
    configKey?: string;
  };
  environment: {
    locale: string;
    colorScheme: "light" | "dark";
  };
  capabilities: {
    host: string[];
    runtime: string[];
  };
}

export interface OpenConfigOptions {
  configKey?: string;
  reason?: string;
}

export interface OpenConfigResult {
  configKey: string;
  status: "presented" | "queued" | "alreadyPresented";
}

export interface CaptureModeOptions {
  mode: CaptureMode;
}

export interface CompleteConfigOptions {
  reason?: string;
}

export type SubscriptionRefresh =
  | "updated"
  | "notModified"
  | "failedUsingCurrentSnapshot";

export type CompleteConfigResult =
  | {
      state: "ready";
      currentConfigKey: string;
      verification: "passed" | "notSupported";
      subscriptionRefresh: SubscriptionRefresh;
      reason?: string;
    }
  | {
      state: "needsConfiguration";
      currentConfigKey: string;
      verification: "passed";
      subscriptionRefresh: SubscriptionRefresh;
      requiredConfig: {
        configKey: string;
        available: boolean;
      };
      reason?: string;
    };

export interface CloseConfigOptions {
  reason?: string;
}

export interface WidgetHostAPI {
  getContext(): Promise<WidgetContext>;
  openConfig(options?: OpenConfigOptions): Promise<OpenConfigResult>;
  setCaptureMode(options: CaptureModeOptions): Promise<void>;
  completeConfig(
    options?: CompleteConfigOptions
  ): Promise<CompleteConfigResult>;
  closeConfig(options?: CloseConfigOptions): Promise<void>;
}

export type RuntimeHandler = (
  params: JSONValue
) => JSONValue | Promise<JSONValue>;

export interface WidgetRuntimeRegistry {
  register(method: string, handler: RuntimeHandler): () => void;
  has(method: string): boolean;
}

export type WidgetEventName =
  | "nativeReady"
  | "visibilityChanged"
  | "lifecycleChanged"
  | "captureModeChanged"
  | "configurationChanged"
  | "configurationPresentationChanged";

export interface WidgetEventPayloadMap {
  nativeReady: WidgetContext;
  visibilityChanged: { visible: boolean };
  lifecycleChanged: { state: "foreground" | "background" };
  captureModeChanged: { mode: CaptureMode };
  configurationChanged: {
    reason?: string;
    revision: string;
    sourceConfigKey?: string;
  };
  configurationPresentationChanged: {
    configKey: string;
    status: "presented" | "failed" | "cancelled";
    errorCode?: WidgetAPIErrorCode;
  };
}

export interface WidgetEventEnvelope<Name extends string = string> {
  apiVersion: 1;
  sequence: number;
  name: Name;
  timestamp: string;
  payload: unknown;
}

export interface WidgetEventBus {
  on<Name extends WidgetEventName>(
    name: Name,
    handler: (payload: WidgetEventPayloadMap[Name]) => void
  ): () => void;
  on(
    name: string,
    handler: (payload: unknown) => void
  ): () => void;
}

export interface RuntimeRequest {
  apiVersion: 1;
  requestId: string;
  method: string;
  params: JSONValue;
}

export type RuntimeResponse =
  | { requestId: string; ok: true; data: JSONValue }
  | { requestId: string; ok: false; error: WidgetAPIErrorPayload };

/** Private Native-to-JavaScript runtime entry point. */
export interface YYCamWidgetNativeRuntime {
  invoke(request: RuntimeRequest): Promise<RuntimeResponse>;
  listMethods(): string[];
  /** @internal Native delivers a HostResponse through the private SDK entry. */
  __deliver(response: HostResponse): void;
  /** @internal Native delivers an Event envelope through the private SDK entry. */
  __deliverEvent(event: WidgetEventEnvelope): void;
  /** @internal Native invokes a Main Runtime through the private SDK entry. */
  __receiveRuntimeRequest(request: RuntimeRequest): Promise<RuntimeResponse>;
  /** @internal Native cancels current-generation requests. */
  __cancel(): void;
}

export interface YYCamWidgetAPI {
  readonly apiVersion: 1;
  readonly role: WidgetRole;
  readonly ready: Promise<WidgetContext>;
  readonly host: WidgetHostAPI;
  readonly runtime: WidgetRuntimeRegistry;
  readonly events: WidgetEventBus;
  /** @internal */
  readonly __native: YYCamWidgetNativeRuntime;
}

declare global {
  interface Window {
    YYCamWidget: YYCamWidgetAPI;
    /** @internal Native invokes this private response callback. */
    __YYCamWidgetReceiveResponse?: (
      response: HostResponse
    ) => void;
    /** @internal Native invokes this private event callback. */
    __YYCamWidgetReceiveEvent?: (
      event: WidgetEventEnvelope
    ) => void;
  }
}

export interface HostRequest {
  apiVersion: 1;
  requestId: string;
  action: string;
  params: JSONValue;
}

export type HostResponse =
  | { requestId: string; ok: true; data: JSONValue }
  | { requestId: string; ok: false; error: WidgetAPIErrorPayload };

export {};
