export type ProviderOperation = "search" | "fetch";

function operationLabel(operation: ProviderOperation): string {
  return operation === "search" ? "Search" : "Fetch";
}

export function missingCredential(env: string, provider: string): Error {
  return new Error(`${env} is not configured. Run /config:web-search or export the environment variable.`);
}

export function providerApiError(
  provider: string,
  operation: ProviderOperation,
  status: number,
  message: string,
  hint = "",
): Error {
  return new Error(`${provider} ${operationLabel(operation)} API error (${status})${hint}: ${message}`);
}

export function providerOperationError(provider: string, operation: ProviderOperation, message: string): Error {
  return new Error(`${provider} ${operationLabel(operation)} API error: ${message}`);
}

export function extractionFailed(provider: string, url: string, message: string): Error {
  return new Error(`${provider} failed to extract ${url}: ${message}`);
}

export function emptyFetch(provider: string, url: string): Error {
  return new Error(`${provider} Fetch API returned no content for ${url}.`);
}

export function invalidBaseUrl(env: string, value: string): Error {
  return new Error(`${env} is not a valid URL: ${value}`);
}

export function invalidBaseProtocol(env: string, protocol: string): Error {
  return new Error(`${env} must use http:// or https://, not ${protocol}://.`);
}

export function missingBaseUrl(env: string): Error {
  return new Error(`${env} is not configured. Run /config:web-search or export the environment variable.`);
}

export function connectionRefused(provider: string, host: string): Error {
  return new Error(`Could not connect to ${provider} at ${host}. Make sure the service is running.`);
}
