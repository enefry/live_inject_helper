/**
 * YYCam Web Widget Manifest v1.
 *
 * The JSON Schema is authoritative for URL, key, count, and length
 * constraints that TypeScript cannot express. Unknown JSON members are
 * intentionally allowed and ignored by the Native decoder.
 */
export interface WidgetManifestV1 {
  schemaVersion: 1;
  apiVersion: 1;
  id: string;
  revision: string;
  name: string;
  description?: string;
  icon?: WidgetIconResource;
  main: WidgetMainPageDefinition;
  configs?: Record<WidgetConfigKey, WidgetConfigPageDefinition>;
}

export type WidgetConfigKey = string;

export interface WidgetIconResource {
  url: string;
  integrity?: WidgetIntegrity;
}

export interface WidgetBasePageDefinition {
  url: string;
  userAgent?: string;
  contentMode?: WidgetWebContentMode;
  allowedOrigins?: string[];
  inject?: WidgetInjectionDefinition;
}

export interface WidgetMainPageDefinition extends WidgetBasePageDefinition {
  runtime?: WidgetRuntimeDeclaration;
}

export interface WidgetConfigPageDefinition extends WidgetBasePageDefinition {
  title: string;
  description?: string;
  /** Ignored by Native for forward compatibility. */
  runtime?: unknown;
}

export interface WidgetInjectionDefinition {
  js?: WidgetResourceDefinition[];
  css?: WidgetResourceDefinition[];
}

export interface WidgetResourceDefinition {
  id: string;
  url: string;
  integrity: WidgetIntegrity;
  injectionTime?: WidgetInjectionTime;
}

export type WidgetInjectionTime = "documentStart" | "documentEnd";
export type WidgetWebContentMode = "desktop" | "mobile";
export type WidgetIntegrity = `sha256-${string}`;

export interface WidgetRuntimeDeclaration {
  methods?: string[];
}
