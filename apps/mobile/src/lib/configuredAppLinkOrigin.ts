import Constants from "expo-constants";

const host: unknown = Constants.expoConfig?.extra?.appLinkHost;
export const configuredAppLinkOrigin =
  typeof host === "string" && host ? `https://${host}` : undefined;
