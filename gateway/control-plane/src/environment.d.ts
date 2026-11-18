interface Env {
  BETTER_AUTH_URL?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_API_TOKEN_SECONDARY?: string;
  LOCAL_GATEWAY_DISCONNECT?: Fetcher;
}

declare namespace Cloudflare {
  interface Env {
    BETTER_AUTH_URL?: string;
    CLOUDFLARE_API_TOKEN?: string;
    CLOUDFLARE_API_TOKEN_SECONDARY?: string;
    LOCAL_GATEWAY_DISCONNECT?: Fetcher;
  }
}
