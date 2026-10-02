import { i18n } from "../i18n.ts";

export type ProviderOperation = "search" | "fetch";

function operationLabel(operation: ProviderOperation): string {
  return i18n.t(`provider.operation.${operation}`);
}

export function missingCredential(env: string, provider: string): Error {
  return new Error(i18n.t("provider.error.missingCredential", { env, provider }));
}

export function providerApiError(
  provider: string,
  operation: ProviderOperation,
  status: number,
  message: string,
  hint = "",
): Error {
  return new Error(i18n.t("provider.error.api", {
    provider,
    operation: operationLabel(operation),
    status,
    hint,
    message,
  }));
}

export function providerOperationError(provider: string, operation: ProviderOperation, message: string): Error {
  return new Error(i18n.t("provider.error.operation", {
    provider,
    operation: operationLabel(operation),
    message,
  }));
}

export function extractionFailed(provider: string, url: string, message: string): Error {
  return new Error(i18n.t("provider.error.extractionFailed", { provider, url, message }));
}

export function emptyFetch(provider: string, url: string): Error {
  return new Error(i18n.t("provider.error.emptyFetch", { provider, url }));
}

export function invalidBaseUrl(env: string, value: string): Error {
  return new Error(i18n.t("provider.error.invalidBaseUrl", { env, value }));
}

export function invalidBaseProtocol(env: string, protocol: string): Error {
  return new Error(i18n.t("provider.error.invalidBaseProtocol", { env, protocol }));
}

export function missingBaseUrl(env: string): Error {
  return new Error(i18n.t("provider.error.missingBaseUrl", { env }));
}

export function connectionRefused(provider: string, host: string): Error {
  return new Error(i18n.t("provider.error.connectionRefused", { provider, host }));
}
