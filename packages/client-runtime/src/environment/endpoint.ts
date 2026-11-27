import { joinBaseUrlPath } from "@t3tools/shared/advertisedEndpoint";

export * from "@t3tools/shared/advertisedEndpoint";

export const environmentEndpointUrl = (httpBaseUrl: string, pathname: string): string =>
  joinBaseUrlPath(httpBaseUrl, pathname);
